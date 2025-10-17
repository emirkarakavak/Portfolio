// cronTasks/kabasakalonline.js
const puppeteer = require("puppeteer");
const UserAgent = require("user-agents");
const { upsertAndArchive } = require("../lib/persist");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

async function saveDebug(page, tag) {
  try {
    const dir = path.join(__dirname, "..", "debug_kabasakal");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    await page.screenshot({ path: path.join(dir, `${ts}_${tag}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(dir, `${ts}_${tag}.html`), html, "utf8");
    const body = await page.evaluate(() => document.body?.innerText || "");
    fs.writeFileSync(path.join(dir, `${ts}_${tag}.txt`), body.slice(0, 20000), "utf8");
    console.log("DEBUG saved:", tag);
  } catch (e) { console.warn("debug fail:", e.message); }
}

function parsePriceAny(s) {
  if (!s) return null;
  let x = String(s).replace(/(TL|TRY)/gi, "")
    .replace(/[₺$€£]/g, "")
    .replace(/[^\d.,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lastComma = x.lastIndexOf(",");
  const lastDot = x.lastIndexOf(".");
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep === -1) {
    const v = Number(x.replace(/[^\d-]/g, ""));
    return Number.isFinite(v) ? v : null;
  }
  const dec = x.length - lastSep - 1;
  if (dec === 2) {
    const digits = x.replace(/[^\d-]/g, "");
    if (digits.length < 3) return Number.isFinite(+digits) ? +digits : null;
    return Number(digits.slice(0, -2) + "." + digits.slice(-2));
  }
  const v = Number(x.replace(/[^\d-]/g, ""));
  return Number.isFinite(v) ? v : null;
}

function fmtCanon(n) { return Number.isFinite(n) ? n.toFixed(2) : null; }

exports.run = async (tasks = []) => {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks boş. [{ url, categoryName }] ver.");

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
  await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // ufak stealth dokunuşları
    Object.defineProperty(navigator, "languages", { get: () => ["tr-TR","tr","en-US","en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  try {
    for (const { url, categoryName } of tasks) {
      if (!url || !categoryName) { console.warn("Task eksik, atlanıyor:", { url, categoryName }); continue; }

      console.log(`Scraping: ${url} -> ${categoryName}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 }).catch(()=>{});
      await sleep(600);

      // basit challenge tespiti
      const challenged = await page.evaluate(() => {
        const t = (document.title||"").toLowerCase();
        return t.includes("checking your browser") || t.includes("just a moment") ||
          !!document.querySelector('iframe[src*="challenge"], #challenge-form, .hcaptcha-box, .cf-challenge');
      });
      if (challenged) { console.warn("Koruma sayfası tespit edildi, atlanıyor:", url); await saveDebug(page,"challenge"); continue; }

      // sonsuz scroll (lazy)
      let lastHeight = 0, sameCount = 0;
      for (let i=0;i<20;i++){
        await page.evaluate(() => window.scrollBy(0, window.innerHeight*0.9));
        await sleep(350);
        const h = await page.evaluate(() => document.body.scrollHeight);
        if (h === lastHeight) { sameCount++; if (sameCount >= 3) break; } else { sameCount=0; lastHeight=h; }
      }

      // ürünleri dayanıklı şekilde toparla
      let items = await page.evaluate(() => {
        const norm = s => (s||"").replace(/\s+/g," ").trim();

        const CARD_SEL = [
          // grid/list kartları
          '[data-testid*="product"]',
          '[class*="product"]',
          'li[class*="col"]',
          'article',
          'li',
          '.group', // tailwind grupları
        ].join(",");

        // bir kart içinden isim ve fiyat çıkarmak
        function extractFromCard(card){
          let title = "";
          // başlık/link
          const nameCand = card.querySelector('a[href*="/urun"], a[href*="/product"], h3, h2, h4, .title, .product-title');
          if (nameCand) title = norm(nameCand.textContent||"");
          if (!title) {
            // kart içi en uzun satır
            const txt = norm(card.innerText||"");
            const lines = txt.split(/\n+/).map(norm).filter(Boolean);
            title = lines.sort((a,b)=>b.length-a.length)[0]||"";
          }
          if (!title) return null;

          // “eski fiyat”ı eleyen fiyat çıkarımı
          const isOld = (el) => {
            if (!el) return false;
            const cls = (el.className||"").toLowerCase();
            if (el.tagName==="DEL"||el.tagName==="S"||el.tagName==="STRIKE") return true;
            if (/(old|eski|before|was|compare|line-through)/.test(cls)) return true;
            const st = window.getComputedStyle(el);
            if (st && /line-through/.test(st.textDecoration||"")) return true;
            return false;
          };

          // fiyat düğümleri
          const priceNodes = Array.from(card.querySelectorAll(
            '[itemprop="price"], .price ins, .price .new, .price-new, .current-price, .sale, .discount, .final, .discounted-price, .sale-price, .new-price, [class*="price"] .amount, [class*="price"] span, [class*="price"], [class*="fiyat"]'
          ));

          // node → metin → içindeki fiyat adayları
          const NUM_RES = [
            /\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g,
            /\b\d+,\d{2}\b/g,
            /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g,
            /\b\d+\.\d{2}\b/g,
          ];
          const INSTALLMENT_RE = /\b\d{1,2}\s*[xX×]\s*\d+(?:[.,]\d{2})?\b/;

          function findCandidates(el){
            const txt = norm(el.textContent||"");
            if (!txt || INSTALLMENT_RE.test(txt)) return [];
            const arr = [];
            for (const re of NUM_RES){
              let m; while ((m=re.exec(txt))!==null) arr.push({ raw:m[0], txt });
            }
            // ₺/TL yakınlığını skora kat
            return arr.map(c=>{
              let score = 0;
              if (/(₺|TL|TRY)/i.test(c.txt)) score += 3;
              if (isOld(el)) score -= 10;
              // büyük olanı azıcık tercih (toplam fiyat)
              const digits = c.raw.replace(/[^\d]/g,'');
              const n = digits.length>=3 ? Number(digits.slice(0,-2)+"."+digits.slice(-2)) : parseFloat(c.raw.replace(',','.'));
              if (Number.isFinite(n)) score += Math.log10(Math.max(n,1));
              return { raw:c.raw, n, score };
            });
          }

          let cands = [];
          for (const pn of priceNodes) cands.push(...findCandidates(pn));
          if (!cands.length){
            // fallback: kartın komple metninden ara (riskli ama son çare)
            const txt = norm(card.innerText||"");
            if (!INSTALLMENT_RE.test(txt)){
              for (const re of NUM_RES){ let m; while((m=re.exec(txt))!==null) {
                const raw=m[0];
                const digits = raw.replace(/[^\d]/g,'');
                const n = digits.length>=3 ? Number(digits.slice(0,-2)+"."+digits.slice(-2)) : parseFloat(raw.replace(',','.'));
                cands.push({ raw, n, score:0 });
              }}
            }
          }
          cands = cands.filter(x=>Number.isFinite(x.n));
          if (!cands.length) return null;

          // >=1000 varsa küçükleri ele (per/adet vs. olabilir)
          const hasBig = cands.some(c=>c.n>=1000);
          if (hasBig) cands = cands.filter(c=>c.n>=1000);

          cands.sort((a,b)=> b.score - a.score || b.n - a.n);
          const best=cands[0];
          return best ? { title, priceText: best.raw, priceValue: best.n } : null;
        }

        const cards = Array.from(document.querySelectorAll(CARD_SEL))
          .filter(c => (c.innerText||"").match(/₺|TL|TRY/i)); // fiyat izi olmayan kartları ele
        const out=[];
        for (const card of cards){
          const rec = extractFromCard(card);
          if (rec) out.push(rec);
        }

        // başlığa göre tekille + en düşük kalsın
        const byTitle = new Map();
        for (const it of out){
          const k = it.title.toLowerCase();
          const prev = byTitle.get(k);
          if (!prev || it.priceValue < prev.priceValue) byTitle.set(k, it);
        }
        return Array.from(byTitle.values());
      });

      if (!items || !items.length) {
        console.warn(`Kabasakal: ürün bulunamadı -> ${url}`);
        await saveDebug(page, "no_items");
        continue;
      }

      for (const it of items) {
        const v = Number.isFinite(it.priceValue) ? it.priceValue : parsePriceAny(it.priceText);
        if (!Number.isFinite(v)) continue;
        try {
          await upsertAndArchive({
            siteName: "kabasakalonline",
            categoryName,
            itemName: norm(it.title),
            sellPrice: fmtCanon(v),     // "1234.56"
            sellPriceValue: v,          // 1234.56
            currency: "₺",
            url,
          }, { archiveMode: "always" });
          console.log(`Upsert: [${categoryName}] ${it.title} -> ${it.priceText} (${v} ₺)`);
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
