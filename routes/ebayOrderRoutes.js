const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ebayOrderService = require('../services/ebayOrderService');

/**
 * POST /api/ebay-orders/import
 * Fetch orders from eBay and save to the database
 * @access Private
 */
router.post('/import', protect, async (req, res) => {
    try {
        const result = await ebayOrderService.importOrders(req.user._id);

        return res.status(200).json({
            success: true,
            imported: result.imported,
            skipped: result.skipped,
            message: result.message || `Successfully synchronized ${result.imported} orders`
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/ebay-orders
 * Return saved orders from the database
 * @access Private
 */
router.get('/', protect, async (req, res) => {
    try {
        const orders = await ebayOrderService.getOrders(req.user._id);

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
 * GET /api/ebay-orders/:orderId
 * Retrieve details for a single saved order
 * @access Private
 */
router.get('/:orderId', protect, async (req, res) => {
    try {
        const { orderId } = req.params;
        const orders = await ebayOrderService.getOrders(req.user._id);
        const found = orders.find(o => o.ebayOrderId === orderId);

        if (!found) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        return res.status(200).json({
            success: true,
            order: found
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;