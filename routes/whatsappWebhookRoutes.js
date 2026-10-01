const express = require('express');
const WhatsappNotificationLog = require('../models/WhatsappNotificationLog');

const router = express.Router();

const normalizeStatus = (status) => {
    const normalized = String(status || '').trim().toLowerCase();

    if (normalized === 'delivered') return 'DELIVERED';
    if (normalized === 'read') return 'READ';
    if (normalized === 'failed') return 'FAILED';
    if (normalized === 'sent') return 'SENT';

    return null;
};

const getStatusTimestamp = (timestamp) => {
    const seconds = Number(timestamp);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
};

router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim();

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

const { handleIncomingWhatsAppMessage } = require('../services/whatsappBotService');

router.post('/webhook', async (req, res) => {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    // 1. Process Incoming User Chat Messages (Bot Automation)
    const incomingMessages = entries.flatMap((entry) =>
        (Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) =>
            Array.isArray(change?.value?.messages) ? change.value.messages : []
        )
    );

    if (incomingMessages.length > 0) {
        await Promise.all(incomingMessages.map(async (msg) => {
            const fromPhone = msg.from;
            const textMessage = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
            const buttonPayload = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;

            try {
                await handleIncomingWhatsAppMessage({ fromPhone, textMessage, buttonPayload });
            } catch (botErr) {
                // Silently swallow or handle error internally
            }
        }));
    }

    // 2. Process Delivery Status Events (SENT, DELIVERED, READ, FAILED)
    const statusEvents = entries.flatMap((entry) =>
        (Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) =>
            Array.isArray(change?.value?.statuses) ? change.value.statuses : []
        )
    );

    if (statusEvents.length === 0 && incomingMessages.length === 0) {
        return res.sendStatus(200);
    }

    await Promise.all(statusEvents.map(async (statusEvent) => {
        const providerMessageId = String(statusEvent?.id || '').trim();
        const status = normalizeStatus(statusEvent?.status);
        const timestamp = getStatusTimestamp(statusEvent?.timestamp);
        const firstError = Array.isArray(statusEvent?.errors) ? statusEvent.errors[0] : null;

        if (!providerMessageId || !status) {
            return;
        }

        const update = {
            status,
            'metadata.lastWebhookStatus': statusEvent?.status || null,
            'metadata.lastWebhookPayload': statusEvent,
        };

        if (status === 'SENT') update.sentAt = timestamp;
        if (status === 'DELIVERED') update.deliveredAt = timestamp;
        if (status === 'READ') update.readAt = timestamp;
        if (status === 'FAILED') {
            update.failedAt = timestamp;
            update.errorCode = firstError?.code ? String(firstError.code) : 'META_DELIVERY_FAILED';
            update.errorMessage = firstError?.message || firstError?.error_data?.details || firstError?.title || 'WhatsApp delivery failed.';
        }

        await WhatsappNotificationLog.updateOne(
            { providerMessageId },
            { $set: update }
        );

        // Additive: Update WhatsApp Bulk Campaign recipient & aggregate stats if belongs to a campaign
        try {
            const WhatsAppBulkRecipient = require('../models/WhatsAppBulkRecipient');
            const WhatsAppBulkCampaign = require('../models/WhatsAppBulkCampaign');

            const bulkRecipient = await WhatsAppBulkRecipient.findOne({ messageId: providerMessageId });
            if (bulkRecipient) {
                const previousStatus = String(bulkRecipient.status || '').toLowerCase();
                const newStatusLower = status.toLowerCase();
                const bulkUpdate = { status: newStatusLower };

                if (status === 'DELIVERED') bulkUpdate.deliveredAt = timestamp;
                if (status === 'READ') bulkUpdate.readAt = timestamp;
                if (status === 'FAILED') {
                    bulkUpdate.failedAt = timestamp;
                    bulkUpdate.errorCode = firstError?.code ? String(firstError.code) : 'META_DELIVERY_FAILED';
                    bulkUpdate.errorMessageSanitized = firstError?.message || firstError?.error_data?.details || firstError?.title || 'WhatsApp delivery failed.';
                }

                await WhatsAppBulkRecipient.updateOne({ _id: bulkRecipient._id }, { $set: bulkUpdate });

                const incUpdate = {};
                if (status === 'DELIVERED' && previousStatus !== 'delivered' && previousStatus !== 'read') {
                    incUpdate.deliveredCount = 1;
                }
                if (status === 'READ' && previousStatus !== 'read') {
                    incUpdate.readCount = 1;
                    if (previousStatus !== 'delivered') {
                        incUpdate.deliveredCount = 1;
                    }
                }
                if (status === 'FAILED' && previousStatus !== 'failed') {
                    incUpdate.failedCount = 1;
                }

                if (Object.keys(incUpdate).length > 0) {
                    await WhatsAppBulkCampaign.updateOne({ _id: bulkRecipient.campaignId }, { $inc: incUpdate });
                }
            }
        } catch (bulkErr) {
            // Failsafe: error in bulk stats should never break webhook response
        }
    }));

    return res.sendStatus(200);
});

module.exports = router;
