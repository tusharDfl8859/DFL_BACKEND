const mongoose = require('mongoose');

const rateCardSchema = new mongoose.Schema({
    zone: {
        type: String,
        required: true,
        index: true
    },
    minWeight: {
        type: Number,
        required: true,
        index: true // Index for fast range queries
    },
    maxWeight: {
        type: Number,
        required: true,
        index: true
    },
    // We store the rates as a flexible Map
    // Key: ISO Country Code (e.g., "US", "AT") or Zone Code (e.g., "D01")
    // Value: The rate amount (Number)
    rates: {
        type: Map,
        of: Number
    },
    // To preserve the original column names from the Excel sheet for reference
    originalColumnNames: {
        type: Map,
        of: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Compound index to ensure no overlapping slabs (optional, but good for integrity)
rateCardSchema.index({ minWeight: 1, maxWeight: 1 });

module.exports = mongoose.model('RateCard', rateCardSchema);
