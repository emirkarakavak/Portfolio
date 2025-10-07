// cronTasks/gamesatis.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

/**
 * GameSatış (MLBB / PUBG vs. — TR & Global)
 * tasks: [{ url: string, categoryName: string }, ...]
 */
exports.run = async (tasks = []) => {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("tasks boş. [{ url, categoryName }] ver.");
  }

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

  // helpers
  async function autoScroll(p) {
    await p.evaluate(
      () =>
        new Promise((resolve) => {
          let total = 0;
          const distance = 800;
          const timer = setInterval(() => {
            const { scrollHeight } = document.documentElement;
            window.scrollBy(0, distance);
            total += distance;
            if (total >= scrollHeight - window.innerHeight - 200) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        })
    );
  }
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // sadece numerik string döndür; para birimi ayrı
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
      .replace(/\.(?=\d{3}(\D|$))/g, "") // binlik nokta
      .replace(",", ".")
      .trim();

    const value = parseFloat(numericStr);
    return {
      raw: numericStr,                          // "149.90"
      value: Number.isFinite(value) ? value : null,
      currency,
    };
  };

  const CARD_SEL = "section.container div.grid-6 a.product";
  const NAME_SEL = "h3";
  const PRICE_SEL = "div.selling-price";

  try {
    for (const { url, categoryName } of tasks) {
      if (!url || !categoryName) {
        console.warn("Task eksik, atlanıyor:", { url, categoryName });
        continue;
      }

      console.log(`Scraping: ${url} -> ${categoryName}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await autoScroll(page);

      // kartlar geldi mi?
      await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length > 0,
        { timeout: 90000 },
        CARD_SEL
      );

      const items = await page.evaluate(
        ({ CARD_SEL, NAME_SEL, PRICE_SEL }) => {
          const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

          const parsePriceClient = (txt) => {
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
              raw: numericStr,
              value: Number.isFinite(value) ? value : null,
              currency,
            };
          };

          const out = [];
          const cards = Array.from(document.querySelectorAll(CARD_SEL));
          for (const card of cards) {
            const nameEl = card.querySelector(NAME_SEL);
            const priceEl = card.querySelector(PRICE_SEL);
            const title = clean(nameEl?.textContent || "");
            const price = parsePriceClient(priceEl?.textContent || "");
            if (!title || !price.raw) continue;

            out.push({
              title,
              priceText: price.raw,       // sadece numerik string
              priceValue: price.value,    // number
              currency: price.currency || "₺",
            });
          }
          return out;
        },
        { CARD_SEL, NAME_SEL, PRICE_SEL }
      );

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        continue;
      }

      // KAYDET — upsert + arşiv
      for (const it of items) {
        const sellPriceStr =
          it.priceText?.trim() ||
          (Number.isFinite(it.priceValue) ? String(it.priceValue) : "");
        if (!sellPriceStr) {
          console.warn(`Fiyat boş, atlanıyor: [${categoryName}] ${it.title}`);
          continue;
        }

        // numerik value (sayı)
        const sellPriceValue = Number.isFinite(it.priceValue)
          ? it.priceValue
          : (() => {
              const n = parseFloat(String(sellPriceStr).replace(",", "."));
              return Number.isFinite(n) ? n : null;
            })();

        try {
          await upsertAndArchive(
            {
              siteName: "gamesatis",
              categoryName,
              itemName: it.title,
              sellPrice: sellPriceStr,     // "149.90"
              sellPriceValue,
              currency: it.currency,
              url,
            },
            { archiveMode: "always" }
          );
          console.log(
            `Upsert: [${categoryName}] ${it.title} -> ${sellPriceStr} (${sellPriceValue ?? "NaN"} ${it.currency})`
          );
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error("GameSatış scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
