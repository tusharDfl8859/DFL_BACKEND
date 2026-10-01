const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const { redisConfig } = require('../config/redisConfig');
const { getWhatsappConfig } = require('../config/whatsappConfig');
const { formatPhoneNumber, maskPhoneNumber } = require('../utils/phoneNumberFormatter');
const { sendTemplateMessage } = require('../services/whatsappService');
const WhatsAppBulkCampaign = require('../models/WhatsAppBulkCampaign');
const WhatsAppBulkRecipient = require('../models/WhatsAppBulkRecipient');
const User = require('../models/User');

let whatsappBulkWorker;

const isRetryableError = (errorDetails) => {
    if (!errorDetails) return false;
    const code = String(errorDetails.errorCode || '');
    const status = Number(errorDetails.httpStatus);

    if (code === 'TIMEOUT' || code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
        return true;
    }

    if (status === 429) {
        return true; // Meta rate limit — retry with backoff
    }

    if (status >= 500 && status < 600) {
        return true; // Temporary Meta server error
    }

    // Meta subcodes for transient rate limiting / throughput throttling
    if (code === '131056' || code === '130429') {
        return true;
    }

    return false;
};

const checkAndUpdateCampaignCompletion = async (campaignId) => {
    try {
        const campaign = await WhatsAppBulkCampaign.findById(campaignId);
        if (!campaign) return;

        const total = campaign.totalRecipients || 0;
        const processed = (campaign.sentCount || 0) + (campaign.failedCount || 0);

        if (total > 0 && processed >= total) {
            const finalStatus = campaign.failedCount > 0
                ? (campaign.sentCount > 0 ? 'partial' : 'failed')
                : 'completed';

            await WhatsAppBulkCampaign.updateOne(
                { _id: campaignId },
                {
                    $set: {
                        status: finalStatus,
                        completedAt: new Date(),
                    },
                }
            );
        }
    } catch (err) {
        // Silently handle completion check error
    }
};

