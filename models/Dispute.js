const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema(
    {
        shipment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Shipment',
            required: true,
            index: true
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        raisedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin', // Assuming Admin model exists, or User with role admin
            required: true
        },
        disputeType: {
            type: String,
            required: true,
            enum: ['Weight Difference', 'Rate Difference', 'Other Charges']
        },
        amount: {
            type: Number,
            required: true,
            min: 0
        },
        reason: {
            type: String,
            required: true
        },
        remarks: {
            type: String
        },
        status: {
            type: String,
            enum: ['Pending', 'Approved', 'Rejected'],
            default: 'Pending',
            index: true
        },
        transactionId: {
            type: String, // Or ObjectId if referencing a Transaction model
            default: null
        },
        rejectionReason: {
            type: String
        },
        bookingDetails: {
            weight: Number,
            volumetricWeight: Number,
            dimensions: String
        },
        actualDetails: {
            weight: Number,
            volumetricWeight: Number,
            dimensions: String
        },
        proofs: [{
            url: { type: String },
            publicId: { type: String },
            fileType: { type: String }, // 'image' or 'pdf'
            originalName: { type: String }
        }],
        invoiceUrl: {
            type: String,
            default: null
        },
        zoho_invoice_id: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true
    }
);

const Dispute = mongoose.model('Dispute', disputeSchema);

module.exports = Dispute;
