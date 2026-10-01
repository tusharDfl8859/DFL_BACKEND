const mongoose = require('mongoose');

const marketplaceAccountSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    platform: { type: String, enum: ['Etsy', 'Shopify', 'WooCommerce', 'Amazon', 'eBay'], required: true },
    shopName: { type: String, required: true },
    shopId: { type: String, required: true },
    accessToken: { type: String, required: true }, // Should be encrypted
    refreshToken: { type: String }, // Should be encrypted
    tokenExpiry: { type: Date },
    status: { type: String, enum: ['Connected', 'Disconnected', 'Error'], default: 'Connected' },
    lastSync: { type: Date },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Ensure a user can only have one active account per shop
marketplaceAccountSchema.index({ userId: 1, shopId: 1, platform: 1 }, { unique: true });
marketplaceAccountSchema.index({ platform: 1, isActive: 1, status: 1 });
marketplaceAccountSchema.index({ userId: 1, platform: 1 });

module.exports = mongoose.model('MarketplaceAccount', marketplaceAccountSchema);
