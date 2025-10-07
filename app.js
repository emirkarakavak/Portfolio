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
const bng = require("./cronTasks/bng");
const gamesatis = require("./cronTasks/gamesatis");
const hesapcomtr = require("./cronTasks/hesapcomtr");
const perdigital = require("./cronTasks/perdigital");
const vatangame = require("./cronTasks/vatangame");
const kabasakal = require("./cronTasks/kabasakal");
const oyuneks = require("./cronTasks/oyuneks");
const oyunfor = require("./cronTasks/oyunfor");

app.use(cors({
    origin: 'https://api.dijipin.com',                // gerekiyorsa belirli domain koy
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

const PORT = process.env.PORT || 3000

mongoose.connect("mongodb://127.0.0.1/diji-price-crawler")
    .then(() => {
        app.listen(PORT, () => console.log(`pf&crawl is running on ${PORT}`));
        console.log("DB Connection is set.");
    })
    .catch(err => console.log("DB error: " + err));

app.get("/", async (req, res) => {
    res.render("index")
})


app.get("/getPrices", async (req, res) => {
    try {
        // Index kullanır: categoryName $in
        const items = await Item.find(
            { categoryName: { $in: ALL_CATEGORIES } },
            { siteName: 1, categoryName: 1, itemName: 1, sellPrice: 1, sellPriceValue: 1 } // projection
        ).sort({ createdAt: 1 }).lean();

        const model = {
            mlbb: { id: "mlbb", label: "Mobile Legends", sites: {} },
            pubgm: { id: "pubgm", label: "Pubg Mobile", sites: {} },
        };

        for (const it of items) {
            const cat = it.categoryName || "";
            const game = MLBB_SET.has(cat) ? "mlbb" : (PUBG_SET.has(cat) ? "pubgm" : null);
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

            const priceNum = Number(
                String((it.sellPriceValue ?? it.sellPrice) ?? "").replace(",", ".")
            );
            const priceStr =
                fmtPriceTR(Number.isFinite(priceNum) ? priceNum : it.sellPrice) ||
                (it.sellPrice ?? "").replace(".", ",");

            if (region === "tr") row.tr = priceStr || row.tr;
            else row.global = priceStr || row.global;

            group._rows.set(key, row);
        }

        // Map → Array ve sıralamalar
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
        ];

        // res.status(200).json({ categories });
        res.render("prices", { categories });
    } catch (err) {
        console.error("Front render hatası:", err?.message || err);
        res.status(500).send("Hata");
    }
});



// Görünen site adları ve sıralama
const SITE_LABELS = {
    gamesatis: "GameSatış",
    hesapcomtr: "HesapComTR",
    vatangame: "VatanGame",
    bynogame: "ByNoGame",
    perdigital: "PerDigital",
    kabasakalonline: "Kabasakal Online",
    oyuneks: "Oyuneks",
    oyunfor: "Oyunfor",
};
const SITE_ORDER = ["gamesatis", "hesapcomtr", "vatangame", "bynogame", "perdigital", "kabasakal", "oyuneks", "oyunfor"];

const MLBB_CATEGORIES = [
    "gamesatis-mlbb-tr", "gamesatis-mlbb-global",
    "hesap-mlbb-tr", "hesap-mlbb-global",
    "vatangame-mlbb-tr", "vatangame-mlbb-global",
    "bynogame-mlbb-tr", "bynogame-mlbb-global",
    "perdigital-mlbb-tr", "perdigital-mlbb-global",
    "kabasakal-mlbb-tr", "kabasakal-mlbb-global",
    "oyunfor-mlbb-tr", "oyunfor-mlbb-global",
    "oyuneks-mlbb-tr", "oyuneks-mlbb-global"
];
const PUBG_CATEGORIES = [
    "gamesatis-pubgm",
    "hesap-pubgm-tr", "hesap-pubgm-global",
    "vatangame-pubgm-tr", "vatangame-pubgm-global",
    "bynogame-pubgm",
    "perdigital-pubgm-tr",
    "kabasakal-pubgm-tr",
    "oyunfor-pubgm-tr", "oyunfor-pubgm-global",
    "oyuneks-pubgm-tr", "oyuneks-pubgm-global",
];
const ALL_CATEGORIES = [...MLBB_CATEGORIES, ...PUBG_CATEGORIES];
const MLBB_SET = new Set(MLBB_CATEGORIES);
const PUBG_SET = new Set(PUBG_CATEGORIES);
// ---- Yardımcılar ----
const normName = (s) =>
    String(s || "")
        .toLowerCase()
        .replace(/\b(tr|türkiye|turkiye|global|world|server|sunucu)\b/g, " ")
        .replace(/[^\w+.\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const sanitizeName = (input) => {
    let s = String(input || '').trim();

    // 1) Çöp ifadeler (tamamlama: Ürün Fiyatı Seç)
    s = s.replace(
        /\b(?:E-?P[İI]N KARŞILIĞI|STOK|B[İI]R[İI]M F[İI]YAT|BONUS|ADET|SEPETE EKLE|ÜRÜN\s*F[İI]YATI\s*SEÇ|URUN\s*FIYATI\s*SEC)\b/gi,
        ' '
    );

    // 2) Tek başına geçen "E-pin" kelimesini temizle
    s = s.replace(/\bE-?pin\b/gi, ' ');

    // 3) Sondaki "E-pin 660 PUBG Mobil(e) UC" benzeri kuyrukları temizle
    s = s.replace(/\s*(?:E-?pin\s*)?\d+(?:[.,]\d+)?\s*PUBG\s*Mobil(?:e)?\s*UC\s*$/i, '');

    // 4) Fazla boşlukları toparla
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

function parseDateOnly(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
}




const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pipeline = [
    {
        name: "bynogame mlbb TR",
        run: () => bng.run(
            "https://www.bynogame.com/tr/oyunlar/mobile-legends/mobile-legends-turkiye",
            "bynogame-mlbb-tr"
        ),
    },
    {
        name: "bynogame mlbb GLOBAL",
        run: () => bng.run(
            "https://www.bynogame.com/tr/oyunlar/mobile-legends/mobile-legends-global",
            "bynogame-mlbb-global"
        ),
    },
    {
        name: "bynogame GLOBAL",
        run: () => bng.run(
            "https://www.bynogame.com/tr/oyunlar/pubg/pubg-mobile-uc",
            "bynogame-pubgm"
        ),
    },
    {
        name: "GameSatış (TR+GLOBAL)",
        run: () => gamesatis.run([
            { url: "https://www.gamesatis.com/mobile-legends-elmas-tr", categoryName: "gamesatis-mlbb-tr" },
            { url: "https://www.gamesatis.com/mobile-legends-elmas-global", categoryName: "gamesatis-mlbb-global" },
            { url: "https://www.gamesatis.com/pubg-mobile-uc", categoryName: "gamesatis-pubgm" },
        ]),
    },
    // {
    //     name: "Hesap.com.tr (tek sayfa TR+GLOBAL)",
    //     run: () => hesapcomtr.run("https://hesap.com.tr/urunler/mlbb-elmas-satin-al", {
    //         categoryMap: { tr: "hesap-mlbb-tr", global: "hesap-mlbb-global" },
    //         decideCategory: (title) => title.toLowerCase().includes("global") ? "global" : "tr",
    //     }),
    // },
    // {
    //     name: "Hesap.com.tr PUBG (TR)",
    //     run: () =>
    //         hesapcomtr.run("https://hesap.com.tr/urunler/pubg-mobile-uc-satin-al", {
    //             categoryMap: { tr: "hesap-pubgm-tr" },
    //             decideCategory: () => "tr",
    //         }),
    // },
    {
        name: "Perdigital (TR)",
        run: () => perdigital.run([
            { url: "https://www.perdigital.com/mobile-legends-elmas", categoryName: "perdigital-mlbb-tr" },

        ]),
    },
    {
        name: "Perdigital (GLOBAL)",
        run: () => perdigital.run([
            { url: "https://www.perdigital.com/mobile-legends-elmas-global", categoryName: "perdigital-mlbb-global" },
        ]),
    },
    {
        name: "Perdigital PUBG",
        run: () => perdigital.run([
            { url: "https://www.perdigital.com/online-oyun/tencent-games/pubg-mobile-uc", categoryName: "perdigital-pubgm-tr" },
        ]),
    },
    {
        name: "VatanGame (TR+GLOBAL)",
        run: () => vatangame.run([
            { url: "https://vatangame.com/oyunlar/mobile-legends-bang-bang-elmas", categoryName: "vatangame-mlbb-tr" },
            { url: "https://vatangame.com/oyunlar/global-mobile-legends-bang-bang-elmas", categoryName: "vatangame-mlbb-global" },
        ]),
    },
    {
        name: "VatanGame PUBG (TR)",
        run: () => vatangame.run([
            { url: "https://vatangame.com/oyunlar/pubg-mobile-uc-tr", categoryName: "vatangame-pubgm-tr" },
        ]),
    },
    {
        name: "Kabasakal PUBG (TR)",
        run: () => kabasakal.run([
            { url: "https://kabasakalonline.com/urunler/106/pubg-mobile", categoryName: "kabasakal-pubgm-tr" },
        ]),
    },
    {
        name: "Kabasakal MLBB (TR)",
        run: () => kabasakal.run([
            { url: "https://kabasakalonline.com/urunler/127/mobile-legends-elmas-tr", categoryName: "kabasakal-mlbb-tr" },
        ]),
    },
    {
        name: "Kabasakal MLBB (GLOBAL)",
        run: () => kabasakal.run([
            { url: "https://kabasakalonline.com/urunler/239/mobile-legends-global-elmas", categoryName: "kabasakal-mlbb-global" },
        ]),
    },
    // {
    //     name: "oyuneks PUBG (TR+GLOBAL split)",
    //     run: () => oyuneks.runPUBGSplit("./oyuneks.xml"),
    // },
    // {
    //     name: "Oyuneks MLBB (TR+GLOBAL split)",
    //     run: () => oyuneks.runMLBBSplit("./oyuneks.xml"), // <-- TR/Global otomatik
    // },
    {
        name: "oyunfor PUBG (TR+GLOBAL split)",
        run: () => oyunfor.runPUBGSplitLocal("./oyunfor.xml"),
    },
    {
        name: "oyunfor MLBB (TR+GLOBAL split)",
        run: () => oyunfor.runMLBBSplitLocal("./oyunfor.xml"),
    },
]

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
        await sleep(3000); // siteleri üzmeyelim
    }
    console.log("\n✔ Tüm işler tamam.");
}

// runAllOnce().catch(e => console.error("cron hata:", e));

// cron.schedule("*/30 * * * *", () => {
//   runAllOnce().catch(e => console.error("cron hata:", e));
// }, {
//   scheduled: true, // default true zaten
//   timezone: "Europe/Istanbul" // saat dilimini netleştirmek istersen
// });