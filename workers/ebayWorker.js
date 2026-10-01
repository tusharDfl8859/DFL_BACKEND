const { Worker } = require('bullmq');
const { getRedisConnection } = require('../config/redisConfig');
const { importOrders } = require('../services/ebayOrderService');
const { pushTrackingToEbay } = require('../services/ebayTrackingService');
const MarketplaceLog = require('../models/MarketplaceLog');

let ebayWorker;

/**
 * BullMQ job processor for eBay background integration tasks
 */
const processEbayJob = async (job) => {
    const { name, data } = job;
    
    try {
        if (name === 'syncOrders') {
            const result = await importOrders(data.userId);
            
            // Log sync success metadata
            await MarketplaceLog.create({
                userId: data.userId,
                platform: 'eBay',
                action: 'OrderSync',
                status: 'Success',
                message: `Background sync completed. Imported: ${result.imported}, Skipped: ${result.skipped}`
            }).catch((logErr) => {
                const logFailed = logErr.message;
            });
            
            return result;
            
        } else if (name === 'pushTracking') {
            const result = await pushTrackingToEbay(data.userId, data.ebayOrderId);
            
            // Log push success
            await MarketplaceLog.create({
                userId: data.userId,
                platform: 'eBay',
                action: 'TrackingSync',
                status: 'Success',
                message: `Successfully synchronized tracking for eBay Order #${data.ebayOrderId}`
            }).catch((logErr) => {
                const logFailed = logErr.message;
            });
            
            return result;
        } else {
            throw new Error(`Unsupported job type: ${name}`);
        }
    } catch (error) {
        // On tracking push failures, update the order status in the DB
        if (name === 'pushTracking') {
            try {
                const EbayOrder = require('../models/EbayOrder');
                await EbayOrder.updateOne(
                    { ebayOrderId: data.ebayOrderId, userId: data.userId },
                    { trackingStatus: 'UPLOAD_FAILED' }
                );
            } catch (updateErr) {
                const updateFailed = updateErr.message;
            }
        }

        // Log errors to MarketplaceLog database collection for admin audit visibility
        await MarketplaceLog.create({
            userId: data.userId,
            platform: 'eBay',
            action: name === 'syncOrders' ? 'OrderSync' : 'TrackingSync',
            status: 'Error',
            message: name === 'syncOrders'
                ? `Failed to sync eBay orders: ${error.message}`
                : `Failed to push tracking for eBay Order #${data.ebayOrderId}: ${error.message}`,
            details: { errorStack: error.stack, jobData: data }
        }).catch((logErr) => {
            const logFailed = logErr.message;
        });
        
        // Re-throw so BullMQ registers the failure and schedules retry according to backoff rules
        throw error;
    }
};

// ─── WORKER INIT ─────────────────────────────────────────────────────────────
if (process.env.BYPASS_REDIS === 'true') {
    ebayWorker = { on: () => {} };
} else {
    ebayQueueConnection = getRedisConnection();
    ebayWorker = new Worker('ebay-queue', processEbayJob, {
        connection: ebayQueueConnection,
        concurrency: 5
    });
    
    // Log failures or retries in console only when not bypassed (worker event logs)
    ebayWorker.on('failed', (job, err) => {
        // Job permanently failed after all retries
    });
}

module.exports = {
    ebayWorker,
    processEbayJob
};