const processBulkRecipientJob = async (job) => {
    const {
        campaignId,
        recipientId,
        userId,
        templateName,
        templateLanguage,
        templateVariables = [],
        recipientName,
        recipientPhone,
    } = job.data;

    if (!campaignId || !recipientId) {
        return { success: false, skipped: true, reason: 'Invalid job payload.' };
    }

    // 1. Fetch recipient record
    const recipient = await WhatsAppBulkRecipient.findById(recipientId);
    if (!recipient) {
        return { success: false, skipped: true, reason: 'Recipient record not found.' };
    }

    // 2. STRICT IDEMPOTENCY SAFETY:
    // If recipient is already marked sent, delivered, or read, NEVER call Meta again.
    if (['sent', 'delivered', 'read'].includes(recipient.status)) {
        return {
            success: true,
            skipped: true,
            reason: `Recipient already marked ${recipient.status}. Meta send skipped.`,
            messageId: recipient.messageId,
        };
    }

    // If recipient was already marked failed or skipped, do not repeat
    if (['failed', 'skipped'].includes(recipient.status) && (recipient.attemptCount || 0) >= 3) {
        return {
            success: false,
            skipped: true,
            reason: `Recipient already finalized with status: ${recipient.status}.`,
        };
    }

    // 3. Mark in-progress
    recipient.status = 'processing';
    recipient.attemptCount = (recipient.attemptCount || 0) + 1;
    await recipient.save();

    // Mark campaign as processing and record startedAt if first job
    await WhatsAppBulkCampaign.updateOne(
        { _id: campaignId, status: 'queued' },
        { $set: { status: 'processing', startedAt: new Date() } }
    );

    // 4. Validate and resolve recipient phone
    const config = getWhatsappConfig();
    let rawPhone = recipientPhone;
    let customerName = recipientName;

    if (!rawPhone || !customerName) {
        const userDoc = await User.findById(userId || recipient.userId).select('name phone customerId');
        if (userDoc) {
            rawPhone = rawPhone || userDoc.phone;
            customerName = customerName || userDoc.name || 'Customer';
        }
    }

    const formattedPhone = formatPhoneNumber(rawPhone, config.defaultCountryCode);
    if (!formattedPhone) {
        recipient.status = 'skipped';
        recipient.errorCode = 'INVALID_PHONE';
        recipient.errorMessageSanitized = 'A valid WhatsApp phone number is unavailable.';
        recipient.failedAt = new Date();
        await recipient.save();

        await WhatsAppBulkCampaign.updateOne(
            { _id: campaignId },
            { $inc: { failedCount: 1 } }
        );
        await checkAndUpdateCampaignCompletion(campaignId);

        return {
            success: false,
            skipped: true,
            reason: 'Invalid or missing recipient phone number.',
        };
    }

    // 5. Build dynamic template parameters (interpolate {{name}} if present)
    const finalParameters = Array.isArray(templateVariables)
        ? templateVariables.map((val) => {
            if (typeof val === 'string') {
                return val
                    .replace(/\{\{\s*name\s*\}\}/gi, customerName || 'Customer')
                    .replace(/\{\{\s*customer_name\s*\}\}/gi, customerName || 'Customer');
            }
            return String(val ?? '');
        })
        : [];

    const activeTemplate = templateName || config.bulkTemplate;
    const activeLanguage = templateLanguage || config.bulkTemplateLanguage || 'en';

    let preparedParameters = finalParameters;
    let parameterNames = [];

    // Meta template dfl_customer_announcement has 2 named variables: customer_name and message
    if (activeTemplate === 'dfl_customer_announcement') {
        const custName = customerName || (finalParameters[0] ? finalParameters[0] : 'Valued Customer');
        let messageText = '';
        if (finalParameters.length >= 3) {
            // [ customerName, headline, messageBody ]
            const headline = finalParameters[1] ? String(finalParameters[1]).trim() : '';
            const body = finalParameters[2] ? String(finalParameters[2]).trim() : '';
            messageText = headline ? `*${headline}*\n\n${body}` : body;
        } else if (finalParameters.length === 2) {
            messageText = String(finalParameters[1] ?? '').trim();
        } else if (finalParameters.length === 1) {
            messageText = String(finalParameters[0] ?? '').trim();
        }
        preparedParameters = [custName, messageText];
        parameterNames = ['customer_name', 'message'];
    }

    // Deterministic idempotency key for whatsappService
    const idempotencyKey = `bulk-campaign:${campaignId}:${recipient.userId || userId}`;

    // 6. Send template message using existing WhatsApp service
    const result = await sendTemplateMessage({
        phone: formattedPhone,
        templateName: activeTemplate,
        languageCode: activeLanguage,
        parameters: preparedParameters,
        parameterNames,
        eventType: 'BULK_CAMPAIGN',
        userId: recipient.userId || userId,
        idempotencyKey,
        metadata: {
            campaignId: String(campaignId),
            recipientId: String(recipientId),
        },
    });

    if (result.success && result.messageId) {
        recipient.status = 'sent';
        recipient.messageId = result.messageId;
        recipient.sentAt = new Date();
        recipient.errorCode = null;
        recipient.errorMessageSanitized = null;
        await recipient.save();

        await WhatsAppBulkCampaign.updateOne(
            { _id: campaignId },
            { $inc: { sentCount: 1 } }
        );
        await checkAndUpdateCampaignCompletion(campaignId);

        return {
            success: true,
            messageId: result.messageId,
        };
    }

    // If Meta returned skipped (e.g. duplicate key in WhatsAppNotificationLog)
    if (result.skipped) {
        recipient.status = 'skipped';
        recipient.errorMessageSanitized = result.reason || 'Notification skipped.';
        recipient.failedAt = new Date();
        await recipient.save();

        await WhatsAppBulkCampaign.updateOne(
            { _id: campaignId },
            { $inc: { failedCount: 1 } }
        );
        await checkAndUpdateCampaignCompletion(campaignId);

        return {
            success: false,
            skipped: true,
            reason: result.reason,
        };
    }

    // 7. Handle failure
    const errorDetails = result.errorDetails || {};
    const retryable = isRetryableError(errorDetails);

    if (retryable && recipient.attemptCount < 3) {
        recipient.errorCode = String(errorDetails.errorCode || 'RETRYABLE_ERROR');
        recipient.errorMessageSanitized = errorDetails.errorMessage || 'Temporary dispatch failure.';
        await recipient.save();

        // Throw error to trigger BullMQ exponential backoff
        throw new Error(`[Retryable Bulk WhatsApp Failure]: ${errorDetails.errorMessage || 'Temporary error'}`);
    }

    // Permanent failure or max attempts exhausted
    recipient.status = 'failed';
    recipient.errorCode = String(errorDetails.errorCode || 'DISPATCH_FAILED');
    recipient.errorMessageSanitized = errorDetails.providerMessage || errorDetails.errorMessage || result.error || 'Failed to dispatch WhatsApp template.';
    recipient.failedAt = new Date();
    await recipient.save();

    await WhatsAppBulkCampaign.updateOne(
        { _id: campaignId },
        { $inc: { failedCount: 1 } }
    );
    await checkAndUpdateCampaignCompletion(campaignId);

    return {
        success: false,
        error: recipient.errorMessageSanitized,
        errorCode: recipient.errorCode,
    };
};

// ─── BULLMQ WORKER INITIALIZATION ───────────────────────────────────────────
if (process.env.BYPASS_REDIS === 'true') {
    whatsappBulkWorker = { on: () => { } };
} else {
    const config = getWhatsappConfig();
    whatsappBulkWorker = new Worker('whatsapp-bulk', processBulkRecipientJob, {
        connection: redisConfig,
        concurrency: config.bulkConcurrency || 5,
    });

    whatsappBulkWorker.on('failed', (job, err) => {
        // Logged safely without revealing tokens
    });
}

module.exports = {
    whatsappBulkWorker,
    processBulkRecipientJob,
    isRetryableError,
    checkAndUpdateCampaignCompletion,
};
