// cronTasks/btkgame.js
"use strict";

const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

function formatPriceCanonical(x) {
  const v = typeof x === "number" ? x : parsePriceAny(x);
  return Number.isFinite(v) ? v.toFixed(2) : null; // "7599.99"
}

// TR ve US biçimlerini sayıya çevirir
function parsePriceAny(txt) {
  if (!txt) return null;
  let s = String(txt)
    .replace(/(TL|TRY)/gi, "")
    .replace(/[₺$€£]/g, "")
    .replace(/[^\d.,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Son ayıracı ondalık kabul eden sağlam yaklaşım
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep === -1) {
    const v0 = Number(s.replace(/[^\d-]/g, ""));
    return Number.isFinite(v0) ? v0 : null;
  }
  const decDigits = s.length - lastSep - 1;
  if (decDigits === 2) {
    const digits = s.replace(/[^\d-]/g, "");
    if (digits.length < 3) return Number.isFinite(+digits) ? +digits : null;
    const intPart = digits.slice(0, -2);
    const frac = digits.slice(-2);
    const v = Number(intPart + "." + frac);
    return Number.isFinite(v) ? v : null;
  } else {
    const v = Number(s.replace(/[^\d-]/g, ""));
    return Number.isFinite(v) ? v : null;
  }
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

/** BTKGame: Para birimini TRY yap (menüyü açmayı dener, yoksa direkt select/cookie ile zorlar) */
async function ensureTRYCurrencyBTK(page) {
  // 1) Ana sayfa
  await page.goto("https://www.btkgame.com/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  await sleep(600);

  // 2) Açılabilir menü/drawer varsa açmayı dene (selector'lar geniş tutuldu)
  const OPENERS = [
    'a.w-100.lang-down',
    '[class*="preference"] [data-bs-toggle="dropdown"]',
    '[class*="preference"] .dropdown-toggle',
    'a[href*="#preference"]',
    'button[aria-controls*="preference"]',
    'button[aria-expanded][data-bs-toggle="dropdown"]',
  ];
  for (const btnSel of OPENERS) {
    const ok = await page.$(btnSel);
    if (!ok) continue;
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: "center" });
      }, btnSel);
      try { await page.hover(btnSel); } catch {}
      await page.click(btnSel).catch(()=>{});
      // menü/drawer görünsün diye kısa bekleme
      await sleep(400);
    } catch {}
  }

  // 3) name="currency" (ve türevleri) olan select’i bul ve TRY seç
  const CURRENCY_SELECTS = [
    'select.preference-input[name="currency"]',
    'select#currency',
    'select[name="currency"]',
    'select[name*=curr]',
    'select[id*=curr]',
  ];

  let selectedOk = false;
  for (const SEL of CURRENCY_SELECTS) {
    const exists = await page.$(SEL);
    if (!exists) continue;

    // A) value=TRY ise direkt
    try {
      const res = await page.select(SEL, "TRY");
      if (Array.isArray(res) && res.length) { selectedOk = true; break; }
    } catch {}

    // B) Metne göre TRY/TL/₺ bulup set et + change tetikle
    const ok = await page.evaluate((selector) => {
      const sel = document.querySelector(selector);
      if (!sel) return false;
      const opts = Array.from(sel.options || []);
      let trg = opts.find(o => String(o.value).toUpperCase() === "TRY");
      if (!trg) trg = opts.find(o => /(^|\b)(TL|TRY)(\b|$)|₺/i.test(o.textContent || ""));
      if (!trg && opts[1]) trg = opts[1];
      if (!trg) return false;
      sel.value = trg.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, SEL);
    if (ok) { selectedOk = true; break; }
  }

  // 4) Kaydet / Uygula butonlarına basmayı dene
  const SAVE_BTNS = [
    "button.preference-button.pref-ok",
    "button.btn-save",
    "button[type=submit]",
    "button.save",
    "button:has(+ .preference-button)", // olası
  ];
  for (const sb of SAVE_BTNS) {
    const has = await page.$(sb);
    if (!has) continue;
    try {
      const nav = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 12000 }).catch(()=>null);
      await page.click(sb);
      await nav;
      await sleep(600);
      break;
    } catch {}
  }

  // 5) Cookie/localStorage fallback (sunucu bazen UI görmezden gelebilir)
  if (!selectedOk) {
    try {
      const cookies = [
        { name: "currency", value: "TRY", domain: ".btkgame.com", path: "/" },
        { name: "Currency", value: "TRY", domain: ".btkgame.com", path: "/" },
        { name: "selectedCurrency", value: "TRY", domain: ".btkgame.com", path: "/" },
        { name: "currency", value: "TRY", domain: "www.btkgame.com", path: "/" },
      ];
      for (const c of cookies) { try { await page.setCookie(c); } catch {} }
      await page.evaluate(() => {
        const keys = ["currency", "Currency", "selectedCurrency"];
        for (const k of keys) { try { localStorage.setItem(k, "TRY"); } catch {} }
      });
      await page.reload({ waitUntil: "networkidle2", timeout: 15000 }).catch(()=>{});
      await sleep(500);
    } catch {}
  }
}

