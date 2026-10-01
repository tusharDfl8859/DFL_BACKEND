const mongoose = require('mongoose');

const shopifyStoreSchema = new mongoose.Schema({
    shopDomain: {
        type: String,
        required: true,
        trim: true,
    },
    accessToken: {
        type: String,
        default: null,
        select: false,
    },
    refreshToken: {
        type: String,
        default: null,
        select: false,
    },
    expiresAt: {
        type: Date,
        default: null,
    },
    refreshTokenExpiresAt: {
        type: Date,
        default: null,
    },
    scope: {
        type: String,
        default: '',
    },
    isActive: {
        type: Boolean,
        default: false,
    },
    installedAt: {
        type: Date,
        default: Date.now,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null,
    },
    connectedBy: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',
    },
    // Shipper/Pickup details - merchant fills this on first setup
    shipperDetails: {
        shipperName: { type: String, default: '' },
        companyName: { type: String, default: '' },
        mobileNo: { type: String, default: '' },
        email: { type: String, default: '' },
        addressLine1: { type: String, default: '' },
        addressLine2: { type: String, default: '' },
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        country: { type: String, default: '' },
        pincode: { type: String, default: '' },
    },
    shipperDetailsCompleted: {
        type: Boolean,
        default: false,
    },
    lastSyncAt: {
        type: Date,
        default: null,
    },
    settings: {
        autoCreateShipment: { type: Boolean, default: false },
        autoBookShipment: { type: Boolean, default: false },
        updateFulfillment: { type: Boolean, default: true },
        syncCancellations: { type: Boolean, default: true },
    },
}, {
    timestamps: true,
});

shopifyStoreSchema.index({ shopDomain: 1, connectedBy: 1, userId: 1 });
shopifyStoreSchema.index({ shopDomain: 1, connectedBy: 1, adminId: 1 });

module.exports = mongoose.model('ShopifyStore', shopifyStoreSchema);
