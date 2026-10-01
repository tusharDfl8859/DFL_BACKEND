const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: function() { return this.walletOwnerType === 'User'; },
            index: true
        },
        partnerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Partner',
            default: null,
            index: true
        },
        amount: {
            type: Number,
            required: true,
        },
        type: {
            type: String,
            enum: ['credit', 'debit'],
            required: true,
        },
        description: {
            type: String,
            required: true,
        },
        referenceId: {
            type: String, // Can be Shipment ID or Payment Request ID
        },
        isPartnerApiSettlement: {
            type: Boolean,
            default: false,
            index: true
        },
        status: {
            type: String,
            enum: ['success', 'failed', 'pending'],
            default: 'success',
        },
        balanceAfter: {
            type: Number, // Snapshot of balance after transaction
        },
        performedBy: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: 'performedByModel'
        },
        performedByModel: {
            type: String,
            enum: ['User', 'Admin', 'Partner', 'System']
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
            default: 'not_required'
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null
        },
        walletAmount: {
            type: Number,
        },
        processingFee: {
            type: Number,
        },
        totalPaid: {
            type: Number,
        },
        country: {
            type: String,
        },
        partnerApiFinancialReference: {
            type: String,
            trim: true,
            maxlength: 260,
            default: null,
            index: true
        }
    },
    {
        timestamps: true,
    }
);

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ walletOwnerId: 1, createdAt: -1 });
transactionSchema.index({ partnerId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ user: 1, type: 1, createdAt: -1 });
transactionSchema.index({ partnerId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ walletOwnerId: 1, status: 1, createdAt: -1 });
transactionSchema.index(
    { referenceId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isPartnerApiSettlement: true,
            referenceId: { $type: 'string' }
        }
    }
);
transactionSchema.index(
    { partnerApiFinancialReference: 1 },
    {
        unique: true,
        partialFilterExpression: {
            partnerApiFinancialReference: { $type: 'string' }
        },
        name: 'unique_partner_api_financial_reference'
    }
);

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
