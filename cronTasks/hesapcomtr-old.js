// scrape_text_sitemap.js
const axios = require('axios');

const CATEGORY = 'https://hesap.com.tr/urunler/pubg-mobile-uc-satin-al';
const toText = (url) => 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//, '');

const norm = s => (s || '').replace(/\s+/g, ' ').trim();

// çok esnek fiyat kalıpları
const PRICE_RES = [
  /(₺\s*)?(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.]\d{2}\s*TL/gi,
  /₺\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.]\d{2}/gi,
  /(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.]\d{2}\s*₺/gi,
  /(\d{1,3}(?:[.\s]\d{3})*|\d+)\s*TL\b/gi,
  /₺\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)\b/gi
];

// ürün adı (PUBG … UC) — geniş
const NAME_RE = /PUBG\s*Mobile?[^,\n]{0,160}?\b(\d{1,5}(?:[.\s]\d{3})?)\s*UC\b/gi;

function priceToNumber(p) {
  // "₺ 1.234,56" -> 1234.56 | "1 234 TL" -> 1234
  const cleaned = p.replace(/[^\d,.\s]/g, '').replace(/\s+/g, ' ').trim();
  let num = cleaned.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '');
  if (/,/.test(num)) num = num.replace(',', '.');
  const v = parseFloat(num);
  return Number.isFinite(v) ? v : null;
}

async function fetchText(url) {
  const textURL = toText(url);
  const { data } = await axios.get(textURL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/plain,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
    },
    timeout: 60000,
  });
  if (typeof data !== 'string') throw new Error('metin alınamadı: ' + url);
  return data;
}

function extractByRegexList(regexList, text) {
  const out = [];
  for (const re of regexList) {
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    re.lastIndex = 0;
  }
  return out;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function extractProductLinksFromText(text) {
  // metindeki linkleri topla (hem tam hem göreli)
  const links = text.match(/https?:\/\/hesap\.com\.tr\/[^\s"')<]+|\/[^\s"')<]+/gi) || [];
  const normalized = links.map(h => h.startsWith('http') ? h : 'https://hesap.com.tr' + h);
  // sadece /urun/ içerenler
  const filtered = normalized.filter(u => /https?:\/\/hesap\.com\.tr\/urun\//i.test(u));
  return unique(filtered);
}

async function fetchSitemapURLs() {
  const root = 'https://hesap.com.tr/sitemap.xml';
  const rootText = await fetchText(root);
  // root sitemap içinden alt sitemap linkleri ve doğrudan url'leri topla
  const siteMaps = unique((rootText.match(/https?:\/\/hesap\.com\.tr\/[^\s<"]+\.xml/gi) || []).map(norm));
  const allXmls = siteMaps.length ? siteMaps : [root];

  let urls = [];
  for (const xmlUrl of allXmls) {
    const t = await fetchText(xmlUrl);
    const found = t.match(/https?:\/\/hesap\.com\.tr\/[^\s<"]+/gi) || [];
    urls = urls.concat(found);
  }
  // sadece ürün linkleri
  urls = urls.filter(u => /https?:\/\/hesap\.com\.tr\/urun\//i.test(u));
  // PUBG/UC ile ilgili olanları öne çek
  const preferred = urls.filter(u => /(pubg|uc)/i.test(u));
  return unique(preferred.length ? preferred : urls);
}

async function extractFromProduct(url) {
  const txt = await fetchText(url);

  // isim: önce başlık satırı (r.jina.ai genelde en üstte # Title verir)
  let name = null;
  const titleMatch = txt.match(/^#\s*(.+)$/m);
  if (titleMatch) {
    const t = norm(titleMatch[1]);
    if (/pubg|uc/i.test(t)) name = t;
  }
  // yoksa NAME_RE
  if (!name) {
    const names = [];
    let m;
    while ((m = NAME_RE.exec(txt)) !== null) names.push(norm(m[0]));
    NAME_RE.lastIndex = 0;
    if (names.length) name = names[0];
  }

  // fiyat adayları
  const prices = extractByRegexList(PRICE_RES, txt).map(norm);

  if (!name || !prices.length) return null;

  const sorted = prices
    .map(p => ({ p, n: priceToNumber(p) }))
    .filter(x => x.n !== null)
    .sort((a, b) => a.n - b.n);

  if (!sorted.length) return null;

  return { name, price: sorted[0].p, url };
}

(async () => {
  try {
    // 1) Kategori metninden link dene
    let links = [];
    try {
      const catText = await fetchText(CATEGORY);
      links = extractProductLinksFromText(catText);
    } catch (_) {
      links = [];
    }

    // 2) Yoksa sitemap
    if (!links.length) {
      links = await fetchSitemapURLs();
      // çok fazla gelirse ilk 100’e kes
      if (links.length > 100) links = links.slice(0, 100);
    }

    if (!links.length) {
      console.error('Ürün linki bulunamadı.');
      process.exit(1);
    }

    // 3) Her ürün sayfasından isim+fiyat çek
    const results = [];
    for (const u of links) {
      try {
        const item = await extractFromProduct(u);
        if (item && /pubg|uc/i.test(item.name)) results.push(item);
      } catch (_) { /* yoksay */ }
    }

    if (!results.length) {
      console.error('Hiç fiyat bulunamadı.');
      process.exit(1);
    }

    // 4) Tekrarları atıp yaz
    const seen = new Set();
    for (const r of results) {
      const key = (r.name + '|' + r.price).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`${r.name} -> ${r.price}`);
      // istersen link de bas:
      // console.log(`${r.name} -> ${r.price} (${r.url})`);
    }
  } catch (e) {
    console.error('Hata:', e.message || e);
    process.exit(1);
  }
});
