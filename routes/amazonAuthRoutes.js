const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const axios = require('axios');
const User = require('../models/User');
const Admin = require('../models/Admin');
const amazonService = require('../services/amazonService');
const { encryptText } = require('../utils/cryptoUtils');

/**
 * Automatically resolve correct backend and frontend URLs based on the active domain
 */
const resolveAppUrls = (req) => {
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    if (host.includes('dflexp.in')) {
        return {
            backendUrl: 'https://dflexp.in',
            frontendUrl: 'https://dflexp.in'
        };
    }
    if (host.includes('express.thedflgroup.com')) {
        return {
            backendUrl: 'https://express.thedflgroup.com',
            frontendUrl: 'https://express.thedflgroup.com'
        };
    }
    // When developing locally, the callback must use the registered HTTPS staging domain for Amazon SP-API,
    // while the clientOrigin in state brings the user back to localhost:5173
    return {
        backendUrl: process.env.AMAZON_REDIRECT_URI ? new URL(process.env.AMAZON_REDIRECT_URI).origin : 'https://dflexp.in',
        frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173'
    };
};

/**
 * Safely resolve Amazon credentials from environment, dynamic .env file read, or SystemConfig
 */
const resolveAmazonCredentials = async () => {
    // 1. Direct env check with all supported alias names
    let appId = (
        process.env.AMAZON_APP_ID ||
        process.env.AMAZON_APPLICATION_ID ||
        process.env.AMAZON_SP_APP_ID ||
        process.env.AMAZON_SPAPI_APP_ID ||
        process.env.SP_API_APP_ID ||
        process.env.SP_API_APPLICATION_ID ||
        ''
    ).trim();

    let clientId = (
        process.env.AMAZON_CLIENT_ID ||
        process.env.AMAZON_LWA_CLIENT_ID ||
        process.env.SP_API_CLIENT_ID ||
        ''
    ).trim();

    let clientSecret = (
        process.env.AMAZON_CLIENT_SECRET ||
        process.env.AMAZON_LWA_CLIENT_SECRET ||
        process.env.SP_API_CLIENT_SECRET ||
        ''
    ).trim();

    // 2. Fallback: Check SystemConfig in MongoDB
    if (!appId || !clientId || !clientSecret) {
        try {
            const SystemConfig = require('../models/SystemConfig');
            const doc = await SystemConfig.findOne({
                key: { $in: ['amazonConfig', 'amazonCredentials', 'amazonAppId', 'AMAZON_APP_ID'] }
            }).lean();

            if (doc && doc.value) {
                if (typeof doc.value === 'string' && doc.value.trim() && doc.value !== 'undefined') {
                    if (!appId) appId = doc.value.trim();
                } else if (typeof doc.value === 'object') {
                    const val = doc.value;
                    if (!appId) appId = (val.appId || val.applicationId || val.application_id || val.app_id || '').trim();
                    if (!clientId) clientId = (val.clientId || val.client_id || '').trim();
                    if (!clientSecret) clientSecret = (val.clientSecret || val.client_secret || '').trim();
                }
            }
        } catch (dbErr) {
            console.warn('[AmazonAuth] SystemConfig fallback check failed:', dbErr.message);
        }
    }

    // 3. Fallback: Dynamically re-parse .env files in case PM2 cached old environment variables
    if (!appId || !clientId || !clientSecret) {
        try {
            const dotenv = require('dotenv');
            const path = require('path');
            const fs = require('fs');

            const envPaths = [
                path.resolve(__dirname, '../.env'),
                path.resolve(__dirname, '../../.env'),
                path.resolve(process.cwd(), '.env'),
                path.resolve(process.cwd(), 'Backend/.env')
            ];

            for (const envPath of envPaths) {
                if (fs.existsSync(envPath)) {
                    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
                    if (!appId) {
                        const parsedAppId = (
                            parsed.AMAZON_APP_ID ||
                            parsed.AMAZON_APPLICATION_ID ||
                            parsed.AMAZON_SP_APP_ID ||
                            parsed.AMAZON_SPAPI_APP_ID ||
                            parsed.SP_API_APP_ID ||
                            parsed.SP_API_APPLICATION_ID ||
                            ''
                        ).trim();
                        if (parsedAppId && parsedAppId !== 'undefined') {
                            appId = parsedAppId;
                            process.env.AMAZON_APP_ID = parsedAppId;
                        }
                    }
                    if (!clientId) {
                        const parsedClientId = (parsed.AMAZON_CLIENT_ID || parsed.AMAZON_LWA_CLIENT_ID || parsed.SP_API_CLIENT_ID || '').trim();
                        if (parsedClientId && parsedClientId !== 'undefined') {
                            clientId = parsedClientId;
                            process.env.AMAZON_CLIENT_ID = parsedClientId;
                        }
                    }
                    if (!clientSecret) {
                        const parsedSecret = (parsed.AMAZON_CLIENT_SECRET || parsed.AMAZON_LWA_CLIENT_SECRET || parsed.SP_API_CLIENT_SECRET || '').trim();
                        if (parsedSecret && parsedSecret !== 'undefined') {
                            clientSecret = parsedSecret;
                            process.env.AMAZON_CLIENT_SECRET = parsedSecret;
                        }
                    }
                }
            }
        } catch (reloadErr) {
            console.warn('[AmazonAuth] Dynamic .env reload error:', reloadErr.message);
        }
    }

    // If appId is still not found, check if clientId can serve as appId (in some LWA single-app setups)
    if (!appId && clientId && clientId !== 'undefined') {
        appId = clientId;
    }

    return { appId, clientId, clientSecret };
};

