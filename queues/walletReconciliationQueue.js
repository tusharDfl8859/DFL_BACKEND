const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let walletReconciliationQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Wallet Reconciliation Queue Initialization (Redis Bypassed)');
    walletReconciliationQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-wallet-reconciliation-${Date.now()}`,
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
    walletReconciliationQueue = new Queue('wallet-reconciliation', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.WALLET_RECONCILIATION_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.WALLET_RECONCILIATION_BACKOFF_MS || 30000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    walletReconciliationQueue.isMock = false;
}

module.exports = walletReconciliationQueue;
