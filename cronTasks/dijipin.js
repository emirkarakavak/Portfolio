// cronTasks/minPriceCards.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

// ---- fiyat yardımcıları (TR & US formatlarını destekler) ----
function toNumberTRorUS(p) {
  let x = String(p).replace(/[^\d.,]/g, "").trim();
  if (/,(\d{2})$/.test(x)) {
    // "1.234,56" / "39,90"
    x = x.replace(/\./g, "").replace(",", ".");
  } else if (/\.(\d{2})$/.test(x) && /,\d{3}/.test(x)) {
    // "1,234.56"
    x = x.replace(/,/g, "");
  }
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : NaN;
}

function parsePriceAny(txt) {
  const v = toNumberTRorUS(txt);
  return Number.isFinite(v) ? v : null;
}

// >>> kanonik string (binlik yok, nokta ondalık, 2 hane)
function formatCanonicalPrice(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(2); // örn 7023.80
}

function uniqueBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr) { const k = keyFn(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  return out;
}

/** 
 * TL'yi UI'dan seçer: menüyü açar -> name=currency select'ine TRY seçer -> Kaydet'e basar.
 * Başarısız olsa bile akışı bloklamaz; elinden geleni yapar.
 */
async function ensureTRYCurrency(page) {
  const BTN   = 'a.w-100.lang-down';
  const MENU  = 'div.dropdown-menu.preference-down';
  const MENU_SHOW = 'div.dropdown-menu.preference-down.show';
  const SELECT = 'select.preference-input[name="currency"]';
  const SAVE   = 'button.preference-button.pref-ok';

  // Ana sayfaya git (cookie/localStorage bağlamı için)
  await page.goto('https://www.dijipin.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(()=>{});
  await sleep(600);

  // Menü aç (hover + click)
  try {
    await page.waitForSelector(BTN, { timeout: 10000 });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center' });
    }, BTN);
    try { await page.hover(BTN); } catch {}
    await page.click(BTN);
    await page.waitForSelector(MENU, { timeout: 8000 });
    try { await page.waitForSelector(MENU_SHOW, { timeout: 4000 }); } catch {}
  } catch (e) {
    console.warn("Para birimi menüsü açılamadı:", e.message);
  }

  // name=currency select -> TRY
  try {
    await page.waitForSelector(SELECT, { timeout: 10000 });
    // 1) value=TRY varsa doğrudan
    let selectedOk = false;
    try {
      const res = await page.select(SELECT, 'TRY');
      selectedOk = Array.isArray(res) && res.length > 0;
    } catch (_) {}

    // 2) value yoksa metinle bulup set et + change tetikle
    if (!selectedOk) {
      const picked = await page.evaluate((SEL) => {
        const sel = document.querySelector(SEL);
        if (!sel) return { ok: false, reason: 'no-select' };
        const opts = Array.from(sel.options || []);
        let trg = opts.find(o => String(o.value).toUpperCase() === 'TRY');
        if (!trg) trg = opts.find(o => /(^|\b)(TL|TRY)(\b|$)|₺/i.test(o.textContent || ''));
        if (!trg && opts[1]) trg = opts[1];
        if (!trg) return { ok: false, reason: 'no-option' };
        sel.value = trg.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: trg.value, text: (trg.textContent || '').trim() };
      }, SELECT);
      selectedOk = !!picked.ok;
    }
    await sleep(250);
  } catch (e) {
    console.warn("TRY seçilemedi:", e.message);
  }

  // Kaydet
  try {
    await page.waitForSelector(SAVE, { timeout: 8000 });
    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
    await page.click(SAVE);
    const maybeNav = await navPromise;
    if (!maybeNav) {
      // ajax ise kısa bekleme
      await sleep(1000);
    }
  } catch (e) {
    console.warn("Kaydet tıklanamadı:", e.message);
  }
}

/**
 * Giriş desteği:
 *  - run("https://...", "kategori")
 *  - run(["https://...", ...], "kategori")
 *  - run([{ url, categoryName }, ...])
 */
