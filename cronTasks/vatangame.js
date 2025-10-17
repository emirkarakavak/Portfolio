// cronTasks/vatangame.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

/**
 * Giriş desteği:
 *  - run("https://...", "kategori")
 *  - run(["https://...", ...], "kategori")
 *  - run([{ url, categoryName }, ...])
 */
exports.run = async (input, categoryName) => {
  // ---- 1) GİRİŞ NORMALİZASYONU ----
  let tasks = [];
  const isObjArray = Array.isArray(input) && input.every(v => typeof v === "object" && v);
  const isStrArray = Array.isArray(input) && input.every(v => typeof v === "string");
  const isStr = typeof input === "string";

  if (isObjArray) {
    tasks = input.map((t, i) => {
      if (!t?.url || !t?.categoryName) throw new Error(`Task[${i}] eksik: url & categoryName zorunlu`);
      return { url: String(t.url).trim(), categoryName: String(t.categoryName).trim() };
    });
  } else if (isStrArray) {
    if (!categoryName) throw new Error("categoryName eksik (string[] girişi için gerekli).");
    tasks = input.map(u => ({ url: String(u).trim(), categoryName: String(categoryName).trim() }));
  } else if (isStr) {
    if (!categoryName) throw new Error("categoryName eksik (string girişi için gerekli).");
    tasks = [{ url: String(input).trim(), categoryName: String(categoryName).trim() }];
  } else {
    throw new Error("Geçersiz parametre. String, string[] veya {url, categoryName}[] beklenir.");
  }

  // ---- 2) SCRAPE ----
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const page = await browser.newPage();
  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(90000);

  try {
    for (const { url, categoryName } of tasks) {
      if (typeof url !== "string" || !url.startsWith("http")) {
        console.error("Geçersiz URL:", url);
        continue;
      }

      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 })
        .catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }));

      await page.waitForSelector("main#main .container-vg .card .card-body", { timeout: 90000 });

      const items = await page.evaluate(() => {
        const SELECTORS = {
          rowsAll: "main#main .container-vg .card .card-body div.row",
          name: ".inline-block.flex-column.justify-content-center.form-label-black.col-md-3.col-12 p.font-bold.form-label-black",
          price: ".d-flex.flex-column.justify-content-center.align-items-center.my-2.my-md-0.col-md-1.col-12 .text-center p.font-bold.form-label-black",
        };

        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const parsePrice = (txt) => {
          if (!txt) return { raw: "", value: null, currency: null };
          const raw = clean(txt);
          const curMatch = raw.match(/₺|TL|TRY|\$|€|£/i);
          let currency = curMatch ? curMatch[0].toUpperCase() : "₺";
          if (currency === "TL" || currency === "TRY") currency = "₺";

          const numericStr = raw
            .replace(/(TL|TRY)/gi, "")
            .replace(/[₺$€£]/g, "")
            .replace(/[^\d,.\-]/g, "")
            .replace(/\.(?=\d{3}(\D|$))/g, "")
            .replace(",", ".")
            .trim();

          const value = parseFloat(numericStr);
          return {
            raw: numericStr, // "149.90"
            value: Number.isFinite(value) ? value : null,
            currency,
          };
        };

        const out = [];
        const rows = Array.from(document.querySelectorAll(SELECTORS.rowsAll));
        for (const row of rows) {
          const nameEl = row.querySelector(SELECTORS.name);
          const priceEl = row.querySelector(SELECTORS.price);
          if (!nameEl || !priceEl) continue;

          const title = clean(nameEl.textContent || "");
          const price = parsePrice(priceEl.textContent || "");
          if (!title || !price.raw) continue;

          out.push({
            title,
            priceText: price.raw,    // sadece numerik string
            priceValue: price.value, // number
            currency: price.currency || "₺",
          });
        }
        return out;
      });

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        continue;
      }

      for (const it of items) {
        const sellPriceStr =
          (it.priceText || "").trim() ||
          (Number.isFinite(it.priceValue) ? String(it.priceValue) : "");
        if (!sellPriceStr) {
          console.warn(`Fiyat boş, atlanıyor: [${categoryName}] ${it.title}`);
          continue;
        }

        const sellPriceValue = Number.isFinite(it.priceValue)
          ? it.priceValue
          : (() => {
              const n = parseFloat(String(sellPriceStr).replace(",", "."));
              return Number.isFinite(n) ? n : null;
            })();

        try {
          await upsertAndArchive(
            {
              siteName: "vatangame",
              categoryName,
              itemName: it.title.replace(" ( Lütfen Ürün karşılığını okuyunuz. )"," "),
              sellPrice: sellPriceStr,     // "149.90"
              sellPriceValue,
              currency: it.currency,
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${sellPriceStr} (${sellPriceValue ?? "NaN"} ${it.currency})`);
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error("VatanGame scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
