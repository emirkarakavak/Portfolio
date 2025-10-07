// models/itemArchived.js
const mongoose = require("mongoose");

const itemArchivedSchema = new mongoose.Schema(
  {
    siteName: { type: String, required: true },
    categoryName: { type: String, required: true },
    itemName: { type: String, required: true },
    sellPrice: { type: String, required: true },
  },
  { timestamps: true } // createdAt, updatedAt
);

// En çok sorgulayacağın eksen
itemArchivedSchema.index(
  { siteName: 1, categoryName: 1, itemName: 1, createdAt: -1 },
  { name: "archive_lookup_idx" }
);

module.exports = mongoose.model("ItemArchived", itemArchivedSchema);
