// cronTasks/hesapcomtr.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

exports.run = async (
  url = "https://hesap.com.tr/urunler/mlbb-elmas-satin-al",
  opts = {}
) => {
  const categoryMap = {
    tr: "hesap-mlbb-tr",
    global: "hesap-mlbb-global",
    ...(opts.categoryMap || {}),
  };

  const decideCategory =
    typeof opts.decideCategory === "function"
      ? opts.decideCategory
      : (title) => {
          const t = (title || "").toLowerCase();
          if (/(global|world|int(erna(tio)?)?)/i.test(t)) return "global";
          if (/(t.r|türkiye|turkiye|tr sunucu|tr server)/i.test(t)) return "tr";
          return "tr";
        };

  const browser = await puppeteer.launch({
    headless: true,                       // puppeteer@>=20 ise "new" da olur
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(90000);

  // Sürpriz dialog’ları öldür
  page.on("dialog", d => d.dismiss().catch(() => {}));
  page.on("pageerror", err => console.warn("PageError:", err?.message || err));
  page.on("error", err => console.warn("TargetCrashed/Error:", err?.message || err));

  // Kısa adımlı, güvenli scroll
  async function safeAutoScroll(p, { step = 800, delay = 200, max = 60_000 } = {}) {
    const start = Date.now();
    let last = 0;
    while (Date.now() - start < max) {
      try {
        const { done, scrolled } = await p.evaluate((s) => {
          const before = window.scrollY;
          window.scrollBy(0, s);
          const { scrollHeight, clientHeight } = document.documentElement;
          const atBottom = window.scrollY + clientHeight >= scrollHeight - 200;
          return { done: atBottom, scrolled: window.scrollY - before };
        }, step);
        if (done || scrolled <= 0) break;
        await p.waitForTimeout(delay);
        last = Date.now();
      } catch (e) {
        // Context bozulduysa bir daha dene (mini backoff)
        if (!/Execution context was destroyed|Cannot find context/.test(String(e))) throw e;
        await p.waitForTimeout(500);
      }
    }
  }

  // evaluate çağrılarını tek sefer retry ile sarmak için yardımcı
  async function evalWithRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (/Execution context was destroyed|Cannot find context/.test(String(e))) {
        await page.waitForTimeout(500);
        return await fn();
      }
      throw e;
    }
  }

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });

    // KVKK/çerez (best-effort) – önce butonlar gelmiş mi bak
    try {
      // Önce DOM tarafında bekle
      await page.waitForSelector("button, .btn", { timeout: 5000 });
      // Sonra Puppeteer click dene; metin eşleşmesini handle içinde yap
      const buttons = await page.$$("button, .btn");
      for (const b of buttons) {
        const txt = (await page.evaluate(el => (el.innerText || "").toLowerCase(), b)) || "";
        if (/(kabul|accept|onay|tamam)/.test(txt)) {
          await b.click({ delay: 10 });
          // SPA ise küçük bir network idle bekle ki context otursun
          try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }); } catch {}
          break;
        }
      }
    } catch {}

    await safeAutoScroll(page);

    const CARD_SEL = "section.product-listing-products ul.products li.col-12.prd div.item";

    // waitForFunction yerine waitForSelector daha stabil
    await page.waitForSelector(CARD_SEL, { timeout: 90000 });

    const items = await evalWithRetry(async () => {
      return await page.evaluate(() => {
        const CARD_SEL = "section.product-listing-products ul.products li.col-12.prd div.item";
        const NAME_SEL = "div.row.g-3 .col-md-7 .l.position-relative a.d-flex span.product-name";
        const PRICE_SEL = "div.row.g-3 .col-md-5 .price-lg .new, div.row.g-3 .col-md-5 .price-lg span.new";

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
          return { raw: numericStr, value: Number.isFinite(value) ? value : null, currency };
        };

        const out = [];
        const cards = Array.from(document.querySelectorAll(CARD_SEL));
        for (const card of cards) {
          const nameEl = card.querySelector(NAME_SEL);
          let priceEl = card.querySelector(PRICE_SEL)
            || card.querySelector("div.row.g-3 .col-md-5 .price-sm .new, div.row.g-3 .col-md-5 .price .new")
            || card.querySelector("div.row.g-3 .col-md-5 [class*='price'] .new");

          const title = clean(nameEl?.textContent || "");
          const price = parsePrice(priceEl?.textContent || "");
          if (!title || !price.raw) continue;

          out.push({
            title,
            priceText: price.raw,
            priceValue: price.value,
            currency: price.currency || "₺",
          });
        }
        return out;
      });
    });

    if (!items || items.length === 0) {
      console.warn("Hiç ürün bulunamadı. Layout/selector değişmiş olabilir.");
      await browser.close();
      return;
    }

    for (const item of items) {
      const group = decideCategory(item.title);
      const categoryName = categoryMap[group] || categoryMap.tr;

      const sellPriceStr =
        item.priceText?.trim() ||
        (Number.isFinite(item.priceValue) ? String(item.priceValue) : "");
      if (!sellPriceStr) continue;

      const sellPriceValue = Number.isFinite(item.priceValue)
        ? item.priceValue
        : (() => {
            const n = parseFloat(String(sellPriceStr).replace(",", "."));
            return Number.isFinite(n) ? n : null;
          })();

      try {
        await upsertAndArchive(
          {
            siteName: "hesapcomtr",
            categoryName,
            itemName: item.title,
            sellPrice: sellPriceStr,
            sellPriceValue,
            currency: item.currency,
            url,
          },
          { archiveMode: "always" }
        );
        console.log(
          `Upsert: [${categoryName}] ${item.title} -> ${sellPriceStr} (${sellPriceValue ?? "NaN"} ${item.currency})`
        );
      } catch (err) {
        console.error(`Kaydetme hatası: [${categoryName}] ${item.title} ->`, err?.message || err);
      }
    }
  } catch (err) {
    console.error("Hesap.com.tr scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
