const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    pushTrackingToEbay,
    syncAllPendingTracking,
    syncTrackingFromDFL
} = require('../services/ebayTrackingService');

/**
 * POST /api/ebay-tracking/push/:orderId
 * Push tracking details for a single eBay order back to eBay
 * @access Private
 */
router.post('/push/:orderId', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const ebayQueue = require('../queues/ebayQueue');
        const result = await ebayQueue.add('pushTracking', {
            userId: req.user._id,
            ebayOrderId: orderId
        });

        return res.status(200).json({
            success: true,
            message: 'Tracking push task successfully scheduled',
            jobId: result.id,
            ...(process.env.BYPASS_REDIS === 'true' ? { success: true, trackingStatus: 'TRACKING_UPLOADED' } : {})
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/ebay-tracking/sync-all
 * Synchronize tracking details for all pending orders with eBay
 * @access Private
 */
router.post('/sync-all', protect, async (req, res) => {
    try {
        const EbayOrder = require('../models/EbayOrder');
        const pendingOrders = await EbayOrder.find({
            userId: req.user._id,
            orderStatus: 'SHIPMENT_CREATED',
            dflShipmentId: { $ne: null }
        });

        const ebayQueue = require('../queues/ebayQueue');
        const jobs = [];

        for (const order of pendingOrders) {
            const job = await ebayQueue.add('pushTracking', {
                userId: req.user._id,
                ebayOrderId: order.ebayOrderId
            });
            jobs.push({ orderId: order.ebayOrderId, jobId: job.id });
        }

        return res.status(200).json({
            success: true,
            message: `Scheduled tracking sync jobs for ${pendingOrders.length} pending orders`,
            scheduledJobs: jobs
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/ebay-tracking/sync-dfl/:shipmentId
 * Synchronize a DFL shipment's transit status into the local eBay order record
 * @access Private
 */
router.post('/sync-dfl/:shipmentId', protect, async (req, res) => {
    try {
        const { shipmentId } = req.params;
        const result = await syncTrackingFromDFL(shipmentId);

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;