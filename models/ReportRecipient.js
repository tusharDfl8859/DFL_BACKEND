const mongoose = require('mongoose');

const reportRecipientSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        minlength: [2, 'Name must be at least 2 characters long']
    },
    type: {
        type: String,
        required: [true, 'Recipient type is required'],
        enum: {
            values: ['email', 'whatsapp'],
            message: 'Type must be either email or whatsapp'
        },
        lowercase: true,
        trim: true
    },
    value: {
        type: String,
        required: [true, 'Recipient contact value is required'],
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Enforce uniqueness per channel type to avoid duplicate emails or phone numbers
reportRecipientSchema.index({ type: 1, value: 1 }, { unique: true });

module.exports = mongoose.model('ReportRecipient', reportRecipientSchema);
