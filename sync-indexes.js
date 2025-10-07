require("dotenv").config();
const mongoose = require("mongoose");
const Item = require("../models/item");

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Mongoose:", mongoose.version);

    if (typeof Item.syncIndexes === "function") {
      await Item.syncIndexes();
      console.log("syncIndexes OK");
    } else if (typeof Item.createIndexes === "function") {
      await Item.createIndexes();
      console.log("createIndexes OK");
    } else {
      console.warn("Modelde index sync fonksiyonu yok.");
    }
  } catch (e) {
    console.error("Index sync error:", e?.message || e);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
