const WhatsAppBulkCampaign = require('../../models/WhatsAppBulkCampaign');
const WhatsAppBulkRecipient = require('../../models/WhatsAppBulkRecipient');
const User = require('../../models/User');
const whatsappBulkQueue = require('../../queues/whatsappBulkQueue');
const { getWhatsappConfig } = require('../../config/whatsappConfig');
const { formatPhoneNumber, maskPhoneNumber } = require('../../utils/phoneNumberFormatter');
const { logActivity } = require('../../utils/activityLogger');

const getAvailableTemplates = async (req, res) => {
    try {
        const config = getWhatsappConfig();

        // One initial generic approved template flow
        const templates = [
            {
                name: config.bulkTemplate || 'dfl_customer_announcement',
                language: config.bulkTemplateLanguage || 'en',
                displayName: 'DFL Customer Announcement',
                description: 'Approved Meta notification template for updates, announcements, and customer notices.',
                category: 'MARKETING',
                variables: [
                    { name: 'customer_name', description: 'Customer Name (auto-populated)', sample: 'Valued Customer' },
                    { name: 'message', description: 'Announcement Message Body', sample: 'We are expanding our express courier routes.' },
                ],
            },
        ];

        return res.json({ success: true, templates });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const createBulkCampaign = async (req, res) => {
    try {
        const config = getWhatsappConfig();

        if (config.bulkEnabled === false) {
            return res.status(403).json({
                success: false,
                message: 'Bulk WhatsApp messaging is currently disabled by administrator configuration.',
            });
        }

        const {
            name,
            templateName,
            templateLanguage,
            templateVariables = [],
            recipientIds = [],
            idempotencyKey,
        } = req.body;

        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Campaign name is required.' });
        }

        if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Please select at least one recipient customer.' });
        }

        // Check for idempotency key collision
        const trimmedIdempotencyKey = String(idempotencyKey || '').trim() || null;
        if (trimmedIdempotencyKey) {
            const existingCampaign = await WhatsAppBulkCampaign.findOne({ idempotencyKey: trimmedIdempotencyKey });
            if (existingCampaign) {
                return res.status(409).json({
                    success: false,
                    message: 'A campaign with this idempotency key has already been created.',
                    campaignId: existingCampaign._id,
                });
            }
        }

        // Deduplicate incoming customer IDs
        const uniqueUserIds = [...new Set(recipientIds.map(String))];

        // Load valid customers from DB
        const users = await User.find(
            { _id: { $in: uniqueUserIds } },
            'name email phone customerId'
        );

        if (users.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid customers found for the selected IDs.' });
        }

        // Filter eligible users with valid formatted phone numbers
        const eligibleUsers = [];
        for (const user of users) {
            const formatted = formatPhoneNumber(user.phone, config.defaultCountryCode);
            if (formatted) {
                eligibleUsers.push({
                    user,
                    formattedPhone: formatted,
                });
            }
        }

        if (eligibleUsers.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'None of the selected customers have a valid mobile/WhatsApp number.',
            });
        }

        const activeTemplate = String(templateName || config.bulkTemplate || 'dfl_bulk_notification').trim();
        const activeLanguage = String(templateLanguage || config.bulkTemplateLanguage || 'en_US').trim();

        // Create Campaign record
        const campaign = await WhatsAppBulkCampaign.create({
            name: name.trim(),
            templateName: activeTemplate,
            templateLanguage: activeLanguage,
            templateVariables: Array.isArray(templateVariables) ? templateVariables.map(String) : [],
            createdBy: req.admin._id,
            status: 'queued',
            totalRecipients: eligibleUsers.length,
            queuedCount: eligibleUsers.length,
            idempotencyKey: trimmedIdempotencyKey,
            metadata: {
                totalRequested: uniqueUserIds.length,
                totalEligible: eligibleUsers.length,
            },
        });

        // Insert Recipient records in bulk with compound unique constraint
        const recipientDocs = eligibleUsers.map(({ user, formattedPhone }) => ({
            campaignId: campaign._id,
            userId: user._id,
            maskedPhone: maskPhoneNumber(formattedPhone),
            status: 'queued',
        }));

        const insertedRecipients = await WhatsAppBulkRecipient.insertMany(recipientDocs, { ordered: false });

        // Build quick lookup map of inserted recipient docs by userId
        const recipientMap = new Map();
        insertedRecipients.forEach((doc) => {
            recipientMap.set(String(doc.userId), doc);
        });

        // Dispatch jobs into BullMQ with deterministic Job ID: bulk-whatsapp:{campaignId}:{userId}
        for (const { user } of eligibleUsers) {
            const recipientDoc = recipientMap.get(String(user._id));
            if (!recipientDoc) continue;

            const jobId = `bulk-whatsapp:${campaign._id}:${user._id}`;
            await whatsappBulkQueue.add(
                'send-bulk-whatsapp',
                {
                    campaignId: campaign._id,
                    recipientId: recipientDoc._id,
                    userId: user._id,
                    templateName: campaign.templateName,
                    templateLanguage: campaign.templateLanguage,
                    templateVariables: campaign.templateVariables,
                    recipientName: user.name,
                    recipientPhone: user.phone,
                },
                { jobId }
            );
        }

        // Audit Logging (safe details only, NO raw phone numbers or tokens)
        await logActivity(req, {
            action: 'CREATE_WHATSAPP_BULK_CAMPAIGN',
            target: campaign._id.toString(),
            targetModel: 'System',
            details: {
                campaignId: campaign._id,
                campaignName: campaign.name,
                templateName: campaign.templateName,
                recipientCount: campaign.totalRecipients,
            },
        });

        return res.status(201).json({
            success: true,
            message: `Bulk WhatsApp campaign "${campaign.name}" created and queued for ${campaign.totalRecipients} customers.`,
            campaign: {
                _id: campaign._id,
                name: campaign.name,
                templateName: campaign.templateName,
                totalRecipients: campaign.totalRecipients,
                status: campaign.status,
                createdAt: campaign.createdAt,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getBulkCampaigns = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;

        const filter = {};
        if (req.query.status) {
            filter.status = req.query.status;
        }

        const [campaigns, total] = await Promise.all([
            WhatsAppBulkCampaign.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('createdBy', 'name email'),
            WhatsAppBulkCampaign.countDocuments(filter),
        ]);

        return res.json({
            success: true,
            campaigns,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getBulkCampaignById = async (req, res) => {
    try {
        const campaign = await WhatsAppBulkCampaign.findById(req.params.id)
            .populate('createdBy', 'name email');

        if (!campaign) {
            return res.status(404).json({ success: false, message: 'Campaign not found.' });
        }

        // Load recipients sample/recent list
        const recipients = await WhatsAppBulkRecipient.find({ campaignId: campaign._id })
            .sort({ updatedAt: -1 })
            .limit(100)
            .populate('userId', 'name customerId');

        return res.json({
            success: true,
            campaign,
            recentRecipients: recipients,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getAvailableTemplates,
    createBulkCampaign,
    getBulkCampaigns,
    getBulkCampaignById,
};
