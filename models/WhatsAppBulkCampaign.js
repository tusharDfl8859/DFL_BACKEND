const mongoose = require('mongoose');

const whatsAppBulkCampaignSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
        },
        templateName: {
            type: String,
            required: true,
            trim: true,
        },
        templateLanguage: {
            type: String,
            default: 'en_US',
            trim: true,
        },
        templateVariables: {
            type: [String],
            default: [],
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            required: true,
            index: true,
        },
        status: {
            type: String,
            enum: ['queued', 'processing', 'completed', 'partial', 'failed'],
            default: 'queued',
            index: true,
        },
        totalRecipients: {
            type: Number,
            default: 0,
            min: 0,
        },
        queuedCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        sentCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        deliveredCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        readCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        failedCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        startedAt: {
            type: Date,
            default: null,
        },
        completedAt: {
            type: Date,
            default: null,
        },
        errorMessage: {
            type: String,
            default: null,
        },
        idempotencyKey: {
            type: String,
            default: null,
            trim: true,
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

whatsAppBulkCampaignSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            idempotencyKey: { $type: 'string' },
        },
    }
);
whatsAppBulkCampaignSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WhatsAppBulkCampaign', whatsAppBulkCampaignSchema);