/**
 * @route   GET /api/amazon-auth/authorize
 * @desc    Generate Amazon OAuth URL and redirect
 * @access  Private
 */
router.get('/authorize', protect, async (req, res) => {
    try {
        amazonService.logRuntimeStep('AUTH-AUTHORIZE-01 requested', {
            route: 'GET /api/amazon-auth/authorize',
            userEmail: req.user.email,
            isAdmin: req.user.isAdmin
        });

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        const { appId, clientId } = await resolveAmazonCredentials();

        if (!appId || appId === 'undefined') {
            amazonService.logRuntimeStep('AUTH-AUTHORIZE-02 missing appId', {
                route: 'GET /api/amazon-auth/authorize',
                userEmail: req.user.email
            });
            return res.status(400).json({
                success: false,
                message: 'Amazon Application ID is not configured on the server. Please ensure AMAZON_APP_ID or AMAZON_APPLICATION_ID is set in Backend/.env, and restart the server with: pm2 restart all --update-env'
            });
        }

        const { backendUrl, frontendUrl } = resolveAppUrls(req);

        // Detect caller origin (e.g. localhost:5173 vs dflexp.in vs express.thedflgroup.com)
        const originHeader = req.headers['origin'] || req.headers['referer'] || '';
        let clientOrigin = frontendUrl;
        if (originHeader.includes('localhost:5173')) {
            clientOrigin = 'http://localhost:5173';
        } else if (originHeader.includes('dflexp.in')) {
            clientOrigin = 'https://dflexp.in';
        } else if (originHeader.includes('express.thedflgroup.com')) {
            clientOrigin = 'https://express.thedflgroup.com';
        }

        const isAdmin = Boolean(req.user.isAdmin || req.user.role === 'admin' || req.user.role === 'super_admin');
        const accountType = req.query.userId ? 'user' : (isAdmin ? 'admin' : 'user');
        const targetId = req.query.userId || req.user._id.toString();

        const callbackUrl = `${backendUrl}/api/amazon-auth/callback`;
        const redirectUri = encodeURIComponent(callbackUrl);

        // Encode targetId, accountType, and clientOrigin into state so callback knows exact destination
        const statePayload = {
            id: targetId,
            type: accountType,
            origin: clientOrigin
        };
        const state = encodeURIComponent(Buffer.from(JSON.stringify(statePayload)).toString('base64'));

        const sellerCentralUrl = process.env.AMAZON_SELLER_CENTRAL_URL || 'https://sellercentral.amazon.com';
        const authUrl = `${sellerCentralUrl}/apps/authorize/consent?application_id=${appId}&state=${state}&version=beta&redirect_uri=${redirectUri}`;

        amazonService.logRuntimeStep('AUTH-AUTHORIZE-03 url generated', {
            route: 'GET /api/amazon-auth/authorize',
            hasAppId: Boolean(appId),
            accountType,
            callbackUrl,
            clientOrigin
        });
        res.json({ url: authUrl });

    } catch (error) {
        amazonService.logRuntimeStep('AUTH-AUTHORIZE-99 failed', {
            route: 'GET /api/amazon-auth/authorize',
            errorMessage: error.message
        });
        res.status(500).json({ message: error.message });
    }
});

