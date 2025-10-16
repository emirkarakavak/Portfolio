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

// TR ve US biçimlerini sayıya çevirir: "1.234,56 TL" | "₺ 39,90" | "39.90" | "31,976.99"
function parsePriceAny(txt) {
  if (!txt) return null;
  let s = String(txt);
  s = s
    .replace(/(TL|TRY)/gi, "")
    .replace(/[₺$€£]/g, "")
    .replace(/[^\d.,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "1.234,56" / "39,90"
  if (/,(-?\d{2})$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  // "1,234.56"
  else if (/\.(\d{2})$/.test(s) && /,\d{3}/.test(s)) {
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
    for (const { url, categoryName } of tasks) {
      if (!/^https?:\/\//i.test(url)) {
        console.error("Geçersiz URL:", url);
        continue;
      }

      console.log(`Scraping: ${url} -> kategori: ${categoryName}`);

      await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
        .catch(() => page.goto(url, { waitUntil: "load", timeout: 90000 }));

      // Lazy içerikler için az scroll
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await sleep(150);
      }

      // 1) Dayanıklı kart + isim + YALNIZCA FİNAL (indirimli) fiyat
      let items = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

        const CARD_SEL =
          '.card, .product, .product-item, li.product, [class*="product"], [class*="list"] [class*="item"], .col-lg-6, .col-md-6, article, li';

        const NAME_SELS = [
          '[class*="title"]',
          ".product-title",
          ".title",
          "h3",
          "h2",
          'a[href*="/product"]',
          'a[href*="/urun"]',
          "a",
        ];

        const PRICE_NODE_SELS = [
          '[itemprop="price"]',
          ".price ins", // <ins> genelde yeni fiyat
          ".price .new",
          ".price-new",
          ".current-price",
          ".sale",
          ".discount",
          ".final",
          '[class*="price"] .amount',
          '[class*="price"] span',
          '[class*="price"]',
          '[class*="fiyat"]',
        ];

        const PRODUCT_HINT_SELS = [
          '[itemtype*="Product"]',
          '[itemscope][itemtype*="Product"]',
          'button[type="submit"]',
          "button.add-to-cart",
          "a.add-to-cart",
          "[class*='add-to-cart']",
          "[class*='sepet']",
        ];

        const isVisible = (el) => {
          const style = el && window.getComputedStyle(el);
          return !!(el && style && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0");
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
          for (let i = 0; i < 4 && p; i++) {
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
          /\b\d+,\d{2}\b/g, // 39,90
          /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g, // 1,234.56
          /\b\d+\.\d{2}\b/g, // 39.90
        ];

        // taksit/per kalıbı (12 x 599,99)
        const INSTALLMENT_RE = /\b\d{1,2}\s*[xX×]\s*\d+(?:[.,]\d{2})?\b/;

        const getAllNumbersWithSpans = (text) => {
          const out = [];
          for (const re of NUMBER_RES) {
            let m;
            while ((m = re.exec(text)) !== null) out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
          }
          return out;
        };

        const toNum = (s) => {
          let x = String(s).replace(/[^\d.,-]/g, "");
          if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
          else if (/\.(\d{2})$/.test(x) && /,/.test(x)) x = x.replace(/,/g, "");
          const n = parseFloat(x);
          return Number.isFinite(n) ? n : NaN;
        };

        const badContext = (s) => /\b(taksit|aylık|ay|x|×|adet|pcs|piece|per)\b/i.test(s);
        const oldContext = (s) => /\b(old|eski|before|was|compare|indirimsiz)\b/i.test(s);
        const hasCurrency = (s) => /(₺|TL|TRY|\$|€|£)/i.test(s);
        const hasThousandsSep = (s) => /(\d\.\d{3},\d{2}|\d,\d{3}\.\d{2})/.test(s);

        const scoreCandidate = ({ raw, v, el, fullText, span }) => {
          let score = 0;
          const windowTxt = norm(fullText.slice(Math.max(0, span.start - 15), Math.min(fullText.length, span.end + 15)));
          if (hasCurrency(windowTxt)) score += 3;
          const cls = (el.className || "").toLowerCase();
          if (/(price|new|current|sale|final|amount|fiyat)/i.test(cls)) score += 4;
          if (hasThousandsSep(raw)) score += 2;
          if (badContext(windowTxt)) score -= 5;
          if (oldContext(cls + " " + windowTxt)) score -= 4;
          // büyük rakamı hafifçe tercih et
          score += Math.log10(Math.max(v, 1));
          return score;
        };

        const pickFinalPrice = (card) => {
          if (!hasProductHints(card)) return null; // ürün olmayan kartları at

          const candidates = [];
          for (const sel of PRICE_NODE_SELS) {
            const nodes = card.querySelectorAll(sel);
            for (const el of nodes) {
              if (!isVisible(el)) continue;
              if (isStruckOld(el)) continue;
              const txt = norm(el.textContent || "");
              if (!txt) continue;
              if (INSTALLMENT_RE.test(txt)) {
                // taksit bilgisinin olduğu node’u agresif şekilde ele
                continue;
              }
              const spans = getAllNumbersWithSpans(txt);
              for (const span of spans) {
                const v = toNum(span.raw);
                if (!Number.isFinite(v)) continue;
                const sc = scoreCandidate({ raw: span.raw, v, el, fullText: txt, span });
                candidates.push({ raw: span.raw, v, score: sc });
              }
            }
          }

          // Fallback'i kapat: tüm kart metninden tarama YAPMA (false positive önlemek için)
          if (!candidates.length) return null;

          // Eğer hem >=1000 hem <1000 adaylar varsa, <1000 olanları at (taksit/per-… olma ihtimali)
          const hasBig = candidates.some((c) => c.v >= 1000);
          const pruned = hasBig ? candidates.filter((c) => c.v >= 1000) : candidates;

          pruned.sort((a, b) => b.score - a.score || b.v - a.v);
          const best = pruned[0];
          return best ? { r: best.raw, v: best.v } : null;
        };

        const cards = Array.from(document.querySelectorAll(CARD_SEL));
        const out = [];
        for (const card of cards) {
          if (!hasProductHints(card)) continue; // ürün olmayanları erkenden ele

          // İsim
          let name = "";
          for (const sel of NAME_SELS) {
            const el = card.querySelector(sel);
            if (el && norm(el.textContent)) {
              name = norm(el.textContent);
              break;
            }
          }
          if (!name) {
            const cand = card.querySelector("a, h1, h2, h3, h4, strong, .title, .product-title");
            if (cand) name = norm(cand.textContent || "");
          }
          if (!name) continue;

          const best = pickFinalPrice(card);
          if (best) out.push({ title: name, priceText: best.r, priceValue: best.v });
        }

        // başlığa göre tekille (aynı ürün birden fazla kartta varsa en düşük fiyat kalsın)
        const byTitle = new Map();
        for (const it of out) {
          const key = it.title.toLowerCase();
          const prev = byTitle.get(key);
          if (!prev || it.priceValue < prev.priceValue) byTitle.set(key, it);
        }
        return Array.from(byTitle.values());
      });

      // 2) HÂLÂ boşsa — senin verdiğin KESKİN selector’larla dene (nth-child’lı)
      if (!items || items.length === 0) {
        const CARD_SEL = "div.col-lg-6";
        const NAME_REL = "div:nth-child(1) > div:nth-child(3) > a:nth-child(1) > h3:nth-child(1)";
        const PRICE_REL = "div:nth-child(1) > div:nth-child(3) > div:nth-child(3) > div:nth-child(1) > div:nth-child(1)";

        await page.waitForSelector(CARD_SEL, { timeout: 15000 }).catch(() => {});
        items = await page
          .$$eval(
            CARD_SEL,
            (cards, NAME_REL, PRICE_REL) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const NUMBER_RES = [
                /\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g,
                /\b\d+,\d{2}\b/g,
                /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g,
                /\b\d+\.\d{2}\b/g,
              ];
              const INSTALLMENT_RE = /\b\d{1,2}\s*[xX×]\s*\d+(?:[.,]\d{2})?\b/;

              const getAllNumbers = (text) => {
                const out = new Set();
                for (const re of NUMBER_RES) {
                  let m;
                  while ((m = re.exec(text)) !== null) out.add(m[0]);
                }
                return Array.from(out);
              };

              const toNum = (s) => {
                let x = String(s).replace(/[^\d.,-]/g, "");
                if (/,(\d{2})$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
                else if (/\.(\d{2})$/.test(x) && /,/.test(x)) x = x.replace(/,/g, "");
                const n = parseFloat(x);
                return Number.isFinite(n) ? n : NaN;
              };

              const out = [];
              for (const card of cards) {
                const nameEl = card.querySelector(NAME_REL);
                const priceEl = card.querySelector(PRICE_REL);
                const title = nameEl ? norm(nameEl.textContent || "") : "";
                if (!title || !priceEl) continue;

                const priceTxt = norm(priceEl.textContent || "");
                if (INSTALLMENT_RE.test(priceTxt)) continue; // taksit node'u

                const prices = getAllNumbers(priceTxt);
                if (!prices.length) continue;

                // En büyük = toplam (taksit/per ayıklamasından sonra)
                prices.sort((a, b) => toNum(b) - toNum(a));
                const priceText = prices[0];
                out.push({ title, priceText, priceValue: toNum(priceText) });
              }

              // başlığa göre tekille + en düşük toplamı bırak
              const byTitle = new Map();
              for (const it of out) {
                const key = it.title.toLowerCase();
                const prev = byTitle.get(key);
                if (!prev || it.priceValue < prev.priceValue) byTitle.set(key, it);
              }
              return Array.from(byTitle.values());
            },
            NAME_REL,
            PRICE_REL
          )
          .catch(() => []);
      }

      if (!items || items.length === 0) {
        console.warn(`Hiç ürün bulunamadı: ${url}`);
        continue;
      }

      // Güvenlik: başlığa göre tekilleştir (en düşük fiyat kalsın) + parse fallback
      const byTitle = new Map();
      for (const it of items) {
        const key = norm(it.title).toLowerCase();
        const pv = Number.isFinite(it.priceValue) ? it.priceValue : parsePriceAny(it.priceText);
        const rec = { title: norm(it.title), priceText: it.priceText, priceValue: pv };
        const prev = byTitle.get(key);
        if (!prev || (pv != null && pv < prev.priceValue)) byTitle.set(key, rec);
      }

      items = Array.from(byTitle.values()).filter((x) => Number.isFinite(x.priceValue));

      for (const it of items) {
        try {
          await upsertAndArchive(
            {
              siteName: "btkgame",
              categoryName,
              itemName: it.title,
              sellPrice: formatPriceCanonical(it.priceValue), // örn: "899,99 TL" //priceTExt
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
