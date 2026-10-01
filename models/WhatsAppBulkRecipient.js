const mongoose = require('mongoose');

const whatsAppBulkRecipientSchema = new mongoose.Schema(
    {
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WhatsAppBulkCampaign',
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        maskedPhone: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedPhoneHash: {
            type: String,
            default: null,
            trim: true,
        },
        status: {
            type: String,
            enum: ['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'skipped'],
            default: 'queued',
            index: true,
        },
        messageId: {
            type: String,
            default: null,
            trim: true,
        },
        attemptCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        errorCode: {
            type: String,
            default: null,
        },
        errorMessageSanitized: {
            type: String,
            default: null,
        },
        queuedAt: {
            type: Date,
            default: Date.now,
        },
        sentAt: {
            type: Date,
            default: null,
        },
        deliveredAt: {
            type: Date,
            default: null,
        },
        readAt: {
            type: Date,
            default: null,
        },
        failedAt: {
            type: Date,
            default: null,
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: () => ({}),
        },
    },
    {
        timestamps: true,
    }
);

// CRITICAL IDEMPOTENCY ENFORCEMENT:
// A user can only exist ONCE as a recipient within the same campaign.
whatsAppBulkRecipientSchema.index(
    { campaignId: 1, userId: 1 },
    { unique: true }
);

// Rapid lookup when webhook returns messageId (Meta wamid)
whatsAppBulkRecipientSchema.index(
    { messageId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            messageId: { $type: 'string' },
        },
    }
);

whatsAppBulkRecipientSchema.index({ campaignId: 1, status: 1 });

module.exports = mongoose.model('WhatsAppBulkRecipient', whatsAppBulkRecipientSchema);
