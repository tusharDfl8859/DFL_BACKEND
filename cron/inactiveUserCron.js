const cron = require('node-cron');
const { getInactiveUsers, sendBulkReengagement } = require('../services/inactiveUserService');

/**
 * Weekly or Daily re-engagement campaign cron
 * Runs every day at 10 AM
 */
const setupInactiveUserCron = () => {
    // 0 10 * * * - every day at 10:00:00 AM server time
    cron.schedule('0 10 * * *', async () => {
        console.log('[Cron Job] Identifying inactive users for re-engagement...');
        
        try {
            const inactiveUsers = await getInactiveUsers(15); // 15 days inactivity
            const totalUsers = inactiveUsers.length;
            console.log(`[Cron Job] Found ${totalUsers} inactive users.`);

            if (totalUsers > 0) {
                const templateId = process.env.BREVO_REENGAGEMENT_TEMPLATE_ID || 1; // Default template ID
                const { successCount, failureCount } = await sendBulkReengagement(inactiveUsers, Number(templateId));
                console.log(`[Cron Job] Re-engagement campaign completed: ${successCount} sent, ${failureCount} failed.`);
            } else {
                console.log('[Cron Job] No inactive users to notify.');
            }
        } catch (error) {
            console.error('[Cron Job Error]:', error.message);
        }
    });

    console.log('[Cron] Inactive user notification job scheduled for 10:00 AM daily.');
};

module.exports = {
    setupInactiveUserCron
};