/**
 * Giriş desteği:
 * - run("https://...", "kategori")
 * - run(["https://...", ...], "kategori")
 * - run([{ url, categoryName }, ...])
 */
exports.run = async (input, categoryName) => {
  // ---- 1) GİRİŞ NORMALİZASYONU ----
  let tasks = [];
  const isObjArray = Array.isArray(input) && input.every((v) => typeof v === "object" && v);
  const isStrArray = Array.isArray(input) && input.every((v) => typeof v === "string");
  const isStr = typeof input === "string";

  if (isObjArray) {
    tasks = input.map((t, i) => {
      if (!t?.url || !t?.categoryName) throw new Error(`Task[${i}] eksik: url & categoryName zorunlu`);
      return { url: String(t.url).trim(), categoryName: String(t.categoryName).trim() };
    });
  } else if (isStrArray) {
    if (!categoryName) throw new Error("categoryName eksik (string[] girişi için gerekli).");
    tasks = input.map((u) => ({ url: String(u).trim(), categoryName: String(categoryName).trim() }));
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
      "--disable-dev-shm-usage",
      "--lang=tr-TR",
    ],
    defaultViewport: { width: 1366, height: 840 },
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
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  try {
    // <<< ÖNCE TL'Yİ ZORLA >>>
    await ensureTRYCurrencyBTK(page);

    for (const { url, categoryName } of tasks) {
      if (!/^https?:\/\//i.test(url)) {
        console.error("Geçersiz URL:", url);
        continue;
      }

      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);

      // (Gerekiyorsa kategori öncesi tekrar)
      // await ensureTRYCurrencyBTK(page);

      await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .catch(() => page.goto(url, { waitUntil: "load", timeout: 90000 }));

      // Lazy içerikler için az scroll
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await sleep(150);
      }

      // === Kartlardan isim + İNDİRİMLİ/FINAL fiyat (eski fiyatı ele)
      const items = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

        const CARD_SEL =
          '.card, .product, .product-item, li.product, [class*="product"], [class*="list"] [class*="item"], .col-lg-6, .col-md-6, article, li';

        const NAME_SELS = [
          '[class*="title"]',
          ".product-title",
          ".title",
          "h3","h2","h4",
          'a[href*="/product"]',
          'a[href*="/urun"]',
          "a",
        ];

        // FİNAL/İNDİRİMLİ fiyatı vurgulayan geniş set
        const PRICE_NODE_SELS = [
          '[itemprop="price"]',
          ".price ins", ".price .new", ".price-new",
          ".current-price", ".sale", ".discount", ".final",
          ".discounted-price", ".sale-price", ".new-price",
          '[class*="price"] .amount', '[class*="price"] span',
          '[class*="price"]', '[class*="fiyat"]'
        ];

        const PRODUCT_HINT_SELS = [
          '[itemtype*="Product"]', '[itemscope][itemtype*="Product"]',
          "button.add-to-cart","a.add-to-cart","[class*='add-to-cart']",
          "[class*='sepet']",'button[type="submit"]'
        ];

        const isVisible = (el) => {
          const st = el && window.getComputedStyle(el);
          return !!(el && st && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0");
        };

        const hasProductHints = (card) => {
          if (PRICE_NODE_SELS.some((sel) => card.querySelector(sel))) return true;
          if (PRODUCT_HINT_SELS.some((sel) => card.querySelector(sel))) return true;
          const t = norm(card.innerText || "");
          if (/\b(sepete ekle|add to cart|satın al|stok|kargo)\b/i.test(t)) return true;
          return false;
        };

        const isStruckOld = (el) => {
          if (!el) return false;
          const cls = (el.className || "").toLowerCase();
          if (el.tagName === "DEL" || el.tagName === "S" || el.tagName === "STRIKE") return true;
          if (/(old|eski|before|was|compare|line-through)/i.test(cls)) return true;
          const style = window.getComputedStyle(el);
          if (style && /(line-through)/i.test(style.textDecoration || "")) return true;
          let p = el.parentElement;
          for (let i = 0; i < 3 && p; i++) {
            const pc = (p.className || "").toLowerCase();
            if (p.tagName === "DEL" || p.tagName === "S" || p.tagName === "STRIKE") return true;
            if (/(old|eski|before|was|compare|line-through)/i.test(pc)) return true;
            const ps = window.getComputedStyle(p);
            if (ps && /(line-through)/i.test(ps.textDecoration || "")) return true;
            p = p.parentElement;
          }
          return false;
        };

        const NUMBER_RES = [
          /\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g, // 1.234,56
          /\b\d+,\d{2}\b/g,                 // 39,90
          /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g, // 1,234.56
          /\b\d+\.\d{2}\b/g,                // 39.90
        ];

        const INSTALLMENT_RE = /\b\d{1,2}\s*[xX×]\s*\d+(?:[.,]\d{2})?\b/;

        const toNum = (s) => {
          let x = String(s).replace(/[^\d.,-]/g, "");
          // son iki hane ondalık kabul
          const digits = x.replace(/[^\d-]/g,'');
          if (digits.length >= 3) return Number(digits.slice(0,-2) + "." + digits.slice(-2));
          const n = parseFloat(x.replace(',','.'));
          return Number.isFinite(n) ? n : NaN;
        };

        const getAllNumbersWithSpans = (text) => {
          const out = [];
          for (const re of NUMBER_RES) {
            let m;
            while ((m = re.exec(text)) !== null) out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
          }
          return out;
        };

        const scoreCandidate = ({ raw, v, el, fullText, span }) => {
          let score = 0;
          const windowTxt = norm(fullText.slice(Math.max(0, span.start - 15), Math.min(fullText.length, span.end + 15)));
          if (/(₺|TL|TRY|\$|€|£)/i.test(windowTxt)) score += 3;
          const cls = (el.className || "").toLowerCase();
          if (/(price|new|current|sale|final|amount|fiyat|discount|discounted)/i.test(cls)) score += 5;
          if (isStruckOld(el)) score -= 10; // eski fiyatları agresif ele
          if (INSTALLMENT_RE.test(fullText)) score -= 6;
          score += Math.log10(Math.max(v, 1)); // büyük olanı hafifçe tercih et (toplam fiyat)
          return score;
        };

        const pickFinalPrice = (card) => {
          if (!hasProductHints(card)) return null;

          const candidates = [];
          for (const sel of PRICE_NODE_SELS) {
            const nodes = card.querySelectorAll(sel);
            for (const el of nodes) {
              if (!isVisible(el)) continue;
              if (isStruckOld(el)) continue;
              const txt = norm(el.textContent || "");
              if (!txt) continue;
              if (INSTALLMENT_RE.test(txt)) continue;
              const spans = getAllNumbersWithSpans(txt);
              for (const span of spans) {
                const v = toNum(span.raw);
                if (!Number.isFinite(v)) continue;
                const sc = scoreCandidate({ raw: span.raw, v, el, fullText: txt, span });
                candidates.push({ raw: span.raw, v, score: sc });
              }
            }
          }
          if (!candidates.length) return null;

          const hasBig = candidates.some((c) => c.v >= 1000);
          const pruned = hasBig ? candidates.filter((c) => c.v >= 1000) : candidates;

          pruned.sort((a, b) => b.score - a.score || b.v - a.v);
          const best = pruned[0];
          return best ? { r: best.raw, v: best.v } : null;
        };

        const cards = Array.from(document.querySelectorAll(CARD_SEL));
        const out = [];
        for (const card of cards) {
          if (!hasProductHints(card)) continue;

          // İsim
          let name = "";
          for (const sel of NAME_SELS) {
            const el = card.querySelector(sel);
            if (el && norm(el.textContent)) { name = norm(el.textContent); break; }
          }
          if (!name) {
            const cand = card.querySelector("a, h1, h2, h3, h4, strong, .title, .product-title");
            if (cand) name = norm(cand.textContent || "");
          }
          if (!name) continue;

          const best = pickFinalPrice(card);
          if (best) out.push({ title: name, priceText: best.r, priceValue: best.v });
        }

        // başlığa göre tekille (en düşük toplam kalsın)
        const byTitle = new Map();
        for (const it of out) {
          const key = it.title.toLowerCase();
          const prev = byTitle.get(key);
          if (!prev || it.priceValue < prev.priceValue) byTitle.set(key, it);
        }
        return Array.from(byTitle.values());
      });

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        continue;
      }

      // Tekille + parse fallback
      const byTitle = new Map();
      for (const it of items) {
        const key = norm(it.title).toLowerCase();
        const pv = Number.isFinite(it.priceValue) ? it.priceValue : parsePriceAny(it.priceText);
        const rec = { title: norm(it.title), priceText: it.priceText, priceValue: pv };
        const prev = byTitle.get(key);
        if (!prev || (pv != null && pv < prev.priceValue)) byTitle.set(key, rec);
      }

      const finalItems = Array.from(byTitle.values()).filter((x) => Number.isFinite(x.priceValue));

      for (const it of finalItems) {
        try {
          await upsertAndArchive(
            {
              siteName: "btkgame",
              categoryName,
              itemName: it.title,
              sellPrice: formatPriceCanonical(it.priceValue),
              sellPriceValue: it.priceValue,
              currency: "₺",
              url,
            },
            { archiveMode: "always" }
          );
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.priceText} (${it.priceValue} ₺)`);
        } catch (err) {
          console.error(`Kaydetme hatası: [${categoryName}] ${it.title} ->`, err?.message || err);
        }
      }

      await sleep(250);
    }
  } catch (err) {
    console.error("BTKGame scrape hatası:", err?.message || err);
  } finally {
    await browser.close();
  }
};
