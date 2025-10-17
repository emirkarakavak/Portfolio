// cronTasks/foxepin.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

// "31,976.99 TL" / "₺397.49" / "397.49" -> 31976.99 / 397.49
function priceTextToNumber(txt) {
  if (!txt) return null;
  let s = String(txt).replace(/[^\d.,]/g, "");
  // binlik virgülleri at, ondalık nokta kalsın (Foxepin formatı)
  if (/,/.test(s) && /\.\d{2}$/.test(s)) s = s.replace(/,/g, "");
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

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
    // ufak stealth
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(90000);

  try {
    for (const { url, categoryName } of tasks) {
      if (!/^https?:\/\//i.test(url)) { console.error("Geçersiz URL:", url); continue; }

      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .catch(() => page.goto(url, { waitUntil: "load", timeout: 90000 }));

      // Lazy varsa bir miktar scroll et
      for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 1200)); await sleep(150); }

      // Senin verdiğin yapıya göre: her ürün bir `.table-container`
      await page.waitForSelector(".table-container", { timeout: 30000 }).catch(() => {});
      const items = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

        const CARD_SEL = ".table-container";
        // nth-child yerine nth-of-type
        const NAME_REL  = "div:nth-of-type(2) > a:nth-of-type(1) > p:nth-of-type(1)";
        const PRICE_REL = "div:nth-of-type(5) > p:nth-of-type(2)";

        // Fiyatı öncelik sırasıyla *tek* kez seç (alt-match'leri ele)
        // 1) 31,976.99   2) 397.49   3) 1.234,56   4) 49,99
        const pricePatterns = [
          /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g,   // 31,976.99
          /\b\d+\.\d{2}\b/g,                  // 397.49
          /\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g,   // 1.234,56
          /\b\d+,\d{2}\b/g                    // 49,99
        ];
        const pickPriceByPriority = (txt) => {
          for (const re of pricePatterns) {
            const matches = txt.match(re);
            if (matches && matches.length) {
              // aynı pattern içinden en "tam" olanı seçmek için en uzununu al
              matches.sort((a, b) => b.length - a.length);
              return matches[0];
            }
          }
          return "";
        };

        const cards = Array.from(document.querySelectorAll(CARD_SEL));
        const out = [];

        for (const card of cards) {
          // 1) Önce verilen relative selectorlarla dene
          let nameEl  = card.querySelector(NAME_REL);
          let priceEl = card.querySelector(PRICE_REL);

          let title = nameEl ? norm(nameEl.textContent || "") : "";
          let priceText = priceEl ? norm(priceEl.textContent || "") : "";

          // 2) Fallback: title boşsa kart içindeki makul ilk satırı al
          if (!title) {
            // genelde isim, link içindeki ilk <p> veya <a>’daki kalın metin
            const titleCand = card.querySelector("a p, a, .product-title, .font-bold");
            if (titleCand) title = norm(titleCand.textContent || "");
          }

          // 3) Fallback: priceText boşsa kartın TÜM metnini tara, öncelikli eşleşme seç
          if (!priceText) {
            const allText = norm(card.innerText || card.textContent || "");
            const best = pickPriceByPriority(allText);
            if (best) priceText = best;
          }

          if (title && priceText) out.push({ title, priceText });
        }

        return out;
      });

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı (selectorlar ile): ${url}`);
        continue;
      }

      for (const it of items) {
        // Ör: "397.49 TL" / "₺397.49"
        const sellPriceValue = priceTextToNumber(it.priceText);
        // Kaynak metin formatını koru; sadece para sembolü vs. temizle
        const sellPriceStr = it.priceText.replace(/[^\d.,]/g, "") || String(sellPriceValue ?? "");

        try {
          await upsertAndArchive(
            {
              siteName: "foxepin",
              categoryName,
              itemName: norm(it.title),
              sellPrice: sellPriceStr,          // "397.49" / "1,389.99" / "49,99" (kaynak format)
              sellPriceValue: sellPriceValue,   // 397.49
              currency: "₺",
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.priceText} (${sellPriceValue ?? "NaN"} ₺)`);
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }

      await sleep(200);
    }
  } catch (err) {
    console.error("FoxEpin scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
