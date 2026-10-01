const mongoose = require('mongoose');

const hubScanReportSchema = new mongoose.Schema(
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
        scannedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null,
            index: true
        },
        scannedByName: {
            type: String,
            required: true
        },
        scannedByEmail: {
            type: String,
            default: ''
        },
        scannedByPhone: {
            type: String,
            default: ''
        },
        scannedByRole: {
            type: String,
            default: 'Operation'
        },
        scannedAt: {
            type: Date,
            default: Date.now,
            index: true
        },
        scanDate: {
            type: String,
            index: true
        },
        previousStatus: {
            type: String,
            default: 'Processing'
        },
        status: {
            type: String,
            default: 'Shipment Received at Our Hub'
        },
        bookedWeight: {
            type: Number,
            default: 0
        },
        actualWeight: {
            type: Number,
            default: 0
        },
        shipperName: {
            type: String,
            default: 'N/A'
        },
        shipperMobile: {
            type: String,
            default: ''
        },
        shipperCity: {
            type: String,
            default: ''
        },
        consigneeName: {
            type: String,
            default: 'N/A'
        },
        consigneeCountry: {
            type: String,
            default: ''
        },
        location: {
            type: String,
            default: 'Hub'
        },
        notes: {
            type: String,
            default: ''
        }
    },
    {
        timestamps: true
    }
);

hubScanReportSchema.index({ createdAt: -1 });
hubScanReportSchema.index({ scanDate: 1, createdAt: -1 });
hubScanReportSchema.index({ scannedBy: 1, createdAt: -1 });

module.exports = mongoose.model('HubScanReport', hubScanReportSchema);
