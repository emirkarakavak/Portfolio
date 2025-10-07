// cronTasks/oyunfor.js

const xml2js = require("xml2js");
const { upsertAndArchive } = require("../lib/persist");

/**
 * Oyunfor Criteo feed'inden (XML) ürünleri çekip DB'ye basar.
 * @param {string} url - XML feed URL'i (örn: https://www.oyunfor.com/criteofeed)
 * @param {string} categoryName - İçeride etiketlenecek kategori (örn: 'oyunfor-pubgm-tr')
 * @param {object} [opts]
 * @param {('PUBG Mobile UC'|'Mobile Legends Bang Bang Elmas'|string)} [opts.productType] - g:product_type filtresi
 */
exports.run = async (url, categoryName, opts = {}) => {
  if (!url || !categoryName) throw new Error("url ve categoryName zorunlu.");
  const productTypeFilter = opts.productType || "PUBG Mobile UC"; // default PUBG

  // Node 18+’da fetch global. Daha eski Node sürümü kullanıyorsan node-fetch ekle.
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
      Referer: url,
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} - ${res.statusText} — ${url}`);
  }

  const xml = await res.text();

  // Parse
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xml);

  // Beklenen yapı: rss.channel.item
  const items = result?.rss?.channel?.item;
  if (!items) {
    console.warn("Uyarı: feed içinde item bulunamadı.");
    return;
  }
  const arr = Array.isArray(items) ? items : [items];

  // Filtrele → g:product_type
  const filtered = arr.filter((it) => it["g:product_type"] === productTypeFilter);

  // Upsert
  for (const it of filtered) {
    const title = (it?.title || "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    // g:price ör: "15.00 TL" → "15.00"
    const rawPrice = (it?.["g:price"] || "").replaceAll(" TL", "").trim();
    if (!rawPrice) continue;

    // numerik value (varsa)
    const sellPriceValue = (() => {
      const n = parseFloat(String(rawPrice).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    })();

    await upsertAndArchive(
      {
        siteName: "oyunfor",
        categoryName,
        itemName: title,
        sellPrice: rawPrice, // "15.00" gibi
        sellPriceValue,
        currency: "₺",
        url, // kaynak olarak feed URL
      },
      { archiveMode: "always" } // istersen "price-change" yaparsın
    );

    console.log(`Upsert: [${categoryName}] ${title} -> ${rawPrice}`);
  }
};
