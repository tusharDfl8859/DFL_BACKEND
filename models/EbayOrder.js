const mongoose = require('mongoose');

const ebayOrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        ebayOrderId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        orderStatus: {
            type: String,
            default: 'AWAITING_FULFILLMENT'
        },
        currency: {
            type: String,
            default: 'USD'
        },
        orderTotal: {
            type: Number,
            default: 0
        },
        buyer: {
            username: { type: String },
            email: { type: String }
        },
        shippingAddress: {
            fullName: { type: String },
            addressLine1: { type: String },
            addressLine2: { type: String },
            city: { type: String },
            state: { type: String },
            postalCode: { type: String },
            country: { type: String },
            phone: { type: String }
        },
        lineItems: [
            {
                lineItemId: { type: String },
                title: { type: String },
                sku: { type: String },
                quantity: { type: Number },
                price: { type: Number },
                currency: { type: String }
            }
        ],
        dflShipmentId: {
            type: String,
            default: null
        },
        dflAwbNumber: {
            type: String,
            default: null
        },
        trackingStatus: {
            type: String,
            default: null
        },
        rawData: {
            type: mongoose.Schema.Types.Mixed
        }
    },
    {
        timestamps: true
    }
);

const EbayOrder = mongoose.model('EbayOrder', ebayOrderSchema);
module.exports = EbayOrder;