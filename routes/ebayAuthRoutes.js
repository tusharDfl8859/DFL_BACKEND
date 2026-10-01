const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const axios = require('axios');
const { protect } = require('../middleware/authMiddleware');
const ebayAuthService = require('../services/ebayAuthService');
const User = require('../models/User');
const Admin = require('../models/Admin');
const MarketplaceAccount = require('../models/MarketplaceAccount');
const cacheService = require('../utils/cacheService');
const { encryptToken } = require('../utils/encryption');

/**
 * GET /api/ebay-auth/authorize
 * Generates the eBay OAuth URL and returns it to the frontend
 * @access Private
 */
router.get('/authorize', protect, async (req, res) => {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        
        // Cache the state mapping to secure the OAuth redirection (valid for 10 minutes)
        cacheService.set(`ebay_oauth_${state}`, {
            userId: req.user._id.toString(),
            role: req.user.role
        }, 600);

        const authUrl = ebayAuthService.getAuthUrl(state);

        return res.status(200).json({
            success: true,
            url: authUrl
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/ebay-auth/callback
 * eBay redirects back to this endpoint with authorization code and state token
 * @access Public
 */
router.get('/callback', async (req, res) => {
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    try {
        const { code, state } = req.query;

        if (!code) {
            return res.redirect(`${frontendUrl}/marketplace?error=missing_code`);
        }

        // Validate the state token against the cache mapping
        const authData = cacheService.get(`ebay_oauth_${state}`);
        if (!authData) {
            return res.redirect(`${frontendUrl}/marketplace?error=invalid_state`);
        }
        
        const { userId, role } = authData;
        cacheService.del(`ebay_oauth_${state}`);
        
        // Exchange the temporary code for access/refresh tokens
        const tokens = await ebayAuthService.exchangeCodeForTokens(code);

        let user = await User.findById(userId);
        let isAdminFlow = false;
        
        if (!user) {
            user = await Admin.findById(userId);
            if (user) {
                isAdminFlow = true;
            }
        }

        if (!user) {
            return res.redirect(`${frontendUrl}/marketplace?error=user_not_found`);
        }
 
        const encryptedAccess = encryptToken(tokens.access_token);
        const encryptedRefresh = encryptToken(tokens.refresh_token);
        const expiryDate = new Date(Date.now() + tokens.expires_in * 1000);

        let shopName = 'eBay Store';
        let shopId = 'ebay_' + userId;

        try {
            const apiBaseUrl = process.env.EBAY_SANDBOX === 'true'
                ? 'https://apiz.sandbox.ebay.com'
                : 'https://apiz.ebay.com';
                
            const identityResponse = await axios.get(`${apiBaseUrl}/commerce/identity/v1/user`, {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            const userData = identityResponse.data;
            if (userData) {
                if (userData.accountType === 'BUSINESS' && userData.businessAccount) {
                    shopName = userData.businessAccount.name || userData.businessAccount.doingBusinessAs || userData.username || 'eBay Store';
                } else if (userData.accountType === 'INDIVIDUAL' && userData.individualAccount) {
                    const ind = userData.individualAccount;
                    shopName = (ind.firstName && ind.lastName) 
                        ? `${ind.firstName} ${ind.lastName}` 
                        : (userData.username || 'eBay Store');
                } else {
                    shopName = userData.username || 'eBay Store';
                }
                
                if (userData.userId) {
                    shopId = userData.userId;
                } else if (userData.username) {
                    shopId = userData.username;
                }
            }
        } catch (identityError) {
            return res.status(500).json({ success: false, message: 'Failed to fetch eBay identity details: ' + identityError.message });
        }

        await MarketplaceAccount.findOneAndUpdate(
            { userId: userId, platform: 'eBay' },
            {
                shopName: shopName,
                shopId: shopId,
                accessToken: encryptedAccess,
                refreshToken: encryptedRefresh,
                tokenExpiry: expiryDate,
                status: 'Connected',
                isActive: true
            },
            { upsert: true, new: true }
        );
 
        // Clear obsolete user.ebayStore field to prevent multi-tenant data conflicts
        if (!isAdminFlow) {
            user.ebayStore = undefined;
            await user.save();
        }

        // Trigger initial background order import immediately upon connection
        try {
            const ebayOrderService = require('../services/ebayOrderService');
            ebayOrderService.importOrders(userId).catch(syncErr => {
                return res.status(500).json({ success: false, message: 'Initial auto-sync error: ' + syncErr.message });
            });
        } catch (initSyncErr) {
            return res.status(500).json({ success: false, message: 'Failed to initiate initial auto-sync: ' + initSyncErr.message });
        }
  
        const isUserAdmin = isAdminFlow || user.role === 'admin' || user.role === 'super_admin';
        const redirectBase = isUserAdmin ? `${frontendUrl}/admin/marketplace` : `${frontendUrl}/marketplace`;
        
        return res.redirect(`${redirectBase}?success=ebay_connected`);
    } catch (error) {
        return res.redirect(`${frontendUrl}/marketplace?error=callback_failed`);
    }
});

/**
 * GET /api/ebay-auth/status
 * Retrieves the user's connection status with eBay
 * @access Private
 */
router.get('/status', protect, async (req, res) => {
    try {
        const account = await MarketplaceAccount.findOne({ userId: req.user._id, platform: 'eBay', isActive: true });
        const connected = !!account && account.status === 'Connected';

        return res.status(200).json({
            success: true,
            connected,
            authorizedAt: account ? account.updatedAt : null
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * DELETE /api/ebay-auth/disconnect
 * Disconnects the user's eBay integration and revokes active credentials
 * @access Private
 */
router.delete('/disconnect', protect, async (req, res) => {
    try {
        await MarketplaceAccount.findOneAndDelete({ userId: req.user._id, platform: 'eBay' });

        const user = await User.findById(req.user._id);
        if (user && user.ebayStore) {
            user.ebayStore = undefined;
            await user.save();
        }

        return res.status(200).json({
            success: true,
            message: 'eBay store disconnected'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
