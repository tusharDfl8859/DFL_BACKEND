const mongoose = require('mongoose');

const marketplaceLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    platform: { type: String, enum: ['Etsy', 'Shopify', 'WooCommerce', 'Amazon', 'eBay'] },
    action: { type: String, required: true }, // e.g., 'TokenRefresh', 'OrderImport', 'TrackingSync', 'OAuthConnect'
    status: { type: String, enum: ['Success', 'Error', 'Warning'], required: true },
    message: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed }, // Full error stack or API payload for debugging
    createdAt: { type: Date, default: Date.now, expires: '30d' } // Auto-delete logs after 30 days to prevent bloat
});

// Index for easy querying on the admin dashboard
marketplaceLogSchema.index({ platform: 1, status: 1, createdAt: -1 });
marketplaceLogSchema.index({ userId: 1, platform: 1 });
marketplaceLogSchema.index({ userId: 1, platform: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('MarketplaceLog', marketplaceLogSchema);
