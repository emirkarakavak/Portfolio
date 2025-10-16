// cronTasks/perdigital.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

/**
 * tasks: [{ url: string, categoryName: string }, ...]
 *  - TR:     https://www.perdigital.com/mobile-legends-elmas
 *  - Global: https://www.perdigital.com/mobile-legends-elmas-global
 *  - PUBG:   https://www.perdigital.com/online-oyun/tencent-games/pubg-mobile-uc
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

  // gerçekçi UA
  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  const autoScroll = async (p) => {
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
  };

  try {
    for (const { url, categoryName } of tasks) {
      if (!url || !categoryName) {
        console.warn("Task eksik, atlanıyor:", { url, categoryName });
        continue;
      }

      console.log(`Scraping: ${url} -> ${categoryName}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

      // Ürünler sekmesini (varsa) aktif et
      await page.evaluate(() => {
        const trigger = document.querySelector('a[href="#urunler"], [data-toggle="tab"][href="#urunler"]');
        if (trigger) trigger.click();
      });

      await autoScroll(page);

      // #urunler metninde para birimi görünene kadar bekle
      await page.waitForFunction(() => {
        const c = document.querySelector("#urunler") || document.querySelector("#urunler.tab-pane");
        if (!c) return false;
        const t = (c.innerText || c.textContent || "").toUpperCase();
        return t.includes(" TL") || t.includes("₺");
      }, { timeout: 120000 });

      const items = await page.evaluate(() => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

        const container =
          document.querySelector("#urunler") ||
          document.querySelector("#urunler.tab-pane");
        if (!container) return [];

        const text = clean(container.innerText || container.textContent || "");
        if (!text) return [];

        // Fiyat yakalayıcı: para birimi ZORUNLU, ondalık TAM
        const priceRe = /(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:\.\d{2}))\s*(TL|TRY|₺)/gi;

        const matches = [];
        let m;
        while ((m = priceRe.exec(text)) !== null) {
          matches.push({ start: m.index, end: priceRe.lastIndex, price: m[1], cur: m[2] });
        }
        if (matches.length === 0) return [];

        const results = [];
        const seen = new Set();
        let prevEnd = 0;

        for (const match of matches) {
          // isim bloğu = önceki fiyat bitişi → bu fiyat başlangıcı
          let name = text.slice(prevEnd, match.start).trim();

          // isim temizliği
          name = name
            .replace(/^[+]+/, "")
            .replace(/\s*(₺|TL|TRY|\$|€|£)\s*$/i, "")
            .replace(/\s*\d[\d .]*(?:[.,]\d{2})?\s*(₺|TL|TRY|\$|€|£)?$/i, "")
            .replace(/\s{2,}/g, " ")
            .replace("Ürün Fiyatı Seç ,","")
            .replace(" ( Lütfen Ürün karşılığını okuyunuz. )","")
            .trim();
          // sondaki "1," / "3," gibi kısa numara kırıntısı varsa at
          name = name.replace(/\s*\b\d{1,2},?$/, "");

          if (!name || name.length < 2) { prevEnd = match.end; continue; }

          // fiyat → numerik string
          const numericStr = match.price
            .replace(/[^\d,.\-]/g, "")
            .replace(/\.(?=\d{3}(\D|$))/g, "")
            .replace(",", ".")
            .trim();
          if (!numericStr) { prevEnd = match.end; continue; }

          const value = parseFloat(numericStr);
          const currency = /^(TL|TRY)$/i.test(match.cur) ? "₺" : match.cur;

          const key = name + "|" + numericStr;
          if (seen.has(key)) { prevEnd = match.end; continue; }
          seen.add(key);

          results.push({
            title: name,
            priceText: numericStr,                           // "149.90"
            priceValue: Number.isFinite(value) ? value : null,
            currency,
          });

          prevEnd = match.end;
        }

        return results;
      });

      if (!items || items.length === 0) {
        console.warn(`Perdigital: ürün bulunamadı/eşleşmedi -> ${url}`);
        continue;
      }

      // UPSERT + ARCHIVE
      for (const it of items) {
        const sellPriceStr =
          it.priceText?.trim() ||
          (Number.isFinite(it.priceValue) ? String(it.priceValue) : "");
        if (!sellPriceStr) {
          console.warn(`Fiyat boş, atlandı: [${categoryName}] ${it.title}`);
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
              siteName: "perdigital",
              categoryName,
              itemName: it.title,
              sellPrice: sellPriceStr,     // "149.90"
              sellPriceValue,
              currency: it.currency,       // "₺"
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
    console.error("Perdigital scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
