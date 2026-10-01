const emailQueue = require('../../queues/emailQueue');

const SUBJECTS = {
    DEVELOPER_APPLICATION_SUBMITTED: 'Partner API access request submitted',
    DEVELOPER_APPLICATION_MORE_INFORMATION_REQUIRED: 'Partner API request needs more information',
    DEVELOPER_SANDBOX_APPROVED: 'Partner API Sandbox access approved',
    DEVELOPER_APPLICATION_REJECTED: 'Partner API access request update',
    PRODUCTION_ACCESS_REQUESTED: 'Partner API Production access request submitted',
    PRODUCTION_REQUEST_UPDATED: 'Partner API Production access request updated',
    PRODUCTION_REVIEW_STARTED: 'Partner API Production review started',
    PRODUCTION_REVIEWER_ASSIGNED: 'Partner API Production reviewer assigned',
    PRODUCTION_MORE_INFORMATION_REQUIRED: 'Partner API Production request needs more information',
    PRODUCTION_REQUEST_REJECTED: 'Partner API Production request update',
    PRODUCTION_ACCESS_APPROVED: 'Partner API Live access approved'
};

const notifyDeveloperApplicationEvent = async (event, { user, application, message }) => {
    if (process.env.DEVELOPER_PORTAL_SEND_EMAILS !== 'true') {
        return { sent: false, skipped: true, reason: 'developer portal email notifications disabled' };
    }

    if (!user?.email) {
        return { sent: false, skipped: true, reason: 'customer email missing' };
    }

    try {
        await emailQueue.add('send-email', {
            email: user.email,
            subject: SUBJECTS[event] || 'Partner API request update',
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.5;">
                    <h2>Partner API request update</h2>
                    <p>${message || 'Your Partner API request has been updated.'}</p>
                    <p><strong>Application ID:</strong> ${application.applicationId}</p>
                </div>
            `
        });
        return { sent: true };
    } catch (error) {
        console.error('Developer portal notification failed:', error && error.message ? error.message : error);
        return { sent: false, error: 'notification_failed' };
    }
};

module.exports = {
    notifyDeveloperApplicationEvent
};
