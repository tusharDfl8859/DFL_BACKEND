const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let livePartnerCancellationQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Live Partner Cancellation Queue Initialization (Redis Bypassed)');
    livePartnerCancellationQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-live-partner-cancellation-${Date.now()}`,
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
    livePartnerCancellationQueue = new Queue('live-partner-booking-cancellation', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.LIVE_PARTNER_CANCELLATION_JOB_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.LIVE_PARTNER_CANCELLATION_JOB_BACKOFF_MS || 5000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    livePartnerCancellationQueue.isMock = false;
}

module.exports = livePartnerCancellationQueue;
