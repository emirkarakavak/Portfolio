// cronTasks/kabasakalonline.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

/**
 * tasks: [{ url: string, categoryName: string }, ...]
 * Ör:
 *  [{ url: 'https://kabasakalonline.com/urunler/108/pubg-mobile-uc-tr', categoryName: 'PUBG UC TR' }]
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

  // Gerçekçi UA ve temel sertleştirme
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

  const cleanMoneyToNumber = (txt) => {
    if (!txt) return null;
    // Binlik ayırıcı noktaları sil, virgülü ondalığa çevir
    const s = String(txt)
      .replace(/[^\d.,-]/g, "")
      .replace(/\.(?=\d{3}(\D|$))/g, "") // binlik noktaları
      .replace(",", ".");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  try {
    for (const { url, categoryName } of tasks) {
      if (!url || !categoryName) {
        console.warn("Task eksik, atlanıyor:", { url, categoryName });
        continue;
      }

      console.log(`Scraping: ${url} -> ${categoryName}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

      // Basit koruma sayfası tespiti (aşmaya çalışmıyoruz)
      const challenged = await page.evaluate(() => {
        const t = document.title.toLowerCase();
        return (
          t.includes("checking your browser") ||
          t.includes("just a moment") ||
          !!document.querySelector('iframe[src*="challenge"], #challenge-form, .hcaptcha-box, .cf-challenge')
        );
      });
      if (challenged) {
        console.warn("Koruma sayfası / doğrulama tespit edildi, atlandı:", url);
        continue;
      }

      // İçerik hazır olana kadar bekle
      await page.waitForSelector("div#__next main", { timeout: 60000 }).catch(() => {});
      await page.waitForFunction(
        () =>
          document.querySelectorAll('div#__next h6.text-lg.line-clamp-1').length > 0 &&
          document.querySelectorAll('div#__next span.text-green-500.text-sm.font-bold').length > 0,
        { timeout: 60000 }
      ).catch(() => {});

      // DOM'dan başlık + fiyatı çekip eşleştir
      const items = await page.evaluate(() => {
        const titles = Array.from(
          document.querySelectorAll('div#__next h6.text-lg.line-clamp-1')
        ).map((n) => (n.textContent || "").trim()).filter(Boolean);

        const pricesRaw = Array.from(
          document.querySelectorAll('div#__next span.text-green-500.text-sm.font-bold')
        ).map((n) => (n.textContent || "").trim()).filter(Boolean);

        const results = [];
        const count = Math.min(titles.length, pricesRaw.length);

        for (let i = 0; i < count; i++) {
          const title = titles[i];
          // Para birimi sembollerini kaldırılmış metin (örn: "189,99")
          const priceText = (pricesRaw[i] || "").replace(/[^\d.,-]/g, "").trim();
          // Orijinal metinden para birimi tespiti
          const curMatch = (pricesRaw[i] || "").toUpperCase().match(/(₺|TL|TRY|USD|\$|EUR|€)/);
          const currency = curMatch ? curMatch[1] : "₺";
          results.push({ title, priceText, currency });
        }
        return results;
      });

      if (!items || items.length === 0) {
        console.warn(`Kabasakal: ürün bulunamadı -> ${url}`);
        continue;
      }

      // DB: UPSERT + ARCHIVE
      for (const it of items) {
        const sellPriceStr = it.priceText?.trim();
        if (!sellPriceStr) {
          console.warn(`Fiyat boş, atlandı: [${categoryName}] ${it.title}`);
          continue;
        }
        const sellPriceValue = cleanMoneyToNumber(sellPriceStr);

        try {
          await upsertAndArchive(
            {
              siteName: "kabasakalonline",
              categoryName,
              itemName: it.title,
              sellPrice: sellPriceStr,     // örn "189,99" -> ham metin
              sellPriceValue,              // 189.99
              currency: it.currency,       // "₺" | "TL" | "TRY" ...
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
    console.error("Kabasakal scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
