// cronTasks/vioragame.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const norm  = (s) => (s || "").replace(/\s+/g, " ").trim();

// TR & US formatlarını sayıya çevir: "1.234,56 TL" | "₺ 39,90" | "39.90" | "31,976.99"
function parsePriceAny(txt) {
  if (!txt) return null;
  let s = String(txt);
  s = s.replace(/(TL|TRY)/gi, "")
       .replace(/[₺$€£]/g, "")
       .replace(/[^\d.,]/g, " ")
       .replace(/\s+/g, " ")
       .trim();

  if (/,(\d{2})$/.test(s)) {                 // 1.234,56 / 39,90
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/\.(\d{2})$/.test(s) && /,/.test(s)) { // 1,234.56
    s = s.replace(/,/g, "");
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * Giriş:
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

  // ---- 2) PUPPETEER ----
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1366, height: 840 },
  });

  const page = await browser.newPage();
  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  try {
    for (const { url, categoryName } of tasks) {
      if (!/^https?:\/\//i.test(url)) { console.error("Geçersiz URL:", url); continue; }
      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .catch(() => page.goto(url, { waitUntil: "load", timeout: 90000 }));

      // Lazy içerikler için az scroll
      for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 1200)); await sleep(150); }

      // === Senin verdiğin selector'larla (karta göre relative) ===
      const CARD_SEL  = 'div[class*="xl:w-1/5"]'; // Tailwind sınıfını attribute ile yakala
      const NAME_REL  = 'div:nth-child(1) > a:nth-child(1) > div:nth-child(1) > div:nth-child(2) > p:nth-child(1)';
      const PRICE_REL = 'div:nth-child(1) > a:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > strong:nth-child(2)';

      await page.waitForSelector(CARD_SEL, { timeout: 30000 }).catch(()=>{});

      let items = await page.$$eval(CARD_SEL, (cards, NAME_REL, PRICE_REL) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const out = [];

        // Fallback için fiyat regexleri (kart metninden en düşük fiyat)
        const priceRes = [
          /\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g,  // 1.234,56
          /\b\d+,\d{2}\b/g,                  // 39,90
          /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g,  // 1,234.56
          /\b\d+\.\d{2}\b/g                  // 39.90
        ];
        const getPrices = (text) => {
          const set = new Set();
          for (const re of priceRes) {
            let m; while ((m = re.exec(text)) !== null) set.add(m[0]);
          }
          return Array.from(set);
        };

        for (const card of cards) {
          let nameEl  = card.querySelector(NAME_REL);
          let priceEl = card.querySelector(PRICE_REL);

          let title = nameEl ? norm(nameEl.textContent || "") : "";
          let priceText = priceEl ? norm(priceEl.textContent || "") : "";

          // fallback: isim boşsa kart içindeki anlamlı ilk başlık/ad linkini dene
          if (!title) {
            const cand = card.querySelector('h3, h2, [class*="title"], a');
            if (cand) title = norm(cand.textContent || "");
          }

          // fallback: fiyat boşsa kart metninde ara, en düşüğü seç
          if (!priceText) {
            const txt = norm(card.innerText || card.textContent || "");
            const prices = getPrices(txt);
            if (prices.length) {
              const toNum = (s) => {
                let x = s.replace(/[^\d.,]/g, '');
                if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
                else if (/\.(\d{2})$/.test(x) && /,/.test(x)) x = x.replace(/,/g, '');
                const n = parseFloat(x);
                return Number.isFinite(n) ? n : NaN;
              };
              prices.sort((a,b)=>toNum(a)-toNum(b));
              priceText = prices[0];
            }
          }

          if (title && priceText) out.push({ title, priceText });
        }
        return out;
      }, NAME_REL, PRICE_REL).catch(()=>[]);

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı (selectorlarla): ${url}`);
        // hızlı debug için ilk kart snippet
        try {
          const count = await page.$$eval(CARD_SEL, els => els.length);
          console.log("DEBUG card count:", count);
          if (count > 0) {
            const html = await page.$eval(CARD_SEL, el => (el.innerHTML || "").slice(0, 800));
            console.log("DEBUG first card snippet:", html);
          }
        } catch {}
        continue;
      }

      items = uniqueBy(items, (it) => (it.title + "|" + it.priceText).toLowerCase());

      for (const it of items) {
        const priceValue = parsePriceAny(it.priceText);
        if (!Number.isFinite(priceValue)) {
          console.warn(`Fiyat parse edilemedi, atlanıyor: [${categoryName}] ${it.title} -> ${it.priceText}`);
          continue;
        }

        try {
          await upsertAndArchive(
            {
              siteName: "VioraGame",
              categoryName,
              itemName: norm(it.title),
              sellPrice: it.priceText.replace(" ₺",""),     // orijinal metin (örn: "39,90 TL" / "₺39,90" / "39.90")
              sellPriceValue: priceValue,  // number
              currency: "₺",
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.priceText} (${priceValue} ₺)`);
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }

      await sleep(250);
    }
  } catch (err) {
    console.error("VioraGame scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
