const cron = require('node-cron');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const sendEmail = require('../utils/emailService');
const logger = require('../utils/logger');
const { evaluateShipmentDelays } = require('../utils/shipmentDelayCalculator');
const { generateShipmentDelayReportEmail } = require('../utils/emailTemplates');

let isRunning = false;

/**
 * Execute Shipment Delay evaluation and email dispatch
 */
const runShipmentDelayJob = async () => {
    if (isRunning) {
        logger.warn('[ShipmentDelayWorker] Job already running. Skipping execution.');
        return { success: false, skipped: true };
    }

    isRunning = true;
    logger.info('[ShipmentDelayWorker] Starting shipment delay evaluation & report generation...');

    try {
        const activeShipments = await Shipment.find({
            status: { $nin: ['Delivered', 'Cancelled'] }
        }).populate('user', 'name email kycData').lean();

        const pickupDelays = [];
        const dispatchDelays = [];
        const deliveryDelays = [];

        const now = new Date();

        for (const shipment of activeShipments) {
            const delayEval = evaluateShipmentDelays(shipment, now);
            if (delayEval.isDelayed) {
                shipment.delayMetrics = delayEval;
                if (delayEval.delayType === 'pickup_delay') {
                    pickupDelays.push(shipment);
                } else if (delayEval.delayType === 'dispatch_delay') {
                    dispatchDelays.push(shipment);
                } else if (delayEval.delayType === 'delivery_delay') {
                    deliveryDelays.push(shipment);
                }
            }
        }

        const totalDelays = pickupDelays.length + dispatchDelays.length + deliveryDelays.length;

        if (totalDelays === 0) {
            logger.info('[ShipmentDelayWorker] No delayed shipments detected today.');
            return { success: true, count: 0 };
        }

        const htmlContent = generateShipmentDelayReportEmail({
            pickupDelays,
            dispatchDelays,
            deliveryDelays
        });

        const targetEmails = ['kaushal.tech@thedflgroup.com', 'rg@thedflgroup.com'];
        const dateStr = now.toLocaleDateString('en-GB');

        await sendEmail({
            email: targetEmails.join(', '),
            subject: `🚨 DFL Shipment Delay Operational Alert Summary - ${dateStr} [${totalDelays} Delayed]`,
            html: htmlContent
        });

        logger.info(`[ShipmentDelayWorker] Successfully sent delay report email for ${totalDelays} delayed shipments to ${targetEmails.join(', ')}.`);
        return {
            success: true,
            totalDelays,
            pickupCount: pickupDelays.length,
            dispatchCount: dispatchDelays.length,
            deliveryCount: deliveryDelays.length
        };

    } catch (error) {
        logger.error('[ShipmentDelayWorker] Error running delay report job:', error.message);
        return { success: false, error: error.message };
    } finally {
        isRunning = false;
    }
};

/**
 * Setup daily cron schedule at 9:00 AM IST
 */
const setupShipmentDelayCron = () => {
    // 0 9 * * * corresponds to 9:00 AM daily
    const cronSchedule = '0 9 * * *';
    const timezone = 'Asia/Kolkata';

    cron.schedule(cronSchedule, () => {
        runShipmentDelayJob();
    }, {
        scheduled: true,
        timezone
    });

    logger.info(`[ShipmentDelayWorker] Scheduled daily shipment delay worker at ${cronSchedule} (${timezone}).`);
};

module.exports = {
    setupShipmentDelayCron,
    runShipmentDelayJob
};
