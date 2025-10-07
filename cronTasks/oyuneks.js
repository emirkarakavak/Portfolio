// cronTasks/oyuneks.js
const fs = require('fs/promises');
const { parseStringPromise } = require('xml2js');
const { upsertAndArchive } = require('../lib/persist');

function toArray(x){ return Array.isArray(x) ? x : (x ? [x] : []); }

/** Objede "g:field", "field", "{ns}field" fark etmeksizin alanı yakala */
function getField(obj, fieldName) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[fieldName] !== undefined) return obj[fieldName];
  // brand, price, title gibi alanlar "g:brand" ya da "ns:brand" olabilir
  const key = Object.keys(obj).find(k => {
    if (k === fieldName) return true;
    // "g:brand" -> brand / "{http://...}brand" -> brand
    const noNs = k.includes(':') ? k.split(':').pop() : k;
    const brace = noNs.includes('}') ? noNs.split('}').pop() : noNs;
    return brace === fieldName;
  });
  return key ? obj[key] : undefined;
}

/** "123.45 TRY" | "123,45 ₺" | "₺123,45" -> {raw,value,currency} */
function parsePrice(raw){
  if(!raw) return { raw:null, value:null, currency:null };
  let s = String(raw).trim();
  let currency = null;
  if (/\bTRY\b/i.test(s) || /₺/.test(s)) currency = 'TRY';
  else if (/\bUSD\b/i.test(s) || /\$/.test(s)) currency = 'USD';
  else if (/\bEUR\b/i.test(s) || /€/.test(s)) currency = 'EUR';

  const numStr = s
    .replace(/[^\d.,-]/g, '')
    .replace(/\.(?=.*\.)/g, '')
    .replace(',', '.');
  const value = Number.parseFloat(numStr);
  return { raw:s, value: Number.isFinite(value) ? value : null, currency };
}

function decidePUBGCategory(title){
  const t = (title || '').toLowerCase();
  return t.includes('global') ? 'oyuneks-pubgm-global' : 'oyuneks-pubgm-tr';
}

function decideMLBBCategory(title){
  const t = (title || '').toLowerCase();
  // global varyasyonları
  return t.includes('global') ? 'oyuneks-mlbb-global' : 'oyuneks-mlbb-tr';
}


/** Brand string’ini normalize et (ns fark etmez) */
function extractBrand(it){
  const b = getField(it, 'g:brand') ?? getField(it, 'brand');
  return (b || '').toString().trim();
}
function extractTitle(it){
  const t = getField(it, 'g:title') ?? it.title;
  return (t || '').toString().replace(/\s+/g,' ').trim();
}
function extractPrice(it){
  return getField(it, 'g:price') ?? it.price ?? '';
}

/** Lokal XML’den PUBG (TR+GLOBAL) */
exports.runPUBGSplit = async (filePath) => {
  if (!filePath) throw new Error('filePath zorunlu.');

  const xmlText = await fs.readFile(filePath, 'utf8');
  const parsed = await parseStringPromise(xmlText, { explicitArray:false });

  const items = toArray(parsed?.rss?.channel?.item);

  // Brand: PUBG Mobile (contains / case-insensitive; varyasyonlara takılma)
  const pubgItems = items.filter(it => {
    const brand = extractBrand(it).toLowerCase();
    const title = extractTitle(it).toLowerCase();
    return brand.includes('pubg') || title.includes('pubg mobile');
  });

  let trCount = 0, globalCount = 0, skipped = 0;

  for (const it of pubgItems) {
    const title = extractTitle(it);
    const p = parsePrice(extractPrice(it));
    if (!title || p.value == null) { skipped++; continue; }

    const categoryName = decidePUBGCategory(title);

    await upsertAndArchive(
      {
        siteName: 'oyuneks',
        categoryName,
        itemName: title,
        sellPrice: p.raw,
        sellPriceValue: p.value,
        currency: p.currency || 'TRY',
        url: it.link || filePath,
      },
      { archiveMode: 'always' }
    );

    if (categoryName === 'oyuneks-pubgm-global') globalCount++; else trCount++;
  }

  console.log(`PUBG upsert tamam: TR=${trCount}, GLOBAL=${globalCount}, skip=${skipped}`);
};

/** Lokal XML’den MLBB (tek kategori) */
exports.runMLBBSplit = async (filePath) => {
  if (!filePath) throw new Error('filePath zorunlu.');

  const xmlText = await fs.readFile(filePath, 'utf8');
  const parsed = await parseStringPromise(xmlText, { explicitArray:false });

  const items = toArray(parsed?.rss?.channel?.item);

  // MLBB item’larını tespit (brand/title toleranslı)
  const mlbbItems = items.filter(it => {
    const brand = extractBrand(it).toLowerCase();
    const title = extractTitle(it).toLowerCase();
    return (
      brand.includes('mobile legends') ||
      title.includes('mobile legends') ||
      title.includes('mlbb')
    );
  });

  let trCount = 0, globalCount = 0, skipped = 0;

  for (const it of mlbbItems) {
    const title = extractTitle(it);
    const p = parsePrice(extractPrice(it));
    if (!title || p.value == null) { skipped++; continue; }

    const categoryName = decideMLBBCategory(title);

    await upsertAndArchive(
      {
        siteName: 'oyuneks',
        categoryName,              // <-- burada TR / GLOBAL otomatik seçiliyor
        itemName: title,
        sellPrice: p.raw,
        sellPriceValue: p.value,
        currency: p.currency || 'TRY',
        url: it.link || filePath,
      },
      { archiveMode: 'always' }
    );

    if (categoryName === 'oyuneks-mlbb-global') globalCount++; else trCount++;
  }

  console.log(`MLBB upsert tamam: TR=${trCount}, GLOBAL=${globalCount}, skip=${skipped}`);
};

/** Eski runMany geriye dönük kalsın (brand adıyla filtrelemek isteyen olursa) */
exports.runMany = async (filePath, jobs = []) => {
  for (const j of jobs) {
    const name = (j.brand || '').toLowerCase();
    if (name.includes('mobile legends')) {
      await exports.runMLBB(filePath, j.categoryName);
    } else if (name.includes('pubg')) {
      await exports.runPUBGSplit(filePath); // pubg için split’i çalıştır
    } else {
      // generic brand filtresi (gerekirse)
      await exports._runGeneric(filePath, j.categoryName, j.brand);
    }
  }
};

/** Gerekirse generic brand filtresi (opsiyonel) */
exports._runGeneric = async (filePath, categoryName, brandFilter) => {
  const xmlText = await fs.readFile(filePath, 'utf8');
  const parsed = await parseStringPromise(xmlText, { explicitArray:false });
  const items = toArray(parsed?.rss?.channel?.item);

  const filtered = brandFilter
    ? items.filter(it => extractBrand(it).toLowerCase().includes(String(brandFilter).toLowerCase()))
    : items;

  let cnt = 0;
  for (const it of filtered) {
    const title = extractTitle(it);
    const p = parsePrice(extractPrice(it));
    if (!title || p.value == null) continue;

    await upsertAndArchive(
      {
        siteName: 'oyuneks',
        categoryName,
        itemName: title,
        sellPrice: p.raw,
        sellPriceValue: p.value,
        currency: p.currency || 'TRY',
        url: it.link || filePath,
      },
      { archiveMode: 'always' }
    );
    cnt++;
  }
  console.log(`Generic upsert: [${categoryName}] ${cnt} kayıt (brand="${brandFilter||'—'}")`);
};
