const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let bulkBookingQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Bulk Booking Queue Initialization (Redis Bypassed)');
    bulkBookingQueue = {
        add: async (name, data) => {
            console.log(`[Mock Queue] Job "${name}" received. Instantly executing worker asynchronously...`);
            
            // Execute asynchronously using setImmediate so it doesn't block the request thread
            setImmediate(async () => {
                try {
                    const { processBulkBooking } = require('../workers/bulkBookingWorker');
                    if (processBulkBooking) {
                        await processBulkBooking({ data });
                    } else {
                        console.error('[Mock Queue] processBulkBooking function not found.');
                    }
                } catch (err) {
                    console.error('[Mock Queue] Async execution error:', err);
                }
            });

            return { id: 'mock-job-' + Date.now(), isMock: true };
        },
        on: () => { },
        isMock: true
    };
} else {
    bulkBookingQueue = new Queue('bulk-booking', {
        connection: redisConfig
    });
    bulkBookingQueue.isMock = false;
}

module.exports = bulkBookingQueue;
