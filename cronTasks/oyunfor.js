// cronTasks/oyunfor.js
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { parseStringPromise } = require('xml2js');
const { upsertAndArchive } = require('../lib/persist');

/* ===================== downloader & preflight ===================== */
const FEED_URL = 'https://www.oyunfor.com/criteofeed';
// Dosyayı ne kadar süre “taze” sayalım? (ms). Aynı process’te ikinci çağrıda indirmesin:
const FRESH_MS = 5 * 60 * 1000; // 5 dk
const downloadMemo = new Map(); // filePath -> Promise

function getWithRedirect(u, { timeoutMs = 30000, maxRedirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(u);
    const client = urlObj.protocol === 'http:' ? http : https;
    const req = client.request(urlObj, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (crawler; oyunfor)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
        ...headers,
      },
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error('Max redirects aşıldı'));
        const next = new URL(res.headers.location, urlObj).toString();
        return resolve(getWithRedirect(next, { timeoutMs, maxRedirects: maxRedirects - 1, headers }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function downloadXmlTo(filePath, { force = false } = {}) {
  // force: true -> her seferinde indir
  // değilse: dosya yoksa indir; varsa mtime taze ise atla
  const abs = path.resolve(filePath);

  if (!force && fssync.existsSync(abs)) {
    try {
      const st = await fs.stat(abs);
      const age = Date.now() - st.mtimeMs;
      if (age < FRESH_MS) {
        // aynı process içinde tekrar indirmemek için kısa devre
        return;
      }
    } catch (_) {}
  }

  // Aynı anda iki task çağırırsa tek indirme olsun
  if (downloadMemo.has(abs)) {
    return downloadMemo.get(abs);
  }
  const p = (async () => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = await getWithRedirect(FEED_URL, { timeoutMs: 30000 });
    await fs.writeFile(abs, buf);
    console.log(`✓ Oyunfor feed indirildi → ${abs} (${buf.length.toLocaleString('tr-TR')} bayt)`);
  })();
  downloadMemo.set(abs, p);
  try {
    await p;
  } finally {
    downloadMemo.delete(abs);
  }
}

/* ===================== xml helpers ===================== */
function toArray(x){ return Array.isArray(x) ? x : (x ? [x] : []); }

/** ns'li alanları yakala: "g:price", "{...}price" vs. */
function getField(obj, fieldName) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[fieldName] !== undefined) return obj[fieldName];
  const key = Object.keys(obj).find(k => {
    const noColon = k.includes(':') ? k.split(':').pop() : k;
    const noBrace = noColon.includes('}') ? noColon.split('}').pop() : noColon;
    return noBrace === fieldName || k === `g:${fieldName}`;
  });
  return key ? obj[key] : undefined;
}

/** "15.00 TL" | "₺15,00" -> {raw,value,currency} */
function parsePrice(raw){
  if(!raw) return { raw:null, value:null, currency:null };
  const s = String(raw).trim();
  let currency = /₺|TL|TRY/i.test(s) ? 'TRY'
               : /\$|USD/i.test(s)   ? 'USD'
               : /€|EUR/i.test(s)    ? 'EUR' : null;

  const numStr = s
    .replace(/[^\d.,-]/g,'')
    .replace(/\.(?=.*\.)/g,'')
    .replace(',','.');
  const value = Number.parseFloat(numStr);
  return { raw:s, value: Number.isFinite(value) ? value : null, currency };
}

function extractTitle(it){
  return (getField(it,'title') ?? getField(it,'g:title') ?? '')
    .toString().replace(/\s+/g,' ').trim();
}
function extractPrice(it){
  return (getField(it,'g:price') ?? getField(it,'price') ?? '').toString();
}
function extractProductType(it){
  return (getField(it,'g:product_type') ?? getField(it,'product_type') ?? '')
    .toString().trim();
}

function isPUBG(it){
  const pt = extractProductType(it).toLowerCase();
  const t  = extractTitle(it).toLowerCase();
  return pt.includes('pubg mobile uc') || t.includes('pubg mobile');
}
function isMLBB(it){
  const pt = extractProductType(it).toLowerCase();
  const t  = extractTitle(it).toLowerCase();
  return pt.includes('mobile legends') || t.includes('mobile legends') || t.includes('mlbb');
}

function decideSplit(title, base){ // base: "oyunfor-pubgm" | "oyunfor-mlbb"
  return (title || '').toLowerCase().includes('global')
    ? `${base}-global`
    : `${base}-tr`;
}

/* ===================== public API (pipeline aynen kalsın) ===================== */

/** LOKAL XML → PUBG (TR+GLOBAL split) */
exports.runPUBGSplitLocal = async (filePath) => {
  // 1) önce indir (dosya yoksa ya da bayatsa). FORCE_DOWNLOAD=1 ile zorlayabilirsin.
  await downloadXmlTo(filePath, { force: process.env.FORCE_DOWNLOAD === '1' });

  // 2) parse & upsert
  const xml = await fs.readFile(filePath,'utf8');
  const parsed = await parseStringPromise(xml, { explicitArray:false });
  const items = toArray(parsed?.rss?.channel?.item);

  let tr=0, gl=0, skip=0;
  for(const it of items.filter(isPUBG)) {
    const title = extractTitle(it);
    const p = parsePrice(extractPrice(it));
    if(!title || p.value==null){ skip++; continue; }

    const categoryName = decideSplit(title, 'oyunfor-pubgm');

    await upsertAndArchive({
      siteName: 'oyunfor',
      categoryName,
      itemName: title,
      sellPrice: p.raw,
      sellPriceValue: p.value,
      currency: p.currency || 'TRY',
      url: filePath,
    }, { archiveMode: 'always' });

    categoryName.endsWith('global') ? gl++ : tr++;
  }
  console.log(`Oyunfor PUBG upsert: TR=${tr}, GLOBAL=${gl}, skip=${skip}`);
};

/** LOKAL XML → MLBB (TR+GLOBAL split) */
exports.runMLBBSplitLocal = async (filePath) => {
  // 1) önce indir / tazele
  await downloadXmlTo(filePath, { force: process.env.FORCE_DOWNLOAD === '1' });

  // 2) parse & upsert
  const xml = await fs.readFile(filePath,'utf8');
  const parsed = await parseStringPromise(xml, { explicitArray:false });
  const items = toArray(parsed?.rss?.channel?.item);

  let tr=0, gl=0, skip=0;
  for(const it of items.filter(isMLBB)) {
    const title = extractTitle(it);
    const p = parsePrice(extractPrice(it));
    if(!title || p.value==null){ skip++; continue; }

    const categoryName = decideSplit(title, 'oyunfor-mlbb');

    await upsertAndArchive({
      siteName: 'oyunfor',
      categoryName,
      itemName: title,
      sellPrice: p.raw,
      sellPriceValue: p.value,
      currency: p.currency || 'TRY',
      url: filePath,
    }, { archiveMode: 'always' });

    categoryName.endsWith('global') ? gl++ : tr++;
  }
  console.log(`Oyunfor MLBB upsert: TR=${tr}, GLOBAL=${gl}, skip=${skip}`);
};
