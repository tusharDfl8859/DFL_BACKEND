const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    importOrders,
    getOrders,
    getRatesForOrder,
    createShipmentForOrder,
    pushTrackingToAmazon
} = require('../services/amazonShipmentService');
const AmazonOrder = require('../models/AmazonOrder');

/**
 * POST /api/amazon-orders/sync
 * Sync unshipped orders directly from Amazon SP-API
 * @access Private
 */
router.post('/sync', protect, async (req, res) => {
    try {
        const result = await importOrders(req.user._id);
        return res.status(200).json({
            success: true,
            imported: result.imported,
            skipped: result.skipped,
            message: result.message || `Successfully synchronized ${result.imported} orders from Amazon`
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/amazon-orders
 * Return saved Amazon orders from the database
 * @access Private
 */
router.get('/', protect, async (req, res) => {
    try {
        const orders = await getOrders(req.user._id, req.query);
        return res.status(200).json({
            success: true,
            count: orders.length,
            orders
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/amazon-orders/:orderId
 * Retrieve details for a single saved Amazon order
 * @access Private
 */
router.get('/:orderId', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await AmazonOrder.findOne({ amazonOrderId: orderId });

        if (!order) {
            return res.status(404).json({
                success: false,
                message: `Amazon order ${orderId} not found`
            });
        }

        return res.status(200).json({
            success: true,
            order
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/amazon-orders/:orderId/rate
 * Calculate DFL shipping rates for an Amazon order
 * @access Private
 */
router.post('/:orderId/rate', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await getRatesForOrder(req.user._id, orderId);

        return res.status(200).json({
            success: true,
            order: result.order,
            rates: result.rates,
            shipperAddress: result.shipperAddress
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/amazon-orders/:orderId/book
 * Book a DFL shipment for an Amazon order
 * @access Private
 * @body { serviceDetails, shipmentDetails }
 */
router.post('/:orderId/book', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { serviceDetails, shipmentDetails } = req.body;

        if (!serviceDetails || !shipmentDetails) {
            return res.status(400).json({
                success: false,
                message: 'serviceDetails and shipmentDetails are required'
            });
        }

        const result = await createShipmentForOrder(
            req.user._id,
            orderId,
            serviceDetails,
            shipmentDetails
        );

        return res.status(201).json({
            success: true,
            shipmentId: result.shipment.shipmentId,
            awbNumber: result.amazonOrder.dflAwbNumber,
            orderStatus: result.amazonOrder.orderStatus,
            shipment: result.shipment
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/amazon-orders/:orderId/confirm-shipment
 * Push AWB and carrier details back to Amazon SP-API (confirmShipment)
 * @access Private
 */
router.post('/:orderId/confirm-shipment', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await AmazonOrder.findOne({ amazonOrderId: orderId });
        if (!order) {
            return res.status(404).json({ success: false, message: 'Amazon order not found' });
        }

        const trackingNumber = req.body.trackingNumber || order.dflAwbNumber;
        const carrierName = req.body.carrierName || order.trackingCarrier || 'DFL Express';

        if (!trackingNumber) {
            return res.status(400).json({ success: false, message: 'Tracking number (AWB) is required' });
        }

        await pushTrackingToAmazon({
            amazonOrderId: order.amazonOrderId,
            trackingNumber,
            carrierName
        });

        const refreshed = await AmazonOrder.findOne({ amazonOrderId: orderId });
        return res.status(200).json({
            success: refreshed.isTrackingSynced,
            orderStatus: refreshed.orderStatus,
            isTrackingSynced: refreshed.isTrackingSynced,
            trackingSyncedAt: refreshed.trackingSyncedAt,
            trackingSyncError: refreshed.trackingSyncError
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
