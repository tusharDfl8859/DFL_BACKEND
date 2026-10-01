const mongoose = require('mongoose');

const carrierLeaseEntrySchema = new mongoose.Schema(
    {
        token: {
            type: String,
            required: true,
            maxlength: 80
        },
        expiresAt: {
            type: Date,
            required: true
        },
        acquiredAt: {
            type: Date,
            default: Date.now
        }
    },
    { _id: false }
);

const carrierConcurrencyLeaseSchema = new mongoose.Schema(
    {
        carrier: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            unique: true,
            index: true
        },
        activeCount: {
            type: Number,
            required: true,
            default: 0,
            min: 0
        },
        leases: {
            type: [carrierLeaseEntrySchema],
            default: []
        },
        limit: {
            type: Number,
            required: true,
            min: 1
        },
        leaseExpiresAt: {
            type: Date,
            required: true,
            index: true
        }
    },
    {
        timestamps: true
    }
);

carrierConcurrencyLeaseSchema.index({ carrier: 1, 'leases.token': 1 }, { name: 'carrier_concurrency_lease_token' });

module.exports = mongoose.model('CarrierConcurrencyLease', carrierConcurrencyLeaseSchema);
