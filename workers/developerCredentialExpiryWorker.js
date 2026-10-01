const cron = require('node-cron');
const { expireSecondaryCredentials } = require('../services/openapi/developerPortalCredentialService');

const scheduleCredentialExpiryWorker = () => {
    if (process.env.NODE_ENV === 'test') {
        return null;
    }

    const expression = process.env.DEVELOPER_CREDENTIAL_EXPIRY_CRON || '*/15 * * * *';
    return cron.schedule(expression, async () => {
        try {
            await expireSecondaryCredentials();
        } catch (error) {
            console.error('[DeveloperCredentialExpiryWorker] sweep failed:', error.message);
        }
    });
};

const scheduledTask = scheduleCredentialExpiryWorker();

module.exports = {
    expireSecondaryCredentials,
    scheduledTask
};
