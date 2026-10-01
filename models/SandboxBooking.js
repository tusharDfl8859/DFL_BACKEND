const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ENVIRONMENT_VALUES,
    SANDBOX_BOOKING_STATUSES,
    SANDBOX_BOOKING_STATUS_VALUES,
    SANDBOX_SCENARIO_VALUES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');
const { validateSanitizedMetadata } = require('../utils/sanitizedMetadataValidator');

const trackingEventSchema = new mongoose.Schema(
    {
        status: { type: String, required: true, enum: SANDBOX_BOOKING_STATUS_VALUES },
        description: { type: String, required: true, trim: true, maxlength: 300 },
        location: { type: String, required: true, trim: true, maxlength: 120 },
        timestamp: { type: Date, required: true }
    },
    { _id: false }
);

const sandboxBookingSchema = new mongoose.Schema(
    {
        sandboxBookingId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('SBKG'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        environment: {
            type: String,
            required: true,
            enum: DEVELOPER_ENVIRONMENT_VALUES,
            default: DEVELOPER_ENVIRONMENTS.SANDBOX,
            validate: {
                validator(value) {
                    return value === DEVELOPER_ENVIRONMENTS.SANDBOX;
                },
                message: 'SandboxBooking records must remain in the SANDBOX environment.'
            },
            immutable: true
        },
        partnerRequestId: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
        sourceChannel: {
            type: String,
            enum: ['PARTNER_API', 'DASHBOARD_SIMULATOR', 'SYSTEM'],
            default: 'PARTNER_API',
            required: true
        },
        status: {
            type: String,
            enum: SANDBOX_BOOKING_STATUS_VALUES,
            default: SANDBOX_BOOKING_STATUSES.CREATED,
            required: true,
            index: true
        },
        trackingNumber: { type: String, trim: true, unique: true, sparse: true, maxlength: 40, index: true },
        scenario: { type: String, enum: SANDBOX_SCENARIO_VALUES, default: 'success', index: true },
        requestFingerprint: { type: String, required: true, trim: true, maxlength: 128, default: 'legacy' },
        recipient: {
            name: { type: String, trim: true, maxlength: 120, default: null },
            phone: { type: String, trim: true, maxlength: 20, default: null },
            email: { type: String, trim: true, maxlength: 254, default: null },
            addressLine1: { type: String, trim: true, maxlength: 200, default: null },
            addressLine2: { type: String, trim: true, maxlength: 200, default: null },
            city: { type: String, trim: true, maxlength: 80, default: null },
            state: { type: String, trim: true, maxlength: 80, default: null },
            postalCode: { type: String, trim: true, maxlength: 20, default: null },
            countryCode: { type: String, trim: true, uppercase: true, maxlength: 2, default: null }
        },
        package: {
            weightKg: { type: Number, min: 0, default: null },
            lengthCm: { type: Number, min: 0, default: null },
            widthCm: { type: Number, min: 0, default: null },
            heightCm: { type: Number, min: 0, default: null },
            declaredValue: { type: Number, min: 0, default: null },
            currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: null },
            description: { type: String, trim: true, maxlength: 500, default: null }
        },
        order: {
            orderId: { type: String, trim: true, maxlength: 120, default: null },
            invoiceNumber: { type: String, trim: true, maxlength: 120, default: null }
        },
        customs: {
            hsnCode: { type: String, trim: true, maxlength: 20, default: null },
            itemDescription: { type: String, trim: true, maxlength: 300, default: null },
            quantity: { type: Number, min: 0, default: null },
            unitValue: { type: Number, min: 0, default: null },
            countryOfOrigin: { type: String, trim: true, uppercase: true, maxlength: 2, default: null },
            csbType: { type: String, trim: true, maxlength: 20, default: null }
        },
        simulatedCharge: {
            amount: { type: Number, min: 0, default: 0 },
            currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: 'INR' }
        },
        trackingEvents: { type: [trackingEventSchema], default: [] },
        cancelledAt: { type: Date, default: null },
        cancellationReason: { type: String, trim: true, maxlength: 500, default: null },
        isSandbox: { type: Boolean, default: true, immutable: true },
        walletDeducted: { type: Boolean, default: false, immutable: true },
        carrierInvoked: { type: Boolean, default: false, immutable: true },
        realLabelGenerated: { type: Boolean, default: false, immutable: true },
        manifestEligible: { type: Boolean, default: false, immutable: true },
        requestMetadata: { type: mongoose.Schema.Types.Mixed, default: {}, validate: validateSanitizedMetadata },
        responseMetadata: { type: mongoose.Schema.Types.Mixed, default: {}, validate: validateSanitizedMetadata },
        expiresAt: { type: Date, default: null, index: true }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

sandboxBookingSchema.index({ developerAccountId: 1, userId: 1, createdAt: -1 });
sandboxBookingSchema.index({ developerAccountId: 1, environment: 1, sandboxBookingId: 1 });
sandboxBookingSchema.index({ developerAccountId: 1, environment: 1, trackingNumber: 1 });
sandboxBookingSchema.index({ developerAccountId: 1, environment: 1, status: 1, createdAt: -1 });
sandboxBookingSchema.index(
    { developerAccountId: 1, environment: 1, partnerRequestId: 1 },
    { unique: true, name: 'unique_sandbox_partner_request' }
);

module.exports = mongoose.model('SandboxBooking', sandboxBookingSchema);
