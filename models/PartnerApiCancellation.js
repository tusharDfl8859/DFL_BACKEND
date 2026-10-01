const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    PARTNER_API_CANCELLATION_STATUS_VALUES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_REFUND_STATUS_VALUES,
    PARTNER_API_REFUND_STATUSES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const partnerApiCancellationSchema = new mongoose.Schema(
    {
        cancellationId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('PCAN'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        credentialId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiCredential', required: true, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, index: true },
        bookingId: { type: String, required: true, trim: true, maxlength: 40, index: true },
        shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true, index: true },
        partnerRequestId: { type: String, required: true, trim: true, minlength: 3, maxlength: 120, index: true },
        canonicalRequestHash: { type: String, required: true, trim: true, minlength: 64, maxlength: 128 },
        reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
        status: {
            type: String,
            required: true,
            enum: PARTNER_API_CANCELLATION_STATUS_VALUES,
            default: PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
            index: true
        },
        carrierCancellationStatus: {
            type: String,
            enum: ['NOT_REQUIRED', 'REQUESTED', 'CANCELLED', 'REJECTED', 'RETRYABLE_FAILURE', 'STATUS_UNKNOWN', 'FAILED_FINAL', 'NOT_SUPPORTED', null],
            default: null,
            index: true
        },
        refundStatus: {
            type: String,
            required: true,
            enum: PARTNER_API_REFUND_STATUS_VALUES,
            default: PARTNER_API_REFUND_STATUSES.NOT_REQUIRED,
            index: true
        },
        walletReservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletReservation', default: null, index: true },
        bookingIdempotencyRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiIdempotency', default: null, index: true },
        cancellationIdempotencyRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiIdempotency', required: true, index: true },
        outboxEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiOutboxEvent', default: null, index: true },
        queueJobId: { type: String, trim: true, maxlength: 180, default: null, index: true },
        retryCount: { type: Number, min: 0, default: 0 },
        errorCode: { type: String, trim: true, maxlength: 80, default: null },
        errorMessage: { type: String, trim: true, maxlength: 500, default: null },
        carrierResultSummary: { type: mongoose.Schema.Types.Mixed, default: null },
        releaseReference: { type: String, trim: true, maxlength: 260, default: null, index: true },
        refundReference: { type: String, trim: true, maxlength: 260, default: null, index: true },
        refundTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },
        requestedAt: { type: Date, required: true, default: Date.now, index: true },
        queuedAt: { type: Date, default: null },
        processingStartedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },
        manualRecovery: [{
            action: { type: String, trim: true, maxlength: 80 },
            reason: { type: String, trim: true, maxlength: 500 },
            actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
            createdAt: { type: Date, default: Date.now }
        }]
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

partnerApiCancellationSchema.index(
    { developerAccountId: 1, environment: 1, bookingId: 1, partnerRequestId: 1 },
    { unique: true, name: 'unique_partner_api_cancellation_scope' }
);
partnerApiCancellationSchema.index({ developerAccountId: 1, environment: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PartnerApiCancellation', partnerApiCancellationSchema);
