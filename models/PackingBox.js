const mongoose = require('mongoose');

const packingBoxSchema = new mongoose.Schema(
    {
        boxId: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            unique: true,
            index: true,
        },
        boxConfig: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BoxConfig',
            required: true,
            index: true,
        },
        carrier: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Carrier',
            required: true,
            index: true,
        },
        destinationCountry: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        category: {
            type: String,
            enum: ['CSV IV', 'CSV V'],
            default: 'CSV IV',
            trim: true,
            index: true,
        },
        status: {
            type: String,
            enum: ['OPEN', 'FULL', 'SEALED', 'DISPATCHED'],
            default: 'OPEN',
            index: true,
        },
        isFull: {
            type: Boolean,
            default: false,
            index: true,
        },
        fullReason: {
            type: String,
            enum: ['WEIGHT_LIMIT', 'PHYSICAL_CAPACITY', 'MANUAL', null],
            default: null,
        },
        openedAt: { type: Date, default: Date.now },
        openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        closedAt: { type: Date, default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        sealedAt: { type: Date, default: null },
        sealedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        dispatchedAt: { type: Date, default: null },
        dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        reopenedAt: { type: Date, default: null },
        reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        notes: { type: String, default: null, trim: true, maxlength: 500 },
    },
    { timestamps: true }
);

packingBoxSchema.index({ destinationCountry: 1, status: 1 });

module.exports = mongoose.model('PackingBox', packingBoxSchema);
