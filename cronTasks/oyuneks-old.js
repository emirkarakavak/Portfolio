// oyuneks_xhr_capture.js
const puppeteer = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const URL = 'https://oyuneks.com/wartune-ultra/wartune-ultra-elmas';
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
// === PROXY GİR (username:password@host:port) veya boş bırak ===
const PROXY = ''; // örn: 'http://user:pass@tr-resi-proxy.example.com:12345'

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function tl(n) {
  if (typeof n === 'string') return n;
  if (typeof n === 'number') return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
  return null;
}

(async () => {
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY) launchArgs.push(`--proxy-server=${PROXY.replace(/^https?:\/\//, '')}`);

  const browser = await puppeteer.launch({
    headless: false,              // headful: şüphe azaltır
    args: launchArgs,
    defaultViewport: { width: 1366, height: 900 },
  });
  const page = await browser.newPage();

  // Bazı iz sürücülerini engelle
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7' });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // XHR/Fetch yanıtlarını dinle
  const prices = new Set();
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!/json|javascript/.test(ct)) return;
    try {
      const url = res.url();
      // fiyat barındırabilecek istekleri filtrele (geniş tut)
      if (!/(api|ajax|cart|product|price|variant|offer|checkout|basket|wp-json)/i.test(url)) return;
      const body = await res.text();
      // JSON parse etmeye çalış
      let data;
      try { data = JSON.parse(body); } catch { return; }

      // JSON içinde olası fiyat alanlarını dolaş
      const found = [];
      const walk = (obj, path = []) => {
        if (obj && typeof obj === 'object') {
          if ('price' in obj || 'sale_price' in obj || 'regular_price' in obj || 'amount' in obj || 'display_price' in obj) {
            const name = (obj.name || obj.title || obj.product_name || obj.label || '').toString();
            const p = obj.price ?? obj.sale_price ?? obj.display_price ?? obj.amount ?? obj.regular_price;
            found.push({ name, price: p });
          }
          for (const k of Object.keys(obj)) walk(obj[k], path.concat(k));
        }
      };
      walk(data);

      for (const f of found) {
        const key = norm((f.name || '') + '|' + (f.price || '')).toLowerCase();
        if (prices.has(key)) continue;
        prices.add(key);
        const name = norm(f.name || (await page.title()).replace(/ - Oyuneks.*/, ''));
        const priceStr = typeof f.price === 'string' && /₺|TL/.test(f.price)
          ? f.price
          : tl(Number(f.price));
        if (name && priceStr) console.log(`${name} -> ${priceStr}`);
      }
    } catch { }
  });

  // Sayfayı aç
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Tipik cookie/consent kapatma (görünürse)
  try {
    await page.waitForSelector('button, [role="button"]', { timeout: 8000 });
    await page.evaluate(() => {
      const texts = ['kabul', 'onayla', 'tamam', 'accept', 'seçimlerimi'];
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],a'))) {
        const t = (el.textContent || '').toLowerCase();
        if (texts.some(x => t.includes(x))) el.click();
      }
    });
  } catch { }

  // Biraz kullanıcı gibi davran → scroll + biraz bekle
  for (let i = 0; i < 6; i++) {
    if (page.mouse && page.mouse.wheel) {
      await page.mouse.wheel({ deltaY: 1200 });
    } else {
      // Eski sürümler için fallback: scroll’u evaluate ile yap
      await page.evaluate(() => window.scrollBy(0, 1200));
    }
    await sleep(400);
  }

  // Sayfadaki ürün/opsiyonlara tıkla ki XHR tetiklensin
  try {
    const clickableSelectors = ['button', 'a', '[role="button"]', 'input[type="radio"]', 'input[type="button"]', '[class*="add"]'];
    for (const sel of clickableSelectors) {
      const els = await page.$$(sel);
      for (const el of els.slice(0, 50)) { // aşırıya kaçma
        try { await el.click({ delay: 50 }); await page.waitForTimeout(200); } catch { }
      }
    }
  } catch { }

  // XHR’ların bitmesi için biraz bekle
  await page.waitForTimeout(5000);

  await browser.close();
});
