const ReportRecipient = require('../models/ReportRecipient');
const logger = require('../utils/logger');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^[6-9]\d{9}$/; // Standard 10-digit Indian mobile number

/**
 * @desc    Get all pickup report recipients, optionally filtered by type
 * @route   GET /api/admin/report-recipients
 * @access  Private (Admin)
 */
const getRecipients = async (req, res) => {
    try {
        const { type } = req.query;
        const query = {};

        if (type) {
            const normalizedType = String(type).trim().toLowerCase();
            if (!['email', 'whatsapp'].includes(normalizedType)) {
                return res.status(400).json({ success: false, message: 'Invalid recipient type filter. Must be email or whatsapp.' });
            }
            query.type = normalizedType;
        }

        const recipients = await ReportRecipient.find(query).sort({ createdAt: -1 }).lean();
        return res.status(200).json({ success: true, count: recipients.length, recipients });
    } catch (error) {
        logger.error(`[ReportRecipientController] Error fetching recipients: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to retrieve recipients.' });
    }
};

/**
 * @desc    Create a new report recipient
 * @route   POST /api/admin/report-recipients
 * @access  Private (Admin)
 */
const createRecipient = async (req, res) => {
    try {
        const { name, type, value } = req.body;

        // 1. Validate name
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'Name is required and must be at least 2 characters long.' });
        }

        // 2. Validate type
        const normalizedType = String(type || '').trim().toLowerCase();
        if (!['email', 'whatsapp'].includes(normalizedType)) {
            return res.status(400).json({ success: false, message: 'Invalid recipient type. Must be email or whatsapp.' });
        }

        // 3. Validate contact value
        let cleanValue = String(value || '').trim();
        if (!cleanValue) {
            return res.status(400).json({ success: false, message: 'Contact value (email or phone number) is required.' });
        }

        if (normalizedType === 'email') {
            cleanValue = cleanValue.toLowerCase();
            if (!EMAIL_REGEX.test(cleanValue)) {
                return res.status(400).json({ success: false, message: 'Invalid email format.' });
            }
        } else if (normalizedType === 'whatsapp') {
            cleanValue = cleanValue.replace(/\D/g, ''); // strip any non-digit formatting
            // Handle +91 or 91 prefix if entered by mistake
            if (cleanValue.length === 12 && cleanValue.startsWith('91')) {
                cleanValue = cleanValue.slice(2);
            }
            if (cleanValue.length !== 10 || !PHONE_REGEX.test(cleanValue)) {
                return res.status(400).json({ success: false, message: 'Invalid phone number. Must be a valid 10-digit mobile number.' });
            }
        }

        // 4. Check for duplicate entry
        const existingRecipient = await ReportRecipient.findOne({
            type: normalizedType,
            value: cleanValue
        });

        if (existingRecipient) {
            return res.status(400).json({
                success: false,
                message: `This ${normalizedType === 'email' ? 'email' : 'phone number'} is already added.`
            });
        }

        // 5. Create recipient
        const newRecipient = await ReportRecipient.create({
            name: name.trim(),
            type: normalizedType,
            value: cleanValue,
            isActive: true
        });

        logger.info(`[ReportRecipientController] Created recipient: ${newRecipient.name} (${newRecipient.type}: ${newRecipient.value}) by admin ${req.admin?.email || req.admin?._id}`);
        return res.status(201).json({
            success: true,
            message: `${newRecipient.name} (${newRecipient.type}) added to report recipients.`,
            recipient: newRecipient
        });
    } catch (error) {
        logger.error(`[ReportRecipientController] Error creating recipient: ${error.message}`);
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'This email or phone number is already registered.' });
        }
        return res.status(500).json({ success: false, message: 'Failed to create recipient.' });
    }
};

/**
 * @desc    Toggle recipient active status
 * @route   PATCH /api/admin/report-recipients/:id/toggle
 * @access  Private (Admin)
 */
const toggleRecipientStatus = async (req, res) => {
    try {
        const { id } = req.params;

        const recipient = await ReportRecipient.findById(id);
        if (!recipient) {
            return res.status(404).json({ success: false, message: 'Recipient not found.' });
        }

        recipient.isActive = !recipient.isActive;
        await recipient.save();

        logger.info(`[ReportRecipientController] Toggled recipient ${recipient._id} status to ${recipient.isActive ? 'Active' : 'Inactive'}`);
        return res.status(200).json({
            success: true,
            message: `Recipient marked as ${recipient.isActive ? 'Active' : 'Inactive'}.`,
            recipient
        });
    } catch (error) {
        logger.error(`[ReportRecipientController] Error toggling recipient status: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to update recipient status.' });
    }
};

/**
 * @desc    Permanently delete a recipient
 * @route   DELETE /api/admin/report-recipients/:id
 * @access  Private (Admin)
 */
const deleteRecipient = async (req, res) => {
    try {
        const { id } = req.params;

        const recipient = await ReportRecipient.findByIdAndDelete(id);
        if (!recipient) {
            return res.status(404).json({ success: false, message: 'Recipient not found.' });
        }

        logger.info(`[ReportRecipientController] Deleted recipient ${recipient.name} (${recipient.type}: ${recipient.value})`);
        return res.status(200).json({
            success: true,
            message: 'Recipient removed successfully.'
        });
    } catch (error) {
        logger.error(`[ReportRecipientController] Error deleting recipient: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Failed to delete recipient.' });
    }
};

/**
 * @desc    Manually trigger pickup report dispatch
 * @route   POST /api/admin/report-recipients/trigger-now
 * @access  Private (Admin)
 */
const triggerPickupReportManually = async (req, res) => {
    try {
        const { cronName } = req.body;
        const validNames = ['9:30_AM', '1:30_PM', '7:30_PM'];
        const selectedSlot = validNames.includes(cronName) ? cronName : '9:30_AM';

        const { runPickupReportJob } = require('../workers/pickupReportWorker');
        const result = await runPickupReportJob(selectedSlot);

        if (result && result.success) {
            const successMsg = result.totalPendingCount === 0
                ? `No pending pickups found for the ${selectedSlot.replace('_', ' ')} slot.`
                : `Pickup report (${selectedSlot.replace('_', ' ')}) dispatched successfully. Total items: ${result.totalPendingCount} (${result.shipmentsCount} Shipments + ${result.manifestsCount} Manifests).`;
            return res.status(200).json({
                success: true,
                message: successMsg,
                result
            });
        } else {
            return res.status(500).json({
                success: false,
                message: result?.error || 'Failed to dispatch report.'
            });
        }
    } catch (error) {
        logger.error(`[ReportRecipientController] Error manually triggering report: ${error.message}`);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getRecipients,
    createRecipient,
    toggleRecipientStatus,
    deleteRecipient,
    triggerPickupReportManually
};
