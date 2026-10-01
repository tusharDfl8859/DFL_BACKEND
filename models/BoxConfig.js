const mongoose = require('mongoose');

const boxConfigSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            maxlength: 40,
            unique: true,
            index: true,
        },
        carrier: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Carrier',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        length: {
            type: Number,
            required: true,
            min: 0,
        },
        width: {
            type: Number,
            required: true,
            min: 0,
        },
        height: {
            type: Number,
            required: true,
            min: 0,
        },
        tareWeight: {
            type: Number,
            required: true,
            min: 0,
        },
        maxGrossWeight: {
            type: Number,
            required: true,
            min: 0,
            default: 30,
        },
        active: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('BoxConfig', boxConfigSchema);
