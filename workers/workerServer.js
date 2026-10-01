const dns = require('dns');

// Configure DNS resolution safely for both Windows local dev & production servers
try {
    if (dns.setDefaultResultOrder) {
        dns.setDefaultResultOrder('ipv4first');
    }
} catch (err) {
    // Ignore DNS ordering errors on unsupported Node versions
}

const path = require('path');
const dotenv = require('dotenv');

// Load env vars before anything else
dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = require('../config/db');

console.log('[Worker Process] Initializing standalone background worker process...');

// Global unhandled error guards to prevent unexpected crashes or silent blockage
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Worker Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Worker Process] Uncaught Exception thrown:', err);
});

const startWorkerServer = async () => {
    try {
        await connectDB();
        console.log('[Worker Process] MongoDB connected successfully for background jobs.');

        // Startup Validation: Redis Health Check
        const { checkHealth } = require('../config/redisConfig');
        const redisStatus = await checkHealth();
        if (!redisStatus.ok && process.env.BYPASS_REDIS !== 'true') {
            console.error('FATAL: Redis is required for background workers but unavailable.');
            console.error('Error:', redisStatus.message);
            console.error('To run without Redis, set BYPASS_REDIS=true in .env');
            process.exit(1);
        }

        console.log('[Worker Process] Loading BullMQ Queue Workers...');

        // BullMQ Background Workers
        require('./emailWorker');
        require('./bulkBookingWorker');
        require('./whatsappBulkWorker');
        require('./ticketEscalationWorker');
        require('./developerCredentialExpiryWorker');
        require('./livePartnerOutboxPublisherWorker');
        require('./livePartnerBookingWorker');
        require('./carrierReconciliationWorker');
        require('./walletReconciliationWorker');
        require('./tplAutomationWorker');
        require('./rsaSkynetAutomationWorker');
        require('./ebayWorker');
        require('./livePartnerCancellationWorker');
        require('./cancellationReconciliationWorker');
        require('./refundReconciliationWorker');

        console.log('[Worker Process] Initializing Cron Schedulers & Auto-Sync Workers...');

        // Cron Jobs & Schedulers
        const { setupCurrencyRateCron } = require('../jobs/currencyRateJob');
        setupCurrencyRateCron();

        const { setupPickupReportCron } = require('./pickupReportWorker');
        setupPickupReportCron();

        const { setupDailyBookingSummaryCron } = require('./dailyBookingSummaryWorker');
        setupDailyBookingSummaryCron();

        const { setupDailyReportCron } = require('./dailyReportWorker');
        setupDailyReportCron();

        const { setupShipmentDelayCron } = require('./shipmentDelayWorker');
        setupShipmentDelayCron();

        const etsyTrackingSyncWorker = require('./etsyTrackingSyncWorker');
        if (etsyTrackingSyncWorker && typeof etsyTrackingSyncWorker.start === 'function') {
            etsyTrackingSyncWorker.start();
        }

        const shopifyTrackingSyncWorker = require('./shopifyTrackingSyncWorker');
        if (shopifyTrackingSyncWorker && typeof shopifyTrackingSyncWorker.start === 'function') {
            shopifyTrackingSyncWorker.start();
        }

        // Inline Cron: Admin OTP Cleanup every 15 minutes
        const cron = require('node-cron');
        const Admin = require('../models/Admin');
        cron.schedule('*/15 * * * *', async () => {
            try {
                const result = await Admin.updateMany(
                    {
                        otp: { $exists: true, $ne: null },
                        $or: [{ otpExpires: { $lt: new Date() } }, { otpExpires: { $exists: false } }]
                    },
                    { $unset: { otp: "", otpExpires: "" } }
                );
                if (result.modifiedCount > 0) {
                    console.log(`[Worker Cron] Cleared expired OTPs from ${result.modifiedCount} admin accounts.`);
                }
            } catch (err) {
                console.error('[Worker Cron] Admin OTP Cleanup Error:', err.message);
            }
        });

        // Periodic eBay order auto-sync every 30 minutes
        cron.schedule('*/30 * * * *', async () => {
            try {
                const MarketplaceAccount = require('../models/MarketplaceAccount');
                const ebayOrderService = require('../services/ebayOrderService');

                const activeEbayAccounts = await MarketplaceAccount.find({
                    platform: 'eBay',
                    isActive: true,
                    status: 'Connected'
                }).lean();

                for (const account of activeEbayAccounts) {
                    try {
                        await ebayOrderService.importOrders(account.userId);
                    } catch (err) {
                        console.error(`[Worker eBay Cron] Sync error for user ${account.userId}:`, err.message);
                    }
                }
            } catch (cronErr) {
                console.error('[Worker eBay Cron] Scheduler error:', cronErr.message);
            }
        });

        console.log('[Worker Process] All 21 background workers & cron jobs are actively running.');

    } catch (err) {
        console.error('[Worker Process] Fatal startup error:', err);
        process.exit(1);
    }
};

// Graceful shutdown on process termination
const handleGracefulShutdown = async (signal) => {
    console.log(`[Worker Process] Received ${signal}. Shutting down worker process gracefully...`);
    try {
        const mongoose = require('mongoose');
        await mongoose.connection.close(false);
        console.log('[Worker Process] MongoDB connection closed.');
    } catch (closeErr) {
        console.error('[Worker Process] Error closing DB connection:', closeErr.message);
    }
    process.exit(0);
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

startWorkerServer();
