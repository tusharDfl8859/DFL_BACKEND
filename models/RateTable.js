const mongoose = require('mongoose');

const RateTableSchema = new mongoose.Schema({
    weight: { type: Number, required: true, index: true },
    rates: {
        type: Map,
        of: Number
    }
});

// Used to store the rate row: { "TUS 2": 100, "TUK": 200 } under 'rates'
// Ordered by weight ASC

module.exports = mongoose.model('RateTable', RateTableSchema);
