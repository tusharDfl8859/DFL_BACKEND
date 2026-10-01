const mongoose = require('mongoose');

const boxSequenceSchema = new mongoose.Schema(
    {
        scopeKey: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        countryCode: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        shipperCode: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        year: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        counter: {
            type: Number,
            default: 0,
            min: 0,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('BoxSequence', boxSequenceSchema);
