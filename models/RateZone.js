const mongoose = require('mongoose');

const RateZoneSchema = new mongoose.Schema({
    country: { type: String, required: true, uppercase: true }, // 'US', 'AU'
    state: { type: String, uppercase: true }, // 'NY'
    postcode: { type: String }, // '200'
    zone: { type: String, required: true } // 'TUS 2', 'TAU3'
});

// Composite index for fast lookups
RateZoneSchema.index({ country: 1, state: 1 });
RateZoneSchema.index({ country: 1, postcode: 1 });

module.exports = mongoose.model('RateZone', RateZoneSchema);
