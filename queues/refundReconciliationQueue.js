const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let refundReconciliationQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Refund Reconciliation Queue Initialization (Redis Bypassed)');
    refundReconciliationQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-refund-reconciliation-${Date.now()}`,
            name,
            data,
            isMock: true
        }),
        getJobCounts: async () => ({ waiting: 0, delayed: 0, active: 0, paused: 0 }),
        close: async () => undefined,
        on: () => {},
        isMock: true
    };
} else {
    refundReconciliationQueue = new Queue('partner-api-refund-reconciliation', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.REFUND_RECONCILIATION_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.REFUND_RECONCILIATION_BACKOFF_MS || 30000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    refundReconciliationQueue.isMock = false;
}

module.exports = refundReconciliationQueue;
