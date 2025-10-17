const mongoose = require("mongoose");
const express = require('express');
const helmet = require('helmet');
const app = express();
require('dotenv').config()
const cors = require('cors');

app.use(express.static('public'))
app.set("view engine", "twig");
app.use(helmet({ contentSecurityPolicy: false }));
app.disable("x-powered-by");
app.set('trust proxy', true);

const Item = require("./models/item");
const ItemArchived = require("./models/itemArchived");
const cron = require("node-cron");

// Cron task modülleri
const gamesatis = require("./cronTasks/gamesatis");
const bng = require("./cronTasks/bng");
const vatangame = require("./cronTasks/vatangame");
const foxepin = require("./cronTasks/foxepin");
const kabasakal = require("./cronTasks/kabasakal");
const btkgame = require("./cronTasks/btkgame");
const viora = require("./cronTasks/viora");
const dijipin = require("./cronTasks/dijipin");

const hesapcomtr = require("./cronTasks/hesapcomtr-old");
const perdigital = require("./cronTasks/perdigital-old");
const oyuneks = require("./cronTasks/oyuneks-old");
const oyunfor = require("./cronTasks/oyunfor-old");

app.use(cors({
    origin: 'https://api.dijipin.com',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

const PORT = process.env.PORT || 3000;

mongoose.connect("mongodb://127.0.0.1/diji-price-crawler")
    .then(() => {
        app.listen(PORT, () => console.log(`pf&crawl is running on ${PORT}`));
        console.log("DB Connection is set.");
    })
    .catch(err => console.log("DB error: " + err));

app.get("/", async (req, res) => {
    res.render("index")
});

// ---------- SİTE LABEL/SIRALAMA ----------
const SITE_LABELS = {
    dijipin: "Dijipin",
    gamesatis: "GameSatış",
    bynogame: "ByNoGame",
    vatangame: "VatanGame",
    foxepin: "FoxEpin",
    kabasakalonline: "Kabasakal Online",
    btkgame: "BTK Game",
    vioragame: "Viora Game",
    hesapcomtr: "HesapComTR",
    perdigital: "PerDigital",
    oyuneks: "Oyuneks",
    oyunfor: "Oyunfor",
};
// SIRALAMA: gerçek siteName anahtarlarını kullan
const SITE_ORDER = [
    "dijipin",
    "gamesatis",
    "bynogame",
    "vatangame",
    "foxepin",
    "kabasakalonline",
    "btkgame",
    "vioragame",
    "perdigital",
    "oyuneks",
    "oyunfor",
    "hesapcomtr"
];

// ---------- KATEGORİ GRUPLARI ----------
// MLBB
const MLBB_CATEGORIES = [
    "gamesatis-mlbb-tr", "gamesatis-mlbb-global",
    "hesap-mlbb-tr", "hesap-mlbb-global",
    "vatangame-mlbb-tr", "vatangame-mlbb-global",
    "foxepin-mlbb-tr","foxepin-mlbb-global",
    "bynogame-mlbb-tr", "bynogame-mlbb-global", "bynogame-mlbb-advantage",
    "perdigital-mlbb-tr", "perdigital-mlbb-global",
    "kabasakal-mlbb-tr", "kabasakal-mlbb-global",
    "oyunfor-mlbb-tr", "oyunfor-mlbb-global",
    "oyuneks-mlbb-tr", "oyuneks-mlbb-global",
    "viora-mlbb-tr", "viora-mlbb-global",
    "btkgame-mlbb",
    "dijipin-mlbb-tr", "dijipin-mlbb-global"
];

// PUBG
const PUBG_CATEGORIES = [
    "gamesatis-pubgm",
    "hesap-pubgm-tr", "hesap-pubgm-global",
    "vatangame-pubgm-tr", "vatangame-pubgm-global",
    "bynogame-pubgm",
    "perdigital-pubgm-tr",
    "kabasakal-pubgm-tr",
    "foxepin-pubgm-tr", "foxepin-pubgm-global",
    "oyunfor-pubgm-tr", "oyunfor-pubgm-global",
    "oyuneks-pubgm-tr", "oyuneks-pubgm-global",
    "viora-pubgm-tr", "viora-pubgm-global",
    "btkgame-pubgm-tr", "btkgame-pubgm-global",
    "dijipin-pubgm-tr", "dijipin-pubgm-global"
];

// AOE (Age of Empires Mobile / Doruk Parası)
const AOE_CATEGORIES = [
    "gamesatis-aoem",
    "vatangame-aoem",
    "foxepin-aoem",
    "kabasakal-aoem",
    "btkgame-aoem",
    "viora-aoem",
    "dijipin-aoem-tr", "dijipin-aoem-global",
    "bynogame-aoem"
];

// WARTUNE
const WARTUNE_CATEGORIES = [
    "gamesatis-wartune",
    "vatangame-wartune",
    "foxepin-wartune",
    "kabasakal-wartune",
    "btkgame-wartune",
    "viora-wartune",
    "dijipin-wartune"
];

// WHITEOUT SURVIVAL
const WHITEOUT_CATEGORIES = [
    "gamesatis-whiteout",
    "vatangame-whiteout",
    "foxepin-whiteout",
    "kabasakal-whiteout",
    "btkgame-whiteout",
    "viora-whiteout",
    "dijipin-whiteout",
    "bynogame-whiteout"
];

// Toplam setler
const ALL_CATEGORIES = [
    ...MLBB_CATEGORIES,
    ...PUBG_CATEGORIES,
    ...AOE_CATEGORIES,
    ...WARTUNE_CATEGORIES,
    ...WHITEOUT_CATEGORIES,
];

const MLBB_SET = new Set(MLBB_CATEGORIES);
const PUBG_SET = new Set(PUBG_CATEGORIES);
const AOE_SET = new Set(AOE_CATEGORIES);
const WARTUNE_SET = new Set(WARTUNE_CATEGORIES);
const WHITEOUT_SET = new Set(WHITEOUT_CATEGORIES);

// ---------- Yardımcılar ----------
const normName = (s) =>
    String(s || "")
        .toLowerCase()
        .replace(/\b(tr|türkiye|turkiye|global|world|server|sunucu)\b/g, " ")
        .replace(/[^\w+.\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const sanitizeName = (input) => {
    let s = String(input || '').trim();

    // çöp ifadeler
    s = s.replace(
        /\b(?:E-?P[İI]N KARŞILIĞI|STOK|B[İI]R[İI]M F[İI]YAT|BONUS|ADET|SEPETE EKLE|ÜRÜN\s*F[İI]YATI\s*SEÇ|URUN\s*FIYATI\s*SEC)\b/gi,
        ' '
    );
    s = s.replace(/\bE-?pin\b/gi, ' ');

    // sonda "E-pin 660 PUBG Mobile UC" gibi kuyruklar
    s = s.replace(/\s*(?:E-?pin\s*)?\d+(?:[.,]\d+)?\s*PUBG\s*Mobil(?:e)?\s*UC\s*$/i, '');

    s = s.replace(/\s+/g, ' ').trim();
    return s;
};

const fmtPriceTR = (input) => {
    if (input == null) return null;
    const n = Number(String(input).replace(",", "."));
    if (!Number.isFinite(n)) return null;
    try {
        return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
        return n.toFixed(2).replace(".", ",");
    }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseDateOnly(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
}

// ---------- API ----------
app.get("/getPrices", async (req, res) => {
    try {
        const items = await Item.find(
            { categoryName: { $in: ALL_CATEGORIES } },
            { siteName: 1, categoryName: 1, itemName: 1, sellPrice: 1, sellPriceValue: 1 }
        ).sort({ createdAt: 1 }).lean();

        // 5 oyun için model
        const model = {
            mlbb: { id: "mlbb", label: "Mobile Legends", sites: {} },
            pubgm: { id: "pubgm", label: "PUBG Mobile", sites: {} },
            aoe: { id: "aoe", label: "Age of Empires", sites: {} },
            wartune: { id: "wartune", label: "Wartune Ultra", sites: {} },
            whiteout: { id: "whiteout", label: "Whiteout Survival", sites: {} },
        };

        for (const it of items) {
            const cat = it.categoryName || "";
            let game = null;
            if (MLBB_SET.has(cat)) game = "mlbb";
            else if (PUBG_SET.has(cat)) game = "pubgm";
            else if (AOE_SET.has(cat)) game = "aoe";
            else if (WARTUNE_SET.has(cat)) game = "wartune";
            else if (WHITEOUT_SET.has(cat)) game = "whiteout";
            if (!game) continue;

            const region = /global/i.test(cat) ? "global" : "tr";
            const siteId = String(it.siteName || "").toLowerCase();
            const siteLabel = SITE_LABELS[siteId] || it.siteName || siteId || "Bilinmeyen";

            if (!model[game].sites[siteId]) {
                model[game].sites[siteId] = { id: siteId, label: siteLabel, _rows: new Map() };
            }
            const group = model[game].sites[siteId];

            const key = normName(it.itemName);
            const row = group._rows.get(key) || { name: sanitizeName(it.itemName), tr: null, global: null };

            const priceNum = Number(String((it.sellPriceValue ?? it.sellPrice) ?? "").replace(",", "."));
            const priceStr =
                fmtPriceTR(Number.isFinite(priceNum) ? priceNum : it.sellPrice) ||
                (it.sellPrice ?? "").replace(".", ",");

            if (region === "tr") row.tr = priceStr || row.tr;
            else row.global = priceStr || row.global;

            group._rows.set(key, row);
        }

        // Map -> array + sıralamalar
        const finalizeSites = (sitesObj) => {
            const ids = Object.keys(sitesObj).sort(
                (a, b) => SITE_ORDER.indexOf(a) - SITE_ORDER.indexOf(b)
            );
            return ids.map((sid) => {
                const site = sitesObj[sid];
                const rows = Array.from(site._rows.values()).sort((a, b) => {
                    const av = Number(String(a.tr || a.global || "").replace(",", "."));
                    const bv = Number(String(b.tr || b.global || "").replace(",", "."));
                    if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
                    return String(a.name).localeCompare(String(b.name), "tr");
                });
                return { id: site.id, label: site.label, rows };
            });
        };

        const categories = [
            { id: model.mlbb.id, label: model.mlbb.label, sites: finalizeSites(model.mlbb.sites) },
            { id: model.pubgm.id, label: model.pubgm.label, sites: finalizeSites(model.pubgm.sites) },
            { id: model.aoe.id, label: model.aoe.label, sites: finalizeSites(model.aoe.sites) },
            { id: model.wartune.id, label: model.wartune.label, sites: finalizeSites(model.wartune.sites) },
            { id: model.whiteout.id, label: model.whiteout.label, sites: finalizeSites(model.whiteout.sites) },
        ];

        // res.status(200).json({ categories });
        res.render("prices", {
            categories: categories,
            categoriesJson: JSON.stringify(categories)
        });
    } catch (err) {
        console.error("Front render hatası:", err?.message || err);
        res.status(500).send("Hata");
    }
});

// ---------- PIPELINE ----------
const pipeline = [
    // {
    //     name: "GameSatış (TR+GLOBAL)",
    //     run: () => gamesatis.run([
    //         { url: "https://www.gamesatis.com/mobile-legends-elmas-tr", categoryName: "gamesatis-mlbb-tr" },
    //         { url: "https://www.gamesatis.com/mobile-legends-elmas-global", categoryName: "gamesatis-mlbb-global" },
    //         { url: "https://www.gamesatis.com/pubg-mobile-uc", categoryName: "gamesatis-pubgm" },
    //         { url: "https://www.gamesatis.com/age-of-empires-mobile", categoryName: "gamesatis-aoem" },
    //         { url: "https://www.gamesatis.com/wartune-ultra-elmas-yildiz-parasi", categoryName: "gamesatis-wartune" },
    //         { url: "https://www.gamesatis.com/whiteout-survival", categoryName: "gamesatis-whiteout" },
    //     ]),
    // },
    // {
    //     name: "bynogame",
    //     run: () => bng.run([
    //         { url: "https://www.bynogame.com/tr/oyunlar/mobile-legends/mobile-legends-turkiye", categoryName: "bynogame-mlbb-tr" },
    //         { url: "https://www.bynogame.com/tr/oyunlar/mobile-legends/mobile-legends-global", categoryName: "bynogame-mlbb-global" },
    //         { url: "https://www.bynogame.com/tr/oyunlar/mobile-legends/mobile-legends-elmas-avantajli-fiyat", categoryName: "bynogame-mlbb-advantage" },
    //         { url: "https://www.bynogame.com/tr/oyunlar/pubg/pubg-mobile-uc", categoryName: "bynogame-pubgm" },
    //         { url: "https://www.bynogame.com/tr/oyunlar/age-of-empires-mobile/age-of-empires-apex", categoryName: "bynogame-aoem" },
    //         { url: "https://www.bynogame.com/tr/oyunlar/whiteout-survival", categoryName: "bynogame-whiteout" },
    //     ]),
    // },
    // {
    //     name: "VatanGame",
    //     run: () => vatangame.run([
    //         { url: "https://vatangame.com/oyunlar/mobile-legends-bang-bang-elmas", categoryName: "vatangame-mlbb-tr" },
    //         { url: "https://vatangame.com/oyunlar/mobile-legends-bang-bang-elmas-global", categoryName: "vatangame-mlbb-global" },
    //         { url: "https://vatangame.com/oyunlar/pubg-mobile-uc-tr", categoryName: "vatangame-pubgm-tr" },
    //         { url: "https://vatangame.com/oyunlar/age-of-empires-mobile-doruk-parasi", categoryName: "vatangame-aoem" },
    //         { url: "https://vatangame.com/oyunlar/wartune-ultra", categoryName: "vatangame-wartune" },
    //         { url: "https://vatangame.com/oyunlar/whiteout-survival-frost-star", categoryName: "vatangame-whiteout" },
    //     ]),
    // },
    // {
    //     name: "FoxEpin",
    //     run: () => foxepin.run([
    //         { url: "https://www.foxepin.com/game/pubg-mobile/tr-id-yukleme", categoryName: "foxepin-pubgm-tr" },
    //         { url: "https://www.foxepin.com/game/pubg-mobile/global-id-yukleme", categoryName: "foxepin-pubgm-global" },
    //         { url: "https://www.foxepin.com/game/mobile-legends/mobile-legends-turkiye", categoryName: "foxepin-mlbb-tr" },
    //         { url: "https://www.foxepin.com/game/mobile-legends/mobile-legends-turkiye-elmas", categoryName: "foxepin-mlbb-global" },
    //         { url: "https://www.foxepin.com/game/age-of-empires-mobile/age-of-empires-mobile-token", categoryName: "foxepin-aoem" },
    //         { url: "https://www.foxepin.com/game/whiteout-survival/whiteout-survival", categoryName: "foxepin-whiteout" },
    //     ]),
    // },

    // {
    //     name: "Kabasakal",
    //     run: () => kabasakal.run([
    //         { url: "https://kabasakalonline.com/urunler/106/pubg-mobile", categoryName: "kabasakal-pubgm-tr" },
    //         { url: "https://kabasakalonline.com/urunler/127/mobile-legends-elmas-tr", categoryName: "kabasakal-mlbb-tr" },
    //         { url: "https://kabasakalonline.com/urunler/239/mobile-legends-global-elmas", categoryName: "kabasakal-mlbb-global" },
    //         { url: "https://kabasakalonline.com/urunler/1494/age-of-empires-mobile-doruk-parasi", categoryName: "kabasakal-aoem" },
    //         { url: "https://kabasakalonline.com/urunler/1594/wartune-ultra", categoryName: "kabasakal-wartune" },
    //         { url: "https://kabasakalonline.com/urunler/1034/whiteout-survival", categoryName: "kabasakal-whiteout" },
    //     ]),
    // },
    
    // {
    //     name: "BTKGame",
    //     run: () => btkgame.run([
    //         { url: "https://www.btkgame.com/pubg-mobile-uc-c-6", categoryName: "btkgame-pubgm-tr" },
    //         { url: "https://www.btkgame.com/pubg-mobile-uc-global-id-yukleme-c-172", categoryName: "btkgame-pubgm-global" },
    //         { url: "https://www.btkgame.com/mobile-legends-elmas-tr-c-10", categoryName: "btkgame-mlbb" },
    //         { url: "https://www.btkgame.com/age-of-empires-mobile-doruk-parasi-token-c-157", categoryName: "btkgame-aoem" },
    //         { url: "https://www.btkgame.com/wartune-ultra-yildiz-parasi-c-168", categoryName: "btkgame-wartune" },
    //         { url: "https://www.btkgame.com/whiteout-survival-frost-star-c-81", categoryName: "btkgame-whiteout" },
    //     ]),
    // },
    // {
    //     name: "VioraGame",
    //     run: () => viora.run([
    //         { url: "https://www.vioragame.com/pubg-mobile", categoryName: "viora-pubgm-tr" },
    //         { url: "https://www.vioragame.com/pubg-mobile-uc-global-top-up", categoryName: "viora-pubgm-global" },
    //         { url: "https://www.vioragame.com/mobile-legends-elmas-tr", categoryName: "viora-mlbb-tr" },
    //         { url: "https://www.vioragame.com/mobile-legends-bang-bang-elmas", categoryName: "viora-mlbb-global" },
    //         { url: "https://www.vioragame.com/age-of-empires-mobile-doruk-parasi", categoryName: "viora-aoem" },
    //         { url: "https://www.vioragame.com/wartune-ultra-yildiz-parasi", categoryName: "viora-wartune" },
    //         { url: "https://www.vioragame.com/whiteout-survival-frost-star", categoryName: "viora-whiteout" },
    //     ]),
    // },
    // {
    //     name: "Dijipin",
    //     run: () => dijipin.run([
    //         { url: "https://www.dijipin.com/pubg-uc-top-up-turkey-c-165", categoryName: "dijipin-pubgm-tr" },
    //         { url: "https://www.dijipin.com/pubg-id-yukleme-global-c-208", categoryName: "dijipin-pubgm-global" },
    //         { url: "https://www.dijipin.com/mobile-legends--c-170", categoryName: "dijipin-mlbb-tr" },
    //         { url: "https://www.dijipin.com/age-of-empires-mobile-doruk-parasi-token--c-367", categoryName: "dijipin-aoem-tr" },
    //         { url: "https://www.dijipin.com/age-of-empires-mobile-doruk-parasi-global-token--c-396", categoryName: "dijipin-aoem-global" },
    //         { url: "https://www.dijipin.com/wartune-ultra-yildiz-parasi-c-413", categoryName: "dijipin-wartune" },
    //         { url: "https://www.dijipin.com/whiteout-survival-c-253", categoryName: "dijipin-whiteout" },
    //     ]),
    // },
];

// ---------- ÇALIŞTIRICI ----------

// cron.schedule("*/30 * * * *", () => {
//   runAllOnce().catch(e => console.error("cron hata:", e));
// }, { scheduled: true, timezone: "Europe/Istanbul" });

// runAllOnce().catch(e => console.error("cron hata:", e));

async function runAllOnce(selected = []) {
    const list = selected.length
        ? pipeline.filter(p => selected.includes(p.name) || selected.includes(p.name.split(" ")[0].toLowerCase()))
        : pipeline;

    for (const task of list) {
        const t0 = Date.now();
        console.log(`\n▶ ${task.name} başlıyor`);
        try {
            await task.run();
            console.log(`✓ ${task.name} bitti (${((Date.now() - t0) / 1000).toFixed(1)} sn)`);
        } catch (err) {
            console.error(`✗ ${task.name} hata:`, err?.message || err);
        }
        await sleep(3000);
    }
    console.log("\n✔ Tüm işler tamam.");
}
