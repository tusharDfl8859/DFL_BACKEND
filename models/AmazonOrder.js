const mongoose = require('mongoose');

const amazonOrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        amazonOrderId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        orderStatus: {
            type: String,
            enum: ['AWAITING_FULFILLMENT', 'SHIPMENT_CREATED', 'SHIPPED', 'CANCELLED', 'Unshipped', 'PartiallyShipped'],
            default: 'AWAITING_FULFILLMENT',
            index: true
        },
        currency: {
            type: String,
            default: 'USD'
        },
        orderTotal: {
            type: Number,
            default: 0
        },
        purchaseDate: {
            type: Date,
            default: Date.now
        },
        buyer: {
            name: { type: String, default: null },
            email: { type: String, default: null },
            buyerCounty: { type: String, default: null }
        },
        shippingAddress: {
            fullName: { type: String, default: null },
            addressLine1: { type: String, default: null },
            addressLine2: { type: String, default: null },
            city: { type: String, default: null },
            state: { type: String, default: null },
            postalCode: { type: String, default: null },
            country: { type: String, default: 'US' },
            phone: { type: String, default: null }
        },
        lineItems: [
            {
                orderItemId: { type: String, default: null },
                title: { type: String, required: true },
                sku: { type: String, default: null },
                quantity: { type: Number, default: 1 },
                price: { type: Number, default: 0 },
                currency: { type: String, default: 'USD' }
            }
        ],
        dflShipmentId: {
            type: String,
            default: null,
            index: true
        },
        dflAwbNumber: {
            type: String,
            default: null,
            index: true
        },
        trackingCarrier: {
            type: String,
            default: null
        },
        isTrackingSynced: {
            type: Boolean,
            default: false,
            index: true
        },
        trackingSyncedAt: {
            type: Date,
            default: null
        },
        trackingSyncError: {
            type: String,
            default: null
        },
        marketplaceId: {
            type: String,
            default: 'A21TJRUUN4KGV'
        },
        rawData: {
            type: Object,
            default: {}
        }
    },
    { timestamps: true }
);

amazonOrderSchema.index({ userId: 1, createdAt: -1 });

const AmazonOrder = mongoose.model('AmazonOrder', amazonOrderSchema);

module.exports = AmazonOrder;