exports.run = async (input, categoryName) => {
  // ---- 1) giriş normalizasyonu ----
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

  // ---- 2) puppeteer ----
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--lang=tr-TR",
    ],
    defaultViewport: { width: 1366, height: 860 },
  });

  const page = await browser.newPage();
  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
  });
  try { await page.emulateTimezone('Europe/Istanbul'); } catch {}
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  try {
    // <<< ÖNCE TL'Yİ ZORLA >>>
    await ensureTRYCurrency(page);

    for (const { url, categoryName } of tasks) {
      if (!/^https?:\/\//i.test(url)) { console.error("Geçersiz URL:", url); continue; }

      const siteName = "dijipin";

      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);

      // (İsteğe bağlı) Her URL öncesi TL'yi tekrar denemek istersen aç:
      // await ensureTRYCurrency(page);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .then(async () => { try { await page.waitForFunction(() => document.body && document.body.innerText.length > 50, { timeout: 15000 }); } catch { } })
        .catch(() => page.goto(url, { waitUntil: "load", timeout: 90000 }));

      // lazy içerikler için hafif scroll
      for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 1200)); await sleep(160); }

      // === Dayanıklı: kart metninden İSİM + minimum (>0) fiyat ===
      const items = await page.evaluate(() => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();

        function toNumberTRorUS(p) {
          let x = String(p).replace(/[^\d.,]/g, "").trim();
          if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
          else if (/\.(\d{2})$/.test(x) && /,\d{3}/.test(x)) x = x.replace(/,/g, "");
          const v = parseFloat(x);
          return Number.isFinite(v) ? v : NaN;
        }
        function extractPricesAll(text) {
          const re = /(₺\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}\s*(TL)?/gi;
          const out = new Set(); let m;
          while ((m = re.exec(text)) !== null) out.add(m[0]);
          return Array.from(out);
        }
        function pickBestPriceFromText(text) {
          const prices = extractPricesAll(text);
          const candidates = prices
            .map(p => ({ raw: p, n: toNumberTRorUS(p) }))
            .filter(x => Number.isFinite(x.n) && x.n > 0);
          if (!candidates.length) return null;
          candidates.sort((a, b) => a.n - b.n);
          return candidates[0]; // en düşük = indirimli
        }

        function cleanTitle(t) {
          let s = norm(t);
          s = s.replace(/(₺\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}\s*(TL)?/gi, " ");
          s = s.replace(/\(\d+\)\s*$/, ' ');
          s = s.replace(/\s+/g, ' ').trim();
          return s;
        }

        function isUnavailable(text) {
          return /(stok tükendi|tedarik aşamasında)/i.test(text);
        }
        const isPriceLine = (l) =>
          /(₺|\bTL\b)/i.test(l) || /(?!\bUC\b)\d{1,3}(?:[.,]\d{3})*[.,]\d{2}/.test(l);
        const isJunkLine = (l) =>
          /(sepete ekle|stok tükendi|tedarik)/i.test(l) ||
          /^[\d\s.,-]+$/.test(l);

        const CARD_SEL = '.card, .product, .product-item, li.product, [class*="product"], [class*="list"] [class*="item"], .col-lg-6, .col-md-6, .xl\\:w-1\\/5';
        const cards = Array.from(document.querySelectorAll(CARD_SEL));
        const out = [];

        for (const card of cards) {
          const rawText = norm(card.innerText || card.textContent || '');
          if (!rawText) continue;
          if (isUnavailable(rawText)) continue;

          let title = "";
          const titleEl =
            card.querySelector("h1, h2, h3, .product-title, .title, .product-name") ||
            card.querySelector("a[href*='/urun'], a[href*='/product'], a[href*='/game']");
          if (titleEl && norm(titleEl.textContent)) title = norm(titleEl.textContent);

          if (!title) {
            const lines = rawText.split(/\n+/).map(norm).filter(Boolean);
            const candidates = lines.filter(l => !isPriceLine(l) && !isJunkLine(l));
            title = candidates.sort((a, b) => b.length - a.length)[0] || "";
          }

          title = cleanTitle(title);

          const best = pickBestPriceFromText(rawText);
          if (title && best) {
            out.push({
              title,
              priceText: best.raw,
              priceValue: best.n,
              currency: "₺"
            });
          }
        }

        // başlık+fiyat metnine göre tekrarsız
        const seen = new Set();
        return out.filter(it => {
          const k = (it.title + '|' + it.priceText).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      });

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        try {
          const bodySnippet = await page.evaluate(() => (document.body && document.body.innerText || "").slice(0, 1200));
          console.log("DEBUG body snippet:", bodySnippet);
        } catch { }
        continue;
      }

      const deduped = uniqueBy(items, it => (it.title + "|" + it.priceText).toLowerCase());

      for (const it of deduped) {
        const priceValue = Number.isFinite(it.priceValue) ? it.priceValue : parsePriceAny(it.priceText);
        if (!Number.isFinite(priceValue) || priceValue <= 0) {
          console.warn(`Fiyat parse edilemedi/0, atlanıyor: [${categoryName}] ${it.title} -> ${it.priceText}`);
          continue;
        }
        const sellPriceStr = formatCanonicalPrice(priceValue);

        try {
          await upsertAndArchive(
            {
              siteName,                // örn "dijipin"
              categoryName,
              itemName: norm(it.title),
              sellPrice: sellPriceStr,
              sellPriceValue: priceValue,
              currency: it.currency || "₺",
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${sellPriceStr} (${priceValue} ₺)`);
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }

      await sleep(250);
    }
  } catch (err) {
    console.error("minPriceCards scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
