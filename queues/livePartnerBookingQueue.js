const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let livePartnerBookingQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Live Partner Booking Queue Initialization (Redis Bypassed)');
    livePartnerBookingQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-live-partner-booking-${Date.now()}`,
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
    livePartnerBookingQueue = new Queue('live-partner-booking', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.LIVE_PARTNER_CARRIER_JOB_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.LIVE_PARTNER_CARRIER_JOB_BACKOFF_MS || 5000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    livePartnerBookingQueue.isMock = false;
}

module.exports = livePartnerBookingQueue;
