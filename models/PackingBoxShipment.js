const mongoose = require('mongoose');

const packingBoxShipmentSchema = new mongoose.Schema(
    {
        packingBox: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PackingBox',
            required: true,
            index: true,
        },
        shipment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Shipment',
            required: true,
            unique: true,
            index: true,
        },
        scannedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null,
        },
        scannedAt: { type: Date, default: Date.now },
        source: { type: String, default: 'SCANNER', trim: true },
    },
    { timestamps: true }
);

packingBoxShipmentSchema.index({ packingBox: 1, scannedAt: -1 });

module.exports = mongoose.model('PackingBoxShipment', packingBoxShipmentSchema);
