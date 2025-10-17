// cronTasks/bng.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

// --- utils ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
function toNumberTRorUS(p) {
  let x = String(p).replace(/[^\d.,]/g, "").trim();
  if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
  else if (/\.(\d{2})$/.test(x) && /,\d{3}/.test(x)) x = x.replace(/,/g, "");
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : NaN;
}
function parsePriceAny(txt) {
  const m = String(txt).match(/(₺\s*)?(\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}/);
  if (!m) return null;
  const v = toNumberTRorUS(m[0]);
  return Number.isFinite(v) ? v : null;
}
function uniqueBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr) { const k = keyFn(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  return out;
}

// TL/TRY/₺ zorunlu (yüzde/kur/miktar saçmalıklarını ele)
const PRICE_RE_SRC =
  String.raw`(?:₺\s*)?(?:\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}\s*(?:TL|TRY)|(?:₺\s*)(?:\d{1,3}(?:[.,]\d{3})*|\d+)[.,]\d{2}`;
const CTA_RE_SRC = String.raw`(Şimdi\s*Al|Hemen\s*Al|Satın\s*Al|Sepete\s*Ekle|Yükle|Yükleme)`;
const JUNK_RE_SRC = String.raw`(cookie|consent|header|footer|nav|breadcrumb|geri|popup|modal|newsletter|kampanya|kvkk|cerez)`;

// --- çekirdek çıkarım ---
async function extractProducts(page) {
  return await page.evaluate(({ PRICE_RE_SRC, CTA_RE_SRC, JUNK_RE_SRC }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const PRICE_RE_G = new RegExp(PRICE_RE_SRC, "gi"); // exec ile listeler
    const PRICE_RE_TEST = new RegExp(PRICE_RE_SRC, "i");  // .test için stateful değil
    const CTA_RE = new RegExp(CTA_RE_SRC, "i");
    const JUNK_RE = new RegExp(JUNK_RE_SRC, "i");

    function toNumberTRorUS(p) {
      let x = String(p).replace(/[^\d.,]/g, "").trim();
      if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
      else if (/\.(\d{2})$/.test(x) && /,\d{3}/.test(x)) x = x.replace(/,/g, "");
      const v = parseFloat(x);
      return Number.isFinite(v) ? v : NaN;
    }
    function pickFinalPrice(container) {
      const text = norm(container?.innerText || container?.textContent || "");
      if (!text) return null;
      // sırayla tüm fiyatları al, HTML’de ~~işaretli~~ olanları kaba kestir
      const matches = [];
      let m;
      PRICE_RE_G.lastIndex = 0; // güvenlik
      while ((m = PRICE_RE_G.exec(text)) !== null) matches.push(m[0]);
      if (!matches.length) return null;

      const html = container.innerHTML || "";
      const filtered = matches.filter((r) => {
        const rEsc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const strikeRe = new RegExp(`~~\\s*${rEsc}\\s*~~`);
        return !strikeRe.test(html);
      });
      const chosen = (filtered.length ? filtered : matches)[(filtered.length ? filtered : matches).length - 1];
      const val = toNumberTRorUS(chosen);
      return Number.isFinite(val) ? { raw: chosen, val } : null;
    }

    // URL'den oyun slug'ını çıkar (…/oyunlar/<game>/…)
    const segs = location.pathname.split("/").filter(Boolean);
    // /tr/oyunlar/<game>/...
    let oyIdx = segs.indexOf('oyunlar');
    let gameSeg = null;
    if (oyIdx !== -1 && segs[oyIdx + 1]) gameSeg = segs[oyIdx + 1];
    const GAME_HREF_PART = gameSeg ? `/oyunlar/${gameSeg}/` : "/oyunlar/"

    // Sayfanın büyük çöplük alanlarını komple dışla
    const scope = Array.from(document.querySelectorAll("main, #main, .main, #content, .content, body"))
      .find(el => el) || document.body;

    // Fiyat geçen tüm bloklar aday; ama junk alanlarda değil.
    const allBlocks = Array.from(scope.querySelectorAll("article, section, li, div"))
      .filter(el => el && el.offsetParent !== null) // görünür olanlar
      .filter(el => !JUNK_RE.test(el.id + " " + el.className))
      .filter(el => {
        const t = (el.innerText || "").trim();
        return /(₺|TL|TRY)/i.test(t) && PRICE_RE_TEST.test(t);
      });

    const results = [];
    for (const b of allBlocks) {
      // aynı oyun slug'ına ait bir link var mı?
      const a = b.querySelector(`a[href*="${GAME_HREF_PART}"]`) || b.querySelector("h2 a, h3 a, a");
      if (!a) continue;

      // container’ın gerçekten ürün bloğu olduğunu anlamak için:
      // - CTA sinyali varsa süper
      // - yoksa en azından başlık + fiyat birlikte dursun
      const text = norm(b.innerText || "");
      if (!CTA_RE.test(text)) {
        // CTA yoksa, "başlık gibi" bir şey var mı?
        const titleCandidate = (b.querySelector("h2, h3, [class*='title'], [class*='name'], a") || {});
        const t = norm(titleCandidate.textContent || a.textContent || "");
        if (!t) continue;
        // Ayrıca çok uzun (FAQ gibi) blokları ele (ör: > 5000 karakter)
        if (text.length > 5000) continue;
      }

      // Final fiyat
      const best = pickFinalPrice(b);
      if (!best) continue;

      // Başlık
      const titleEl = b.querySelector("h2 a, h2, h3 a, h3, [class*='title'] a, [class*='title'], [class*='name'] a, [class*='name']") || a;
      const title = norm(titleEl?.textContent || a.textContent || "");
      if (!title) continue;

      results.push({ title, priceRaw: best.raw, priceVal: best.val });
    }

    // Halen yoksa, son çare: GRID benzeri alanlar
    if (!results.length) {
      const grids = Array.from(scope.querySelectorAll('[class*="grid"], [class*="product"], [class*="list"]'))
        .filter(el => !JUNK_RE.test(el.className));
      for (const g of grids) {
        const cards = Array.from(g.querySelectorAll("article, li, div")).slice(0, 500);
        for (const c of cards) {
          const t = norm(c.innerText || "");
          if (!t || !/(₺|TL|TRY)/i.test(t) || !PRICE_RE.test(t)) continue;
          const a = c.querySelector(`a[href*="${GAME_HREF_PART}"]`) || c.querySelector("h2 a, h3 a, a");
          if (!a) continue;
          const titleEl = c.querySelector("h2 a, h2, h3 a, h3, [class*='title'] a, [class*='title'], [class*='name'] a, [class*='name']") || a;
          const title = norm(titleEl?.textContent || a.textContent || "");
          if (!title) continue;
          const best = pickFinalPrice(c);
          if (!best) continue;
          results.push({ title, priceRaw: best.raw, priceVal: best.val });
        }
      }
    }

    // Temizleme: belirgin çöp başlıkları at
    const BAD_TITLE = /(Nedir|Yapımcısı|Nasıl|AppStore|Buradasın|Çerez|Ayarlar|Analitik|Pazarlama|KVKK|Geri Dön)/i;
    return results.filter(x => !BAD_TITLE.test(x.title));
  }, { PRICE_RE_SRC, CTA_RE_SRC, JUNK_RE_SRC });
}

// --- flexible API (değişmedi) ---
exports.run = async (input, categoryName) => {
  let tasks = [];
  const isObjArray = Array.isArray(input) && input.every(v => v && typeof v === "object");
  const isStrArray = Array.isArray(input) && input.every(v => typeof v === "string");
  const isStr = typeof input === "string";

  if (isObjArray) {
    tasks = input.map((t, i) => {
      if (!t?.url || !t?.categoryName) throw new Error(`Task[${i}] eksik: url & categoryName`);
      return { url: String(t.url).trim(), categoryName: String(t.categoryName).trim() };
    });
  } else if (isStrArray) {
    if (!categoryName) throw new Error("categoryName eksik (string[] için gerekli).");
    tasks = input.map(u => ({ url: String(u).trim(), categoryName: String(categoryName).trim() }));
  } else if (isStr) {
    if (!categoryName) throw new Error("categoryName eksik (string için gerekli).");
    tasks = [{ url: String(input).trim(), categoryName: String(categoryName).trim() }];
  } else {
    throw new Error("Geçersiz parametre. String | string[] | {url,categoryName}[] beklenir.");
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

  const ua = new UserAgent({ deviceCategory: "desktop" }).toString();
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  async function closeConsentPopups() {
    const sels = [
      "#onetrust-accept-btn-handler",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "[class*='cookie'] [class*='accept']",
      "[data-action*='accept']",
      "button[aria-label*='Kabul']",
    ];
    for (const s of sels) {
      try { const btn = await page.$(s); if (btn) await btn.click().catch(() => { }); } catch { }
    }
  }

  try {
    for (const { url, categoryName } of tasks) {
      console.log(`Scraping: ${url} -> ${categoryName}`);

      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 }).catch(
        () => page.goto(url, { waitUntil: "load", timeout: 120000 })
      );

      await closeConsentPopups().catch(() => { });

      await Promise.race([
        page.waitForSelector("h2, h3, a", { timeout: 20000 }),
        page.waitForFunction(
          () => /\d{1,3}([.,]\d{3})*[.,]\d{2}\s*(TL|TRY)|₺/.test(document.body.innerText),
          { timeout: 20000 }
        ),
      ]).catch(() => { });

      // lazy
      for (let i = 0; i < 12; i++) {
        await page.evaluate(() => window.scrollBy(0, 1800));
        await sleep(200);
      }
      await sleep(1000);

      let items = await extractProducts(page).catch(() => []);

      if (!items?.length) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        continue;
      }

      const cleaned = uniqueBy(
        items
          .map(it => ({
            title: norm(it.title).replace(/\s{2,}/g, " "),
            priceText: String(it.priceRaw).trim(),
            priceValue: parsePriceAny(it.priceRaw),
          }))
          .filter(it => it.title && it.priceText && Number.isFinite(it.priceValue) && it.priceValue > 0),
        it => (it.title + "|" + it.priceText).toLowerCase()
      );

      for (const it of cleaned) {
        try {
          await upsertAndArchive(
            {
              siteName: "bynogame",
              categoryName,
              itemName: it.title,
              sellPrice: it.priceText.replace(" TL", ""),
              sellPriceValue: it.priceValue,
              currency: "₺",
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.priceText} (${it.priceValue} ₺)`);
        } catch (e) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, e?.message || e);
        }
      }

      await sleep(200);
    }
  } catch (err) {
    console.error("ByNoGame scrape hatası:", err?.stack || err?.message || err);
  } finally {
    await browser.close();
  }
};
