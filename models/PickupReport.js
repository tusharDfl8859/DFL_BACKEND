const mongoose = require('mongoose');

const pickupReportSchema = new mongoose.Schema(
    {
        shipmentId: {
            type: String,
            required: true,
            trim: true,
            index: true
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Shipment',
            required: true,
            index: true
        },
        pickedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            required: true,
            index: true
        },
        pickedByName: {
            type: String,
            required: true
        },
        pickupTime: {
            type: Date,
            default: Date.now,
            index: true
        },
        expectedPickupDate: {
            type: Date,
            default: null
        },
        isDelayed: {
            type: Boolean,
            default: false,
            index: true
        },
        delayDays: {
            type: Number,
            default: 0
        },
        delayReason: {
            type: String,
            default: ''
        },
        location: {
            type: String,
            default: 'Hub'
        },
        syncedAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
);

// Indexes for fast history and stats querying
pickupReportSchema.index({ createdAt: -1 });
pickupReportSchema.index({ pickedBy: 1, createdAt: -1 });
pickupReportSchema.index({ isDelayed: 1, createdAt: -1 });

module.exports = mongoose.model('PickupReport', pickupReportSchema);
