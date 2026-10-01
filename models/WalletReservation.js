const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    WALLET_RESERVATION_STATUS_VALUES,
    WALLET_RESERVATION_STATUSES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const walletReservationSchema = new mongoose.Schema(
    {
        walletReservationId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('WRES'),
            immutable: true,
            maxlength: 40
        },
        walletOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        walletOwnerType: { type: String, enum: ['User'], default: 'User', required: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, index: true },
        bookingId: { type: String, required: true, trim: true, maxlength: 40, index: true },
        shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', default: null, index: true },
        partnerRequestId: { type: String, required: true, trim: true, minlength: 3, maxlength: 120, index: true },
        idempotencyRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'PartnerApiIdempotency', required: true, index: true },
        amount: { type: Number, required: true, min: 0 },
        currency: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 3, default: 'INR' },
        status: {
            type: String,
            enum: WALLET_RESERVATION_STATUS_VALUES,
            default: WALLET_RESERVATION_STATUSES.ACTIVE,
            required: true,
            index: true
        },
        reservationReference: { type: String, required: true, unique: true, trim: true, maxlength: 260 },
        pricingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
        settledAmount: { type: Number, default: 0, min: 0 },
        unusedReleasedAmount: { type: Number, default: 0, min: 0 },
        additionalReservedAmount: { type: Number, default: 0, min: 0 },
        settlementReference: { type: String, trim: true, maxlength: 260, default: null, index: true },
        settlementTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },
        expiresAt: { type: Date, required: true, index: true },
        settledAt: { type: Date, default: null },
        releasedAt: { type: Date, default: null },
        releaseReference: { type: String, trim: true, maxlength: 260, default: null, index: true },
        releaseReason: { type: String, trim: true, maxlength: 500, default: null }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

walletReservationSchema.index(
    { developerAccountId: 1, environment: 1, partnerRequestId: 1 },
    { unique: true, name: 'unique_live_wallet_reservation_scope' }
);
walletReservationSchema.index({ walletOwnerId: 1, status: 1, createdAt: -1 });
walletReservationSchema.index(
    { releaseReference: 1 },
    {
        unique: true,
        partialFilterExpression: {
            releaseReference: { $type: 'string' }
        },
        name: 'unique_wallet_reservation_release_reference'
    }
);

module.exports = mongoose.model('WalletReservation', walletReservationSchema);
