const mongoose = require('mongoose');

const whatsappNotificationLogSchema = new mongoose.Schema(
    {
        eventType: {
            type: String,
            required: true,
            index: true,
            trim: true,
            uppercase: true,
            match: /^[A-Z][A-Z0-9_]{2,63}$/,
        },
        userId: {
            type: mongoose.Schema?.Types?.ObjectId || mongoose.Types?.ObjectId || String,
            ref: 'User',
            default: null,
            index: true,
        },
        phone: {
            type: String,
            required: true,
        },
        templateName: {
            type: String,
            required: true,
        },
        templateVariables: {
            type: [String],
            default: [],
        },
        provider: {
            type: String,
            default: 'META_WHATSAPP',
        },
        providerMessageId: {
            type: String,
            default: null,
        },
        idempotencyKey: {
            type: String,
            default: null,
        },
        status: {
            type: String,
            enum: ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED'],
            default: 'PENDING',
            index: true,
        },
        errorCode: {
            type: String,
            default: null,
        },
        errorMessage: {
            type: String,
            default: null,
        },
        retryCount: {
            type: Number,
            default: 0,
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
            type: mongoose.Schema?.Types?.Mixed || mongoose.SchemaTypes?.Mixed || Object,
            default: () => ({}),
        },
    },
    {
        timestamps: true,
    }
);

whatsappNotificationLogSchema.index(
    { providerMessageId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            providerMessageId: { $type: 'string' },
        },
    }
);
whatsappNotificationLogSchema.index({ createdAt: -1 });
whatsappNotificationLogSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            idempotencyKey: { $type: 'string' },
        },
    }
);

// A user account should receive at most one signup notification.
whatsappNotificationLogSchema.index(
    { eventType: 1, userId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            eventType: 'SIGNUP_SUCCESS',
            userId: { $type: 'objectId' },
        },
    }
);

module.exports = mongoose.model('WhatsappNotificationLog', whatsappNotificationLogSchema);
