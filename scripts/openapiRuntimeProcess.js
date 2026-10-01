#!/usr/bin/env node

require('dotenv').config();

process.env.DISABLE_AUTO_WORKER_START = 'true';

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const {
    checkHealth,
    closeRedisConnection
} = require('../config/redisConfig');

const components = {
    'outbox-publisher': {
        name: 'Step 6A outbox publisher',
        queue: 'live-partner-booking',
        load: () => {
            const publisher = require('../workers/livePartnerOutboxPublisherWorker');
            return {
                start: async () => {
                    publisher.startLivePartnerOutboxPublisher();
                    await publisher.runOnce();
                },
                stop: async () => publisher.stopLivePartnerOutboxPublisher()
            };
        }
    },
    'live-booking-worker': {
        name: 'Live Partner booking worker',
        queue: 'live-partner-booking',
        load: () => {
            const worker = require('../workers/livePartnerBookingWorker');
            return {
                start: worker.startLivePartnerBookingWorker,
                stop: worker.stopLivePartnerBookingWorker
            };
        }
    },
    'carrier-reconciliation-worker': {
        name: 'Carrier reconciliation worker',
        queue: 'carrier-reconciliation',
        load: () => {
            const worker = require('../workers/carrierReconciliationWorker');
            return {
                start: worker.startCarrierReconciliationWorker,
                stop: worker.stopCarrierReconciliationWorker
            };
        }
    },
    'wallet-reconciliation-worker': {
        name: 'Wallet reconciliation worker',
        queue: 'wallet-reconciliation',
        load: () => {
            const worker = require('../workers/walletReconciliationWorker');
            return {
                start: worker.startWalletReconciliationWorker,
                stop: worker.stopWalletReconciliationWorker
            };
        }
    },
    'cancellation-worker': {
        name: 'Live Partner cancellation worker',
        queue: 'live-partner-booking-cancellation',
        load: () => {
            const worker = require('../workers/livePartnerCancellationWorker');
            return {
                start: worker.startLivePartnerCancellationWorker,
                stop: worker.stopLivePartnerCancellationWorker
            };
        }
    },
    'cancellation-reconciliation-worker': {
        name: 'Cancellation reconciliation worker',
        queue: 'partner-api-cancellation-reconciliation',
        load: () => {
            const worker = require('../workers/cancellationReconciliationWorker');
            return {
                start: worker.startCancellationReconciliationWorker,
                stop: worker.stopCancellationReconciliationWorker
            };
        }
    },
    'refund-reconciliation-worker': {
        name: 'Refund reconciliation worker',
        queue: 'partner-api-refund-reconciliation',
        load: () => {
            const worker = require('../workers/refundReconciliationWorker');
            return {
                start: worker.startRefundReconciliationWorker,
                stop: worker.stopRefundReconciliationWorker
            };
        }
    }
};

const componentKey = process.argv[2];
const component = components[componentKey];

if (!component) {
    console.error('Usage: node scripts/openapiRuntimeProcess.js <component>');
    console.error(`Components: ${Object.keys(components).join(', ')}`);
    process.exit(1);
}

if (process.env.BYPASS_REDIS === 'true') {
    console.error('BYPASS_REDIS=true is not allowed for OpenAPI runtime process verification.');
    process.exit(1);
}

let runtime = null;
let shuttingDown = false;

const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[OpenAPI Runtime] ${component.name} received ${signal}. Closing...`);
    try {
        if (runtime?.stop) {
            await runtime.stop();
        }
        await closeRedisConnection();
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        console.log(`[OpenAPI Runtime] ${component.name} shutdown complete.`);
        process.exit(0);
    } catch (error) {
        console.error(`[OpenAPI Runtime] ${component.name} shutdown failed:`, error.message);
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    console.error(`[OpenAPI Runtime] ${component.name} uncaught exception:`, error);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error(`[OpenAPI Runtime] ${component.name} unhandled rejection:`, error);
    process.exit(1);
});

(async () => {
    console.log(`[OpenAPI Runtime] Starting ${component.name}`);
    console.log(`[OpenAPI Runtime] Queue: ${component.queue}`);
    console.log(`[OpenAPI Runtime] Redis: ${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`);

    await connectDB();
    if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB connection was not established.');
    }
    console.log('[OpenAPI Runtime] MongoDB connected.');

    const redisStatus = await checkHealth();
    if (!redisStatus.ok) {
        throw new Error(`Redis connection failed: ${redisStatus.message}`);
    }
    console.log(`[OpenAPI Runtime] Redis connection result: ${redisStatus.message}`);

    runtime = component.load();
    await runtime.start();
    console.log(`[OpenAPI Runtime] ${component.name} running.`);
})();
