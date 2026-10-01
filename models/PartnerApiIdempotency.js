const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    PARTNER_API_IDEMPOTENCY_STATUS_VALUES,
    PARTNER_API_OPERATIONS
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const partnerApiIdempotencySchema = new mongoose.Schema(
    {
        idempotencyId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('PIDEMP'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        credentialId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiCredential', required: true, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, index: true },
        operation: {
            type: String,
            required: true,
            enum: Object.values(PARTNER_API_OPERATIONS),
            default: PARTNER_API_OPERATIONS.CREATE_LIVE_BOOKING,
            index: true
        },
        partnerRequestId: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
        requestHash: { type: String, required: true, trim: true, minlength: 64, maxlength: 128 },
        status: { type: String, required: true, enum: PARTNER_API_IDEMPOTENCY_STATUS_VALUES, index: true },
        bookingId: { type: String, trim: true, maxlength: 40, default: null, index: true },
        shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', default: null, index: true },
        walletReservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletReservation', default: null, index: true },
        outboxEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiOutboxEvent', default: null, index: true },
        cancellationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiCancellation', default: null, index: true },
        cancellationStatus: { type: String, trim: true, maxlength: 80, default: null, index: true },
        refundStatus: { type: String, trim: true, maxlength: 80, default: null, index: true },
        cancelledAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },
        responseStatus: { type: Number, default: null, min: 100, max: 599 },
        responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
        startedAt: { type: Date, required: true, default: Date.now, index: true },
        completedAt: { type: Date, default: null },
        lastAttemptAt: { type: Date, default: null, index: true },
        expiresAt: { type: Date, default: null, index: true },
        failureCode: { type: String, trim: true, maxlength: 80, default: null },
        failureMessage: { type: String, trim: true, maxlength: 500, default: null }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

partnerApiIdempotencySchema.index(
    { developerAccountId: 1, environment: 1, operation: 1, partnerRequestId: 1 },
    { unique: true, name: 'unique_partner_api_idempotency_scope' }
);
partnerApiIdempotencySchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('PartnerApiIdempotency', partnerApiIdempotencySchema);
