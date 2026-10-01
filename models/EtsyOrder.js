const mongoose = require('mongoose');

const etsyOrderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    marketplaceAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketplaceAccount', required: true },
    etsyOrderId: { type: String, required: true, unique: true },
    receiptId: { type: String },
    orderDate: { type: Date },
    buyerName: { type: String },
    buyerEmail: { type: String },
    
    shippingAddress: {
        name: String,
        firstLine: String,
        secondLine: String,
        city: String,
        state: String,
        zip: String,
        countryIso: String
    },
    
    items: [{
        title: String,
        sku: String,
        quantity: Number,
        price: Number,
        currency: String
    }],
    
    totalValue: { type: Number },
    currency: { type: String },
    shippingAmount: { type: Number },
    
    paymentStatus: { type: String },
    fulfillmentStatus: { 
        type: String, 
        enum: ['New', 'Ready to Ship', 'Shipment Created', 'Cancelled', 'Delivered', 'Import Failed'], 
        default: 'New' 
    },
    
    // Relations to DFL Express core data
    dflShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
    awbNumber: { type: String },
    courierName: { type: String },
    
    // Tracking sync to Etsy
    trackingStatus: { type: String },
    syncStatus: { type: String, enum: ['Pending', 'Synced', 'Failed'], default: 'Pending' },
    lastSyncTime: { type: Date }
}, { timestamps: true });

// Optimize for common queries
etsyOrderSchema.index({ userId: 1, fulfillmentStatus: 1 });

module.exports = mongoose.model('EtsyOrder', etsyOrderSchema);
