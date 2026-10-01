const mongoose = require('mongoose');

const carrierSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            unique: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },
        emails: [{
            type: String,
            trim: true,
            lowercase: true,
        }],
        active: {
            type: Boolean,
            default: true,
            index: true,
        },
        notes: {
            type: String,
            default: '',
            trim: true,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Carrier', carrierSchema);
