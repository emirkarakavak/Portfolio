// lib/persist.js
const Item = require("../models/item");
let ItemArchived;
try {
  ItemArchived = require("../models/itemArchived");
} catch (e) {
  console.warn("[persist] ItemArchived modeli yüklenemedi:", e?.message || e);
  ItemArchived = null;
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Upsert + (opsiyonel) arşiv.
 * options.archiveMode: "none" | "price-change" | "always"
 * options.debug: true -> ayrıntılı log
 *
 * Mantık:
 * 1) prev = findOne(filter)
 * 2) updateOne(filter, update, { upsert: true })
 * 3) archive:
 *    - always: prev varsa arşive yaz (ilk insert'te prev yok → yazılmaz)
 *    - price-change: prev varsa ve fiyat değiştiyse yaz
 */
exports.upsertAndArchive = async (doc, options = {}) => {
  const {
    siteName, categoryName, itemName,
    sellPrice, sellPriceValue, currency, url,
  } = doc;

  const archiveMode = options.archiveMode || "price-change";
  const debug = !!options.debug;

  const filter = {
    siteName: norm(siteName),
    categoryName: norm(categoryName),
    itemName: norm(itemName),
  };

  const newSellPrice = norm(sellPrice);
  const update = {
    $set: {
      sellPrice: newSellPrice,
      sellPriceValue: Number.isFinite(+sellPriceValue) ? +sellPriceValue : null,
      currency: currency || "₺",
      url,
      updatedAt: new Date(),
    },
    $setOnInsert: { createdAt: new Date() },
  };

  // 1) Eskiyi oku (snapshot için GARANTİ)
  const prev = await Item.findOne(filter).lean();

  // 2) Upsert
  const updRes = await Item.updateOne(filter, update, { upsert: true });
  const inserted = !!(updRes?.upsertedCount);
  const updated = !!(updRes?.modifiedCount) || (!inserted && !!updRes?.matchedCount);

  if (debug) {
    console.log("[persist] upsert:", { inserted, updated, matched: updRes?.matchedCount });
    console.log("[persist] prevPrice:", prev?.sellPrice, "| newPrice:", newSellPrice);
  }

  // 3) Arşiv kararı
  if (!ItemArchived) {
    if (debug) console.log("[persist] ItemArchived modeli yok; arşiv atlandı.");
    return { inserted, updated, previous: prev };
  }

  const havePrev = !!prev;
  const priceChanged = havePrev && norm(prev.sellPrice) !== newSellPrice;

  const shouldArchive =
    (archiveMode === "always" && havePrev) ||
    (archiveMode === "price-change" && priceChanged);

  if (shouldArchive) {
    try {
      await ItemArchived.create({
        siteName: prev.siteName,
        categoryName: prev.categoryName,
        itemName: prev.itemName,
        sellPrice: prev.sellPrice,
        createdAt: new Date("2025-08-27T08:18:19.885+00:00")
        // gerekirse sellPriceValue/currency de ekleyebilirsin
      });
      if (debug) console.log("[persist] archived prev snapshot.");
    } catch (e) {
      console.warn("[persist] Arşiv yazılamadı:", e?.message || e);
    }
  } else if (debug) {
    console.log("[persist] archive skipped — mode:", archiveMode, "havePrev:", havePrev, "priceChanged:", priceChanged);
  }

  return { inserted, updated, previous: prev };
};
