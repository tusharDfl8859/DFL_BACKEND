const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    PARTNER_API_OUTBOX_EVENT_TYPE_VALUES,
    PARTNER_API_OUTBOX_EVENT_TYPES,
    PARTNER_API_OUTBOX_STATUS_VALUES,
    PARTNER_API_OUTBOX_STATUSES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const partnerApiOutboxEventSchema = new mongoose.Schema(
    {
        outboxEventId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('POUT'),
            immutable: true,
            maxlength: 40
        },
        eventType: {
            type: String,
            required: true,
            enum: PARTNER_API_OUTBOX_EVENT_TYPE_VALUES,
            default: PARTNER_API_OUTBOX_EVENT_TYPES.LIVE_PARTNER_BOOKING_REQUESTED,
            index: true
        },
        aggregateType: { type: String, required: true, enum: ['SHIPMENT'], default: 'SHIPMENT', index: true },
        aggregateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true, index: true },
        bookingId: { type: String, required: true, trim: true, maxlength: 40, index: true },
        shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        credentialId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiCredential', required: true, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, index: true },
        partnerRequestId: { type: String, required: true, trim: true, maxlength: 120, index: true },
        walletReservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletReservation', required: true, index: true },
        idempotencyRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiIdempotency', required: true, index: true },
        requestId: { type: String, trim: true, maxlength: 120, default: null },
        payloadVersion: { type: Number, required: true, default: 1, min: 1 },
        payload: { type: mongoose.Schema.Types.Mixed, default: null },
        status: {
            type: String,
            required: true,
            enum: PARTNER_API_OUTBOX_STATUS_VALUES,
            default: PARTNER_API_OUTBOX_STATUSES.PENDING,
            index: true
        },
        attempts: { type: Number, required: true, min: 0, default: 0 },
        availableAt: { type: Date, required: true, default: Date.now, index: true },
        lockedAt: { type: Date, default: null },
        lockedBy: { type: String, trim: true, maxlength: 120, default: null },
        queueJobId: { type: String, trim: true, maxlength: 160, default: null, index: true },
        lastErrorCode: { type: String, trim: true, maxlength: 80, default: null },
        lastErrorMessage: { type: String, trim: true, maxlength: 500, default: null },
        publishedAt: { type: Date, default: null, index: true }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

partnerApiOutboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
partnerApiOutboxEventSchema.index({ developerAccountId: 1, environment: 1, bookingId: 1 });
partnerApiOutboxEventSchema.index(
    { idempotencyRecordId: 1, eventType: 1 },
    { unique: true, name: 'unique_partner_api_outbox_by_idempotency' }
);

module.exports = mongoose.model('PartnerApiOutboxEvent', partnerApiOutboxEventSchema);
