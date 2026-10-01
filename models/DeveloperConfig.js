const mongoose = require('mongoose');

const positiveInteger = { validator: Number.isInteger, message: 'Value must be an integer.' };

const developerConfigSchema = new mongoose.Schema(
    {
        configKey: {
            type: String,
            required: true,
            unique: true,
            default: 'DEVELOPER_PORTAL',
            immutable: true,
            maxlength: 80
        },
        sandboxRetentionDays: { type: Number, required: true, default: 30, min: 1, max: 365, validate: positiveInteger },
        sandboxMinimumSuccessfulBookings: { type: Number, required: true, default: 10, min: 0, max: 10000, validate: positiveInteger },
        silverRateLimit: { type: Number, required: true, default: 60, min: 1, max: 100000, validate: positiveInteger },
        silverBurstLimit: { type: Number, required: true, default: 20, min: 1, max: 100000, validate: positiveInteger },
        goldRateLimit: { type: Number, required: true, default: 300, min: 1, max: 100000, validate: positiveInteger },
        goldBurstLimit: { type: Number, required: true, default: 100, min: 1, max: 100000, validate: positiveInteger },
        platinumRateLimit: { type: Number, required: true, default: 1000, min: 1, max: 100000, validate: positiveInteger },
        platinumBurstLimit: { type: Number, required: true, default: 300, min: 1, max: 100000, validate: positiveInteger },
        credentialRotationHours: { type: Number, required: true, default: 24, min: 1, max: 8760, validate: positiveInteger },
        lowWalletThreshold: { type: Number, required: true, default: 0, min: 0, max: 10000000 },
        liveIdempotencySuccessRetentionDays: { type: Number, required: true, default: 30, min: 1, max: 365, validate: positiveInteger },
        liveIdempotencyFailureRetentionDays: { type: Number, required: true, default: 14, min: 1, max: 365, validate: positiveInteger },
        liveReservationExpiryHours: { type: Number, required: true, default: 48, min: 1, max: 720, validate: positiveInteger },
        liveReservationSafetyMarginPercent: { type: Number, required: true, default: 0, min: 0, max: 50 },
        liveOutboxMaxPending: { type: Number, required: true, default: 1000, min: 1, max: 100000, validate: positiveInteger },
        liveOutboxMaxOldestPendingMinutes: { type: Number, required: true, default: 30, min: 1, max: 1440, validate: positiveInteger },
        liveOutboxLockTimeoutSeconds: { type: Number, required: true, default: 300, min: 30, max: 3600, validate: positiveInteger },
        liveQueueMaxBacklog: { type: Number, required: true, default: 5000, min: 1, max: 1000000, validate: positiveInteger },
        liveQueueRetryAfterSeconds: { type: Number, required: true, default: 60, min: 1, max: 3600, validate: positiveInteger },
        liveCarrierWorkerConcurrency: { type: Number, required: true, default: 5, min: 1, max: 100, validate: positiveInteger },
        liveCarrierJobTimeoutSeconds: { type: Number, required: true, default: 120, min: 10, max: 1800, validate: positiveInteger },
        liveCarrierMaxAttempts: { type: Number, required: true, default: 5, min: 1, max: 20, validate: positiveInteger },
        liveCarrierConcurrencyByCarrier: {
            type: Map,
            of: Number,
            default: () => ({
                TPL: 5,
                UNITED: 5,
                SKYNET: 5,
                'SKYNET-ECOMMERCE': 5,
                RSA: 3
            })
        },
        liveCarrierRetryBackoffSeconds: { type: [Number], default: () => [5, 30, 120, 600] },
        liveLabelUrlTtlSeconds: { type: Number, required: true, default: 300, min: 60, max: 3600, validate: positiveInteger },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

developerConfigSchema.statics.getSingleton = function getSingleton() {
    return this.findOneAndUpdate(
        { configKey: 'DEVELOPER_PORTAL' },
        { $setOnInsert: { configKey: 'DEVELOPER_PORTAL' } },
        { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    );
};

module.exports = mongoose.model('DeveloperConfig', developerConfigSchema);
