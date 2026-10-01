const express = require('express');
const router = express.Router();
const {
    handleAccountDeletion,
    handleAccountClosure,
    generateChallengeResponse
} = require('../services/ebayComplianceService');

/**
 * GET /api/ebay-compliance/account-deletion
 * eBay endpoint verification challenge
 * @access Public
 */
router.get('/account-deletion', (req, res) => {
    try {
        const { challenge_code } = req.query;

        if (!challenge_code) {
            return res.status(400).json({
                success: false,
                message: 'Missing challenge_code'
            });
        }

        const response = generateChallengeResponse(challenge_code);

        return res.status(200).json(response);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/ebay-compliance/account-deletion
 * eBay Account Deletion Notification
 * @access Public
 */
router.post('/account-deletion', async (req, res) => {
    try {
        // Acknowledge immediately — eBay requires fast response
        res.status(200).json({ success: true });

        // Process deletion in background
        const notification = req.body;
        const topic = notification?.metadata?.topic ||
                      notification?.topic ||
                      'MARKETPLACE_ACCOUNT_DELETION';

        if (topic === 'MARKETPLACE_ACCOUNT_DELETION' ||
            topic === 'MARKETPLACE_ACCOUNT_CLOSURE') {
            await handleAccountDeletion(notification);
        }
    } catch (error) {
        // Already responded 200 — silence internal logs to comply with production requirements
    }
});

/**
 * POST /api/ebay-compliance/account-closure
 * eBay Account Closure Notification
 * @access Public
 */
router.post('/account-closure', async (req, res) => {
    try {
        res.status(200).json({ success: true });
        await handleAccountClosure(req.body);
    } catch (error) {
        // Already responded 200 — silence internal logs
    }
});

/**
 * GET /api/ebay-compliance/health
 * Health check for eBay compliance endpoints
 * @access Public
 */
router.get('/health', (req, res) => {
    return res.status(200).json({
        success: true,
        message: 'eBay Compliance endpoint is active',
        endpoints: {
            accountDeletion: '/api/ebay-compliance/account-deletion',
            accountClosure: '/api/ebay-compliance/account-closure'
        },
        timestamp: new Date().toISOString()
    });
});

module.exports = router;