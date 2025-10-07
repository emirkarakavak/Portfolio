// cronTasks/bng.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

exports.run = async (url, categoryName) => {
  if (!url || !categoryName) throw new Error("url ve categoryName zorunlu.");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  // UA & headers
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

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    await page.waitForSelector("[ins-product-price]", { timeout: 90000 });

    const items = await page.$$eval("[ins-product-price]", (products) =>
      products.map((p) => {
        const container = p.closest("[class*='item-']");
        const title =
          container?.querySelector("h2 a, h2, h3, .product-name")?.textContent
            .replace(/\s+/g, " ")
            .trim() || "Ürün adı bulunamadı";

        const price = p.getAttribute("ins-product-price");
        const sale = p.getAttribute("ins-product-sale-price");
        const final = sale && price !== sale ? sale : price;

        return { title, price: (final || "").trim() };
      })
    );

    for (const it of items) {
      if (!it.title || !it.price) continue;

      // numerik value (varsa)
      const sellPriceValue = (() => {
        const n = parseFloat(String(it.price).replace(",", "."));
        return Number.isFinite(n) ? n : null;
      })();

      await upsertAndArchive(
        {
          siteName: "bynogame",
          categoryName,
          itemName: it.title,
          sellPrice: it.price,         // ByNoGame attr → zaten numerik string
          sellPriceValue,
          currency: "₺",
          url,
        },
        { archiveMode: "always" } //"price-change"
      );

      console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.price}`);
    }
  } catch (err) {
    console.error("Bynogame scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
