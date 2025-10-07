const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
    siteName: { type: String, required: true },
    categoryName: { type: String, required: true },
    itemName: { type: String, required: true },
    sellPrice: { type: String, required: true },
},
    {
        timestamps: true
    }
);

itemSchema.index({ siteName: 1, categoryName: 1, itemName: 1 }, { unique: true });
itemSchema.index({ categoryName: 1, siteName: 1, updatedAt: -1 });
itemSchema.index({ categoryName: 1, itemName: 1 });

const Item = new mongoose.model('Item', itemSchema);

module.exports = Item;
