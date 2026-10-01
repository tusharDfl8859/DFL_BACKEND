const mongoose = require('mongoose');

const paymentRequestSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: function() { return this.walletOwnerType === 'User'; },
        },
        partnerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Partner',
            default: null,
            index: true
        },
        orderId: {
            type: String,
            required: true,
            // unique: true, // Removed to allow duplicate Order IDs (e.g. for retries or different users using same ref)
        },
        amount: {
            type: Number,
            required: true,
        },
        processingFee: {
            type: Number,
            default: 0
        },
        totalPaid: {
            type: Number,
            default: 0
        },
        cfPaymentId: {
            type: String,
            default: null
        },
        transactionId: {
            type: String,
            required: true,
        },
        paymentDate: {
            type: Date,
            required: true,
        },
        proofUrl: {
            type: String,
            required: true,
        },
        fileType: {
            type: String,
        },
        status: {
            type: String,
            enum: ['Review', 'Pending', 'Completed', 'Rejected'],
            default: 'Review',
        },
        remarks: {
            type: String,
        },
        adminActionBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
        },
        adminActionAt: {
            type: Date,
        },
        adminNotes: [{
            text: String,
            addedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Admin'
            },
            createdAt: {
                type: Date,
                default: Date.now
            }
        }],
        paymentMode: {
            type: String,
            enum: ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash Deposit', 'bank_transfer', 'COUPON', 'Cashfree'],
            default: 'NEFT'
        },
        senderBankName: {
            type: String
        },
        senderAccountName: {
            type: String
        },
        walletOwnerType: {
            type: String,
            enum: ['User', 'Partner'],
            default: 'User'
        },
        walletOwnerId: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: 'walletOwnerType',
            default: null
        },
        approvalStatus: {
            type: String,
            enum: ['not_required', 'pending', 'approved', 'rejected'],
            default: 'pending'
        }
    },
    {
        timestamps: true,
    }
);

const PaymentRequest = mongoose.model('PaymentRequest', paymentRequestSchema);

module.exports = PaymentRequest;