/**
 * @route   GET /api/amazon-auth/callback
 * @desc    Amazon OAuth Callback (Exchange code for refresh token)
 * @access  Public (Called by Amazon)
 */
router.get('/callback', async (req, res) => {
    try {
        amazonService.logRuntimeStep('AUTH-CALLBACK-01 received', {
            route: 'GET /api/amazon-auth/callback',
            hasOAuthCode: Boolean(req.query.spapi_oauth_code),
            hasState: Boolean(req.query.state),
            hasSellingPartnerId: Boolean(req.query.selling_partner_id)
        });

        const { spapi_oauth_code, state, selling_partner_id } = req.query;

        if (!spapi_oauth_code || !state) {
            return res.status(400).send('Missing required parameters');
        }

        // 1. Exchange code for Refresh Token
        const { backendUrl, frontendUrl } = resolveAppUrls(req);
        const callbackUrl = `${backendUrl}/api/amazon-auth/callback`;
        amazonService.logRuntimeStep('AUTH-CALLBACK-03 exchanging code for token', {
            route: 'GET /api/amazon-auth/callback',
            callbackUrl
        });

        const { clientId, clientSecret } = await resolveAmazonCredentials();
        const effectiveClientId = clientId || process.env.AMAZON_CLIENT_ID;
        const effectiveClientSecret = clientSecret || process.env.AMAZON_CLIENT_SECRET;

        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
            grant_type: 'authorization_code',
            code: spapi_oauth_code,
            client_id: effectiveClientId,
            client_secret: effectiveClientSecret,
            redirect_uri: callbackUrl
        });

        const { refresh_token } = response.data;
        amazonService.logRuntimeStep('AUTH-CALLBACK-04 refresh token received', {
            route: 'GET /api/amazon-auth/callback',
            hasRefreshToken: Boolean(refresh_token)
        });

        // 2. Fetch Store Details from Amazon
        let storeName = 'Amazon Seller';
        let marketplaces = [];

        try {
            const participations = await amazonService.getMarketplaceParticipations(refresh_token);
            if (participations && participations.length > 0) {
                // Use the name from the first marketplace participation as the store name
                storeName = participations[0].marketplace.name;
                marketplaces = participations.map(p => p.marketplace.id);
            }
            amazonService.logRuntimeStep('AUTH-CALLBACK-05 marketplace details resolved', {
                route: 'GET /api/amazon-auth/callback',
                marketplaceCount: marketplaces.length
            });
        } catch (error) {
            amazonService.logRuntimeStep('AUTH-CALLBACK-05 marketplace details failed', {
                route: 'GET /api/amazon-auth/callback',
                errorMessage: error.message
            });
            // Non-fatal, continue with default store name
        }

        // 3. Decode state to identify accountId, accountType, and clientOrigin
        let accountId = state;
        let accountType = 'admin'; // default to admin for safety
        let clientOrigin = frontendUrl;

        try {
            const rawDecoded = decodeURIComponent(state);
            const jsonString = Buffer.from(rawDecoded, 'base64').toString('utf8');
            const parsed = JSON.parse(jsonString);
            if (parsed.id) {
                accountId = parsed.id;
                accountType = parsed.type || 'admin';
                if (parsed.origin) clientOrigin = parsed.origin;
            }
        } catch (e) {
            // Fallback for simple state string
            accountId = decodeURIComponent(state);
            if (accountId.includes(':')) {
                const parts = accountId.split(':');
                accountId = parts[0];
                accountType = parts[1];
            }
        }

        // 4. Map back to account prioritizing specified accountType
        let targetAccount = null;
        if (accountType === 'admin') {
            targetAccount = await Admin.findById(accountId);
            if (!targetAccount) {
                targetAccount = await User.findById(accountId);
                if (targetAccount) accountType = 'user';
            }
        } else {
            targetAccount = await User.findById(accountId);
            if (!targetAccount) {
                targetAccount = await Admin.findById(accountId);
                if (targetAccount) accountType = 'admin';
            }
        }

        if (!targetAccount) {
            amazonService.logRuntimeStep('AUTH-CALLBACK-06 account not found', {
                route: 'GET /api/amazon-auth/callback',
                accountId,
                accountType
            });
            return res.status(404).send('User or Admin account not found');
        }

        // 5. Update Account with Encrypted Amazon Credentials
        targetAccount.amazonStore = {
            refreshToken: encryptText(refresh_token),
            merchantId: selling_partner_id,
            storeName: storeName,
            status: 'connected',
            authorizedAt: new Date(),
            marketplaces: marketplaces
        };

        // Also update user's name if it looks like a placeholder
        if (accountType === 'user' && (targetAccount.name === 'Amazon Marketplace' || targetAccount.name.toLowerCase().includes('placeholder'))) {
            targetAccount.name = storeName;
        }

        await targetAccount.save();
        amazonService.logRuntimeStep('AUTH-CALLBACK-07 store connected', {
            route: 'GET /api/amazon-auth/callback',
            accountEmail: targetAccount.email,
            accountType,
            marketplaceCount: marketplaces.length,
            clientOrigin
        });

        // 6. Redirect back to frontend
        const targetFrontend = clientOrigin || frontendUrl;
        if (accountType === 'admin') {
            res.redirect(`${targetFrontend}/admin/amazon-tracking?status=connected`);
        } else {
            res.redirect(`${targetFrontend}/settings?tab=amazon&status=connected`);
        }
    } catch (error) {
        amazonService.logRuntimeStep('AUTH-CALLBACK-99 failed', {
            route: 'GET /api/amazon-auth/callback',
            errorMessage: error.message
        });
        res.status(500).send('Authentication failed');
    }
});

/**
 * @route   DELETE /api/amazon-auth/disconnect
 * @desc    Disconnect Amazon Store
 * @access  Private
 */
router.delete('/disconnect', protect, async (req, res) => {
    try {
        amazonService.logRuntimeStep('AUTH-DISCONNECT-01 requested', {
            route: 'DELETE /api/amazon-auth/disconnect',
            userEmail: req.user.email
        });

        const user = await User.findById(req.user._id);
        user.amazonStore = {
            status: 'disconnected',
            marketplaces: []
        };
        await user.save();
        amazonService.logRuntimeStep('AUTH-DISCONNECT-03 disconnected', {
            route: 'DELETE /api/amazon-auth/disconnect',
            userEmail: req.user.email
        });
        res.json({ success: true, message: 'Amazon store disconnected' });
    } catch (error) {
        amazonService.logRuntimeStep('AUTH-DISCONNECT-99 failed', {
            route: 'DELETE /api/amazon-auth/disconnect',
            errorMessage: error.message
        });
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
