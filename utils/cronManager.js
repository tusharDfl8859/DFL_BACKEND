const mongoose = require('mongoose');

const ALLOWED_DOMAINS = [
    'express.thedflgroup.com',
    'thedflexpress.com',
    'www.thedflexpress.com'
];

const CronStateSchema = new mongoose.Schema({
    key: { type: String, default: 'CRON_AUTOMATION_STATE', unique: true },
    enabled: { type: Boolean, default: true },
    verifiedHost: { type: String, default: '' },
    lastVerifiedAt: { type: Date, default: Date.now }
});

const CronState = mongoose.models.CronState || mongoose.model('CronState', CronStateSchema);

const inMemoryState = {
    enabled: true,
    isHostVerified: false,
    verifiedHost: ''
};

const normalizeHost = (host) => {
    return String(host || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
};

const isAllowedHost = (host) => {
    const cleanHost = normalizeHost(host);
    return ALLOWED_DOMAINS.includes(cleanHost);
};

const initCronState = async () => {
    try {
        let state = await CronState.findOne({ key: 'CRON_AUTOMATION_STATE' });
        if (!state) {
            state = await CronState.create({
                key: 'CRON_AUTOMATION_STATE',
                enabled: true,
                verifiedHost: '',
                lastVerifiedAt: new Date()
            });
        }
        inMemoryState.enabled = state.enabled !== false;
        if (state.verifiedHost && ALLOWED_DOMAINS.includes(normalizeHost(state.verifiedHost))) {
            inMemoryState.isHostVerified = true;
            inMemoryState.verifiedHost = normalizeHost(state.verifiedHost);
        }
        return { success: true, state };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

const verifyHostFromRequest = async (host) => {
    const cleanHost = normalizeHost(host);
    if (!ALLOWED_DOMAINS.includes(cleanHost)) {
        return { success: false, message: 'Host is not in allowed domains list' };
    }

    inMemoryState.isHostVerified = true;
    inMemoryState.verifiedHost = cleanHost;
    try {
        const result = await CronState.updateOne(
            { key: 'CRON_AUTOMATION_STATE' },
            {
                $set: {
                    verifiedHost: cleanHost,
                    lastVerifiedAt: new Date()
                }
            },
            { upsert: true }
        );
        return { success: true, result };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

const canRunCron = async () => {
    if (inMemoryState.enabled === false) {
        return false;
    }

    try {
        const state = await CronState.findOne({ key: 'CRON_AUTOMATION_STATE' }).lean();
        if (state) {
            if (state.enabled === false) {
                inMemoryState.enabled = false;
                return false;
            }
            if (state.verifiedHost && ALLOWED_DOMAINS.includes(normalizeHost(state.verifiedHost))) {
                inMemoryState.isHostVerified = true;
                inMemoryState.verifiedHost = normalizeHost(state.verifiedHost);
                return true;
            }
        }
    } catch (error) {
        return inMemoryState.isHostVerified && inMemoryState.enabled;
    }

    return inMemoryState.isHostVerified && inMemoryState.enabled;
};

const setCronStatus = async (enable) => {
    const isEnabled = Boolean(enable);
    inMemoryState.enabled = isEnabled;
    try {
        await CronState.updateOne(
            { key: 'CRON_AUTOMATION_STATE' },
            { $set: { enabled: isEnabled } },
            { upsert: true }
        );
        return { success: true, enabled: isEnabled };
    } catch (error) {
        return { success: false, enabled: inMemoryState.enabled, message: error.message };
    }
};

const getCronStatus = async () => {
    try {
        const state = await CronState.findOne({ key: 'CRON_AUTOMATION_STATE' }).lean();
        if (state) {
            return {
                success: true,
                data: {
                    enabled: state.enabled !== false,
                    isHostVerified: Boolean(state.verifiedHost && ALLOWED_DOMAINS.includes(normalizeHost(state.verifiedHost))),
                    verifiedHost: state.verifiedHost || null,
                    lastVerifiedAt: state.lastVerifiedAt || null,
                    allowedDomains: ALLOWED_DOMAINS
                }
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error.message,
            data: {
                enabled: inMemoryState.enabled,
                isHostVerified: inMemoryState.isHostVerified,
                verifiedHost: inMemoryState.verifiedHost || null,
                lastVerifiedAt: null,
                allowedDomains: ALLOWED_DOMAINS
            }
        };
    }

    return {
        success: true,
        data: {
            enabled: inMemoryState.enabled,
            isHostVerified: inMemoryState.isHostVerified,
            verifiedHost: inMemoryState.verifiedHost || null,
            lastVerifiedAt: null,
            allowedDomains: ALLOWED_DOMAINS
        }
    };
};

/**
 * Controller: GET /api/admin/cron-status
 */
const getCronStatusController = async (req, res) => {
    try {
        const statusResult = await getCronStatus();
        if (!statusResult.success) {
            return res.status(500).json({
                success: false,
                message: statusResult.message || 'Failed to retrieve cron status',
                data: statusResult.data
            });
        }
        return res.status(200).json({
            success: true,
            data: statusResult.data
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || 'Server error while fetching cron status'
        });
    }
};

/**
 * Controller: PATCH /api/admin/cron-toggle
 */
const toggleCronController = async (req, res) => {
    try {
        const currentHost = req.headers.host || req.hostname;
        if (!isAllowedHost(currentHost)) {
            return res.status(403).json({
                success: false,
                message: `Forbidden: Cron automation control is only permitted on authorized domains (${ALLOWED_DOMAINS.join(', ')})`
            });
        }

        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Invalid request body: "enabled" must be a boolean (true or false).'
            });
        }

        const updateResult = await setCronStatus(enabled);
        if (!updateResult.success) {
            return res.status(500).json({
                success: false,
                message: updateResult.message || 'Failed to update cron state in database.'
            });
        }

        return res.status(200).json({
            success: true,
            message: `Cron automation ${updateResult.enabled ? 'Enabled' : 'Disabled'} successfully.`,
            enabled: updateResult.enabled
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || 'Server error while updating cron automation state'
        });
    }
};

module.exports = {
    ALLOWED_DOMAINS,
    normalizeHost,
    isAllowedHost,
    initCronState,
    verifyHostFromRequest,
    canRunCron,
    setCronStatus,
    getCronStatus,
    getCronStatusController,
    toggleCronController
};
