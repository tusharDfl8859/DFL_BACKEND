const mongoose = require('mongoose');

const shopifyOrderSchema = new mongoose.Schema({
    shopDomain: {
        type: String,
        required: true,
        trim: true,
    },
    shopifyOrderId: {
        type: String,
        required: true,
    },
    orderNumber: {
        type: String,
    },
    customerName: {
        type: String,
        default: '',
    },
    customerEmail: {
        type: String,
        default: '',
    },
    customerPhone: {
        type: String,
        default: '',
    },
    shippingAddress: {
        name: { type: String, default: '' },
        phone: { type: String, default: '' },
        address1: { type: String, default: '' },
        address2: { type: String, default: '' },
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        country: { type: String, default: '' },
        zip: { type: String, default: '' },
    },
    products: [
        {
            productId: String,
            variantId: String,
            title: String,
            sku: String,
            quantity: Number,
            price: Number,
            weight: Number,
            weightUnit: String,
        }
    ],
    totalPrice: {
        type: Number,
        default: 0,
    },
    currency: {
        type: String,
        default: 'INR',
    },
    financialStatus: {
        type: String,
        default: '',
    },
    fulfillmentStatus: {
        type: String,
        default: 'unfulfilled',
    },
    paymentType: {
        type: String, // PREPAID / COD
        default: 'PREPAID',
    },
    // DFL Shipment link
    dflShipmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment',
        default: null,
    },
    dflShipmentBooked: {
        type: Boolean,
        default: false,
    },
    dflAwbNumber: {
        type: String,
        default: '',
    },
    shopifyFulfillmentId: {
        type: String,
        default: '',
    },
    lastTrackingStatus: {
        type: String,
        default: '',
    },
    syncStatus: {
        type: String,
        enum: ['pending', 'shipment_created', 'booked', 'fulfilled', 'cancelled', 'error'],
        default: 'pending',
    },
    rawData: {
        type: mongoose.Schema.Types.Mixed,
        select: false,
    },
    shopifyCreatedAt: {
        type: Date,
    },
}, {
    timestamps: true,
});

shopifyOrderSchema.index({ shopDomain: 1, shopifyOrderId: 1 }, { unique: true });

module.exports = mongoose.model('ShopifyOrder', shopifyOrderSchema);
