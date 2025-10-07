// cronTasks/oyuneks.js

const xml2js = require("xml2js");
const { upsertAndArchive } = require("../lib/persist");

exports.run = async (url, categoryName, opts = {}) => {
  if (!url || !categoryName) throw new Error("url ve categoryName zorunlu.");
  const brandFilter = opts.brand || "PUBG Mobile"; // default PUBG

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
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xml);

  const items = result?.rss?.channel?.item;
  if (!items) {
    console.warn("Uyarı: feed içinde item yok.");
    return;
  }
  const arr = Array.isArray(items) ? items : [items];

  // Filtrele brand
  const filtered = arr.filter((it) => it["g:brand"] === brandFilter);

  for (const it of filtered) {
    const title = (it?.["g:title"] || "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    // g:price → ör: "12.00 TL"
    const rawPrice = (it?.["g:price"] || "").replaceAll(" TL", "").trim();
    if (!rawPrice) continue;

    const sellPriceValue = (() => {
      const n = parseFloat(String(rawPrice).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    })();

    await upsertAndArchive(
      {
        siteName: "oyuneks",
        categoryName,
        itemName: title,
        sellPrice: rawPrice,
        sellPriceValue,
        currency: "₺",
        url,
      },
      { archiveMode: "always" }
    );

    console.log(`Upsert: [${categoryName}] ${title} -> ${rawPrice}`);
  }
};
