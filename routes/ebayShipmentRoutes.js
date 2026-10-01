const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    getRatesForOrder,
    createShipmentForOrder,
    getShipmentForOrder
} = require('../services/ebayShipmentService');

/**
 * POST /api/ebay-shipments/rate/:orderId
 * Fetch DFL shipping rates for a specific eBay order
 * @access Private
 */
router.post('/rate/:orderId', protect, async (req, res) => {
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
 * POST /api/ebay-shipments/create/:orderId
 * Create a DFL shipment from a verified eBay order
 * @access Private
 * @body { serviceDetails, shipmentDetails }
 */
router.post('/create/:orderId', protect, async (req, res) => {
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
            awbNumber: result.ebayOrder.dflAwbNumber,
            orderStatus: result.ebayOrder.orderStatus,
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
 * GET /api/ebay-shipments/:orderId
 * Retrieve the current DFL shipment status for a synced eBay order
 * @access Private
 */
router.get('/:orderId', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await getShipmentForOrder(req.user._id, orderId);

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