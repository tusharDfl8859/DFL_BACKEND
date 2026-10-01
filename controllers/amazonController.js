const amazonService = require('../services/amazonService');
const User = require('../models/User');
const Admin = require('../models/Admin');

/**
 * @desc    Check Amazon Connection Status
 * @route   GET /api/amazon/connection-status
 * @access  Private
 */
const checkConnectionStatus = async (req, res) => {
    try {
        let account = await User.findById(req.user._id);
        if (!account) {
            account = await Admin.findById(req.user._id);
        }
        
        if (!account || !account.amazonStore || account.amazonStore.status !== 'connected') {
            return res.json({ connected: false });
        }

        res.json({
            connected: true,
            storeName: account.amazonStore.storeName || 'Amazon Store',
            authorizedAt: account.amazonStore.authorizedAt
        });
    } catch (error) {
        console.error('Error checking Amazon connection status:', error);
        res.status(500).json({ message: 'Server error checking connection status' });
    }
};

/**
 * @desc    Sync orders from Amazon
 * @route   POST /api/amazon/sync
 * @access  Private
 */
const syncAmazonOrders = async (req, res) => {
    try {
        let account = await User.findById(req.user._id);
        if (!account) {
            account = await Admin.findById(req.user._id);
        }

        if (!account || !account.amazonStore || account.amazonStore.status !== 'connected') {
            return res.status(400).json({ message: 'Amazon store is not connected.' });
        }

        const newOrdersCount = await amazonService.syncOrders(req.user._id);

        res.json({
            success: true,
            message: `Successfully synced ${newOrdersCount} new orders from Amazon.`,
            count: newOrdersCount
        });
    } catch (error) {
        console.error('Error syncing Amazon orders:', error);
        res.status(500).json({ message: error.message || 'Failed to sync Amazon orders' });
    }
};

module.exports = {
    checkConnectionStatus,
    syncAmazonOrders
};
