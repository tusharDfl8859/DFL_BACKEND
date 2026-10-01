const cron = require('node-cron');
const { getWhatsappConfig } = require('../config/whatsappConfig');
const { processDailyBookingSummaries } = require('../services/dailyBookingSummaryService');
const logger = require('../utils/logger');

let isRunning = false;

/**
 * Job runner function for daily booking summary.
 */
const runDailyBookingSummaryJob = async (options = {}) => {
    if (isRunning) {
        console.warn('[DailyBookingSummaryWorker] Job is already running. Skipping overlapping execution.');
        logger.warn('[DailyBookingSummaryWorker] Job is already running. Skipping overlapping execution.');
        return { success: false, skipped: true, reason: 'Job is already running.' };
    }

    isRunning = true;
    console.log('\n===============================================================');
    console.log('[DailyBookingSummaryWorker] Starting Daily Customer WhatsApp Booking Summary Job...');
    console.log('===============================================================\n');
    logger.info('[DailyBookingSummaryWorker] Starting daily customer WhatsApp booking summary job...');

    try {
        const summaryResult = await processDailyBookingSummaries(options);
        console.log('[DailyBookingSummaryWorker] Daily Booking Summary Job Finished:', JSON.stringify({
            businessDate: summaryResult.businessDate,
            processedCount: summaryResult.processedCount,
            sentCount: summaryResult.sentCount,
            skipped: summaryResult.skipped,
        }));
        logger.info('[DailyBookingSummaryWorker] Daily booking summary job completed:', {
            businessDate: summaryResult.businessDate,
            processedCount: summaryResult.processedCount,
            sentCount: summaryResult.sentCount,
            skipped: summaryResult.skipped,
        });
        return summaryResult;
    } catch (error) {
        console.error('[DailyBookingSummaryWorker] Error running daily booking summary job:', error.message);
        logger.error('[DailyBookingSummaryWorker] Error running daily booking summary job:', error.message);
        return { success: false, error: error.message };
    } finally {
        isRunning = false;
    }
};

/**
 * Setup background cron job for Daily Customer WhatsApp Booking Summary.
 * Defaults to 4:20 PM (20 16 * * *) in Asia/Kolkata timezone.
 */
const setupDailyBookingSummaryCron = () => {
    const config = getWhatsappConfig();
    const cronSchedule = config.dailyBookingSummaryTime || '20 16 * * *';
    const timezone = config.dailyBookingSummaryTimezone || 'Asia/Kolkata';

    cron.schedule(cronSchedule, () => runDailyBookingSummaryJob(), {
        scheduled: true,
        timezone,
    });

    console.log(`[DailyBookingSummaryWorker] Scheduled daily customer WhatsApp booking summary job (${cronSchedule}) in ${timezone} timezone.`);
    logger.info(`[DailyBookingSummaryWorker] Scheduled daily customer WhatsApp booking summary job (${cronSchedule}) in ${timezone} timezone.`);
};

module.exports = {
    setupDailyBookingSummaryCron,
    runDailyBookingSummaryJob,
};
