const mongoose = require('mongoose');

const inactiveCustomerAlertSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true
        },
        lastBookingDate: {
            type: Date,
            default: null
        },
        status: {
            type: String,
            enum: ['active', 'closed'],
            default: 'active',
            index: true
        },
        remarks: [
            {
                comment: { type: String, required: true },
                addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
                addedByName: { type: String },
                createdAt: { type: Date, default: Date.now }
            }
        ]
    },
    {
        timestamps: true
    }
);

const InactiveCustomerAlert = mongoose.model('InactiveCustomerAlert', inactiveCustomerAlertSchema);

module.exports = InactiveCustomerAlert;
