const mongoose = require('mongoose');

const ukNonServiceablePostcodeSchema = new mongoose.Schema({
    prefix: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        index: true
    },
    remarks: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('UKNonServiceablePostcode', ukNonServiceablePostcodeSchema);
