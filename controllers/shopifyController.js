const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const shopifyAuthService = require('../services/shopifyAuthService');
const shopifyOrderService = require('../services/shopifyOrderService');
const shopifyFulfillmentService = require('../services/shopifyFulfillmentService');
const shopifyWebhookRegistrationService = require('../services/shopifyWebhookRegistrationService');
const ShopifyOrder = require('../models/ShopifyOrder');
const ShopifyStore = require('../models/ShopifyStore');
const User = require('../models/User');
const cacheService = require('../utils/cacheService');
const config = require('../config/shopifyConfig');

function isValidShopDomain(shop) {
    if (!shop || typeof shop !== 'string') return false;
    return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// GET /api/shopify/install?shop=yourstore.myshopify.com
exports.installApp = async (req, res) => {
    try {
        const { shop, origin } = req.query;
        if (!isValidShopDomain(shop)) {
            return res.status(400).json({ success: false, message: 'Invalid shop domain' });
        }
        const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || process.env.FRONTEND_URL || 'http://localhost:5173';
        const resolvedOrigin = origin === 'admin' ? 'admin' : 'user';

        const statePayload = {
            userId: null,
            role: resolvedOrigin,
            origin: resolvedOrigin,
            frontendUrl: requestOrigin,
            nonce: crypto.randomBytes(8).toString('hex'),
            createdAt: Date.now()
        };

        const state = jwt.sign(statePayload, config.apiSecret, { expiresIn: '20m' });
        cacheService.set(`shopify_oauth_${state}`, statePayload, 1200);

        res.cookie('shopify_oauth_state', state, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 20 * 60 * 1000
        });
        const authUrl = shopifyAuthService.generateAuthUrl(shop, state);
        return res.redirect(authUrl);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to initiate app installation' });
    }
};

// GET /api/shopify/auth-url?shop=yourstore.myshopify.com
exports.getAuthUrl = async (req, res) => {
    try {
        const { shop, origin } = req.query;
        if (!isValidShopDomain(shop)) {
            return res.status(400).json({ success: false, message: 'Invalid shop domain' });
        }

        const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || process.env.FRONTEND_URL || 'http://localhost:5173';
        const userId = req.user?._id ? req.user._id.toString() : null;
        const resolvedOrigin = (origin === 'admin' || origin === 'user')
            ? origin
            : (req.user?.isAdmin ? 'admin' : 'user');
        const role = resolvedOrigin === 'admin' ? 'admin' : 'user';

        const statePayload = {
            userId,
            role,
            origin: resolvedOrigin,
            frontendUrl: requestOrigin,
            nonce: crypto.randomBytes(8).toString('hex'),
            createdAt: Date.now()
        };

        // Create signed, tamper-proof state token (valid for 20 minutes)
        const state = jwt.sign(statePayload, config.apiSecret, { expiresIn: '20m' });

        // Fallback cache
        cacheService.set(`shopify_oauth_${state}`, statePayload, 1200);

        res.cookie('shopify_oauth_state', state, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 20 * 60 * 1000
        });

        const authUrl = shopifyAuthService.generateAuthUrl(shop, state);
        return res.json({ success: true, url: authUrl });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to generate authorization URL' });
    }
};

// GET /api/shopify/callback  (Shopify redirects here after merchant grants access)
exports.oauthCallback = async (req, res) => {
    let targetOrigin = 'user';
    let frontendBase = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://dflexp.in' : 'http://localhost:5173');
    try {
        const { shop, code, state } = req.query;
        if (!isValidShopDomain(shop) || !code) {
            console.error('[Shopify OAuth] Invalid shop domain or missing authorization code:', { shop, hasCode: Boolean(code) });
            return res.redirect(`${frontendBase}/marketplace?tab=shopify&status=error&message=${encodeURIComponent('Invalid store domain or missing authorization code from Shopify.')}`);
        }

        let authData = null;
        if (state) {
            const secrets = shopifyAuthService.getSecrets();
            for (const s of secrets) {
                try {
                    authData = jwt.verify(state, s);
                    if (authData) break;
                } catch (_) { }
            }
            if (!authData) {
                authData = cacheService.get(`shopify_oauth_${state}`);
            }
        }

        if (authData?.origin) {
            targetOrigin = authData.origin;
        } else if (authData?.role === 'admin') {
            targetOrigin = 'admin';
        }
        if (authData?.frontendUrl) {
            frontendBase = authData.frontendUrl;
        }

        const redirectPath = targetOrigin === 'admin' ? '/admin/marketplace' : '/marketplace';

        const isValidHmac = shopifyAuthService.verifyHmac(req.query);
        const isStateVerified = Boolean(authData);

        if (!isValidHmac && !isStateVerified) {
            return res.redirect(`${frontendBase}${redirectPath}?tab=shopify&status=error&message=${encodeURIComponent('Security verification failed. Please verify API credentials.')}`);
        }

        res.clearCookie('shopify_oauth_state');
        if (state) {
            cacheService.del(`shopify_oauth_${state}`);
        }

        let tokenData;
        try {
            tokenData = await shopifyAuthService.exchangeCodeForToken(shop, code);
        } catch (tokenErr) {
            console.error('[Shopify OAuth] Token exchange failed:', tokenErr.message);
            return res.redirect(`${frontendBase}${redirectPath}?tab=shopify&status=error&message=${encodeURIComponent(tokenErr.message || 'Failed to exchange authorization code for access token.')}`);
        }

        // Assign store specifically based on origin (Admin vs User)
        const targetUserId = authData?.userId;
        const origin = targetOrigin;

        let effectiveUserId = targetUserId;
        if (!effectiveUserId && origin !== 'admin') {
            const { user } = await shopifyAuthService.createOrLinkMerchantUser(shop);
            effectiveUserId = user._id;
        }

        const store = await shopifyAuthService.saveStore(shop, tokenData, {
            origin,
            targetUserId: effectiveUserId,
        });

        // Register webhooks in background (non-blocking, safe catch)
        shopifyWebhookRegistrationService.registerWebhooks(shop, tokenData.access_token).catch((whErr) => {
            console.error('[Shopify OAuth] Webhook registration background notice:', whErr.message);
        });

        // Sync orders and forcefully fulfill all booked orders immediately in background
        (async () => {
            try {
                await shopifyOrderService.syncOrders(shop);
                await shopifyFulfillmentService.forceFulfillAllBookedOrders(shop);
            } catch (syncErr) {
                console.error('[Shopify OAuth] Initial order sync notice:', syncErr.message);
            }
        })().catch(() => {});

        const redirectUrl = `${frontendBase}${redirectPath}?tab=shopify&status=connected&shop=${encodeURIComponent(shop)}`;
        return res.redirect(redirectUrl);
    } catch (error) {
        console.error('[Shopify OAuth] Unexpected callback error:', error);
        const redirectPath = targetOrigin === 'admin' ? '/admin/marketplace' : '/marketplace';
        return res.redirect(`${frontendBase}${redirectPath}?tab=shopify&status=error&message=${encodeURIComponent(error.message || 'An unexpected error occurred while connecting Shopify.')}`);
    }
};

// GET /api/shopify/store-status?shop=yourstore.myshopify.com&origin=user|admin
exports.getStoreStatus = async (req, res) => {
    try {
        const { shop, origin } = req.query;
        let query = {};

        if (origin === 'user') {
            query = { userId: req.user?._id, isActive: true };
            if (shop) query.shopDomain = shop;
        } else if (origin === 'admin') {
            query = { connectedBy: 'admin', isActive: true };
            if (shop) query.shopDomain = shop;
        } else if (shop) {
            if (!isValidShopDomain(shop)) {
                return res.status(400).json({ success: false, message: 'Missing or invalid shop parameter' });
            }
            if (req.user?.isAdmin) {
                query = { shopDomain: shop, isActive: true };
            } else {
                query = { shopDomain: shop, userId: req.user?._id, isActive: true };
            }
        } else if (req.user?._id) {
            query = { userId: req.user._id, isActive: true };
        } else {
            return res.status(200).json({ success: true, connected: false, data: null });
        }

        const store = await ShopifyStore.findOne(query).sort({ updatedAt: -1 });
        if (!store) {
            return res.status(200).json({ success: true, connected: false, data: null });
        }

        return res.status(200).json({
            success: true,
            connected: true,
            data: {
                _id: store._id,
                shopDomain: store.shopDomain,
                isActive: store.isActive,
                connectedBy: store.connectedBy || 'user',
                shipperDetailsCompleted: store.shipperDetailsCompleted || false,
                shipperDetails: store.shipperDetails || {},
                lastSyncAt: store.lastSyncAt,
                settings: store.settings,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to get store status' });
    }
};

// GET /api/shopify/stores  (all connected stores — admin use)
exports.getAllStores = async (req, res) => {
    try {
        if (!req.user?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Access denied: Admin access required' });
        }

        const stores = await ShopifyStore.find({ isActive: true })
            .select('-accessToken')
            .populate('userId', 'name email customerId role')
            .populate('adminId', 'name email')
            .sort({ createdAt: -1 });

        return res.status(200).json({ success: true, data: stores });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to fetch stores' });
    }
};

// POST /api/shopify/shipper-details
exports.saveShipperDetails = async (req, res) => {
    try {
        const { shop, shipperDetails } = req.body;
        if (!isValidShopDomain(shop)) {
            return res.status(400).json({ success: false, message: 'Missing or invalid shop parameter' });
        }
        if (!shipperDetails?.shipperName || !shipperDetails?.mobileNo || !shipperDetails?.addressLine1) {
            return res.status(400).json({ success: false, message: 'Missing required shipper details' });
        }

        const store = await ShopifyStore.findOneAndUpdate(
            { shopDomain: shop },
            { shipperDetails, shipperDetailsCompleted: true },
            { new: true }
        ).select('-accessToken');

        if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

        if (store.userId) {
            await User.findByIdAndUpdate(store.userId, {
                name: shipperDetails.shipperName,
                phone: shipperDetails.mobileNo,
                ...(shipperDetails.email ? { email: shipperDetails.email } : {}),
            });
        }

        return res.status(200).json({ success: true, message: 'Shipper details saved', data: store.shipperDetails });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to save shipper details' });
    }
};

// POST /api/shopify/sync-orders
exports.syncOrders = async (req, res) => {
    try {
        const shopDomain = req.body.shopDomain || req.body.shop;
        if (!isValidShopDomain(shopDomain)) {
            return res.status(400).json({ success: false, message: 'Missing or invalid shopDomain parameter' });
        }

        // Access check: non-admin can only sync their own store
        if (!req.user?.isAdmin) {
            const userStore = await ShopifyStore.findOne({ shopDomain, userId: req.user._id, isActive: true });
            if (!userStore) {
                return res.status(403).json({ success: false, message: 'Access denied: You can only sync your own store' });
            }
        }

        const result = await shopifyOrderService.syncOrders(shopDomain);

        // Forcefully push fulfillment to Shopify for all booked orders (incoming and past)
        try {
            await shopifyFulfillmentService.forceFulfillAllBookedOrders(shopDomain);
        } catch (fulSyncErr) {
            console.warn('[Shopify Force Fulfill Note]:', fulSyncErr.message);
        }

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to sync orders' });
    }
};

// GET /api/shopify/orders?shop=yourstore.myshopify.com
exports.getOrdersList = async (req, res) => {
    try {
        const { shop } = req.query;
        if (!isValidShopDomain(shop)) {
            return res.status(400).json({ success: false, message: 'Missing or invalid shop parameter' });
        }

        // Access check: non-admin can only view their own store orders
        if (!req.user?.isAdmin) {
            const userStore = await ShopifyStore.findOne({ shopDomain: shop, userId: req.user._id, isActive: true });
            if (!userStore) {
                return res.status(403).json({ success: false, message: 'Access denied: You can only view orders for your own store' });
            }
        }

        const orders = await ShopifyOrder.find({ shopDomain: shop })
            .select('-rawData')
            .sort({ shopifyCreatedAt: -1 });

        return res.status(200).json({ success: true, data: orders });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to fetch orders list' });
    }
};

// GET /api/shopify/orders/:orderId/prefill-shipment
exports.getShipmentPrefillData = async (req, res) => {
    try {
        const { orderId } = req.params;
        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Missing orderId parameter' });
        }

        const order = await ShopifyOrder.findById(orderId).select('-rawData');
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        // Access check: non-admin can only prefill from their own store orders
        if (!req.user?.isAdmin) {
            const userStore = await ShopifyStore.findOne({ shopDomain: order.shopDomain, userId: req.user._id, isActive: true });
            if (!userStore) {
                return res.status(403).json({ success: false, message: 'Access denied: You can only access your own store orders' });
            }
        }

        const store = await ShopifyStore.findOne({ shopDomain: order.shopDomain }).select('-accessToken');

        const prefillData = {
            shipperDetails: store?.shipperDetails || {},
            consigneeDetails: {
                consigneeName: order.shippingAddress?.name || order.customerName || '',
                mobileNo: order.customerPhone || '',
                email: order.customerEmail || '',
                addressLine1: order.shippingAddress?.address1 || '',
                addressLine2: order.shippingAddress?.address2 || '',
                city: order.shippingAddress?.city || '',
                state: order.shippingAddress?.state || '',
                country: order.shippingAddress?.country || '',
                pincode: order.shippingAddress?.zip || '',
            },
            shipmentDetails: {
                invoiceNumber: order.orderNumber,
                invoiceDate: order.shopifyCreatedAt,
                currency: order.currency,
                referenceNumber: order.shopifyOrderId,
                totalItemValue: order.totalPrice,
            },
            boxes: [{
                weight: (order.products || []).reduce((sum, p) => sum + (p.weight || 0), 0) / 1000,
                items: (order.products || []).map(p => ({
                    productName: p.title,
                    quantity: p.quantity,
                    unitPrice: p.price,
                })),
            }],
            paymentMode: order.paymentType === 'COD' ? 'COD' : 'Prepaid',
            shopifyOrderId: order._id,
            shopifyOrderNumber: order.orderNumber,
            fulfillmentStatus: order.fulfillmentStatus || 'unfulfilled',
        };

        return res.status(200).json({ success: true, data: prefillData });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to get shipment prefill data' });
    }
};

// POST /api/shopify/update-fulfillment
exports.updateFulfillment = async (req, res) => {
    try {
        const shopDomain = req.body.shopDomain || req.body.shop;
        const { shopifyOrderId, trackingNumber, carrier } = req.body;
        if (!isValidShopDomain(shopDomain) || !shopifyOrderId || !trackingNumber) {
            return res.status(400).json({ success: false, message: 'Missing required parameters for fulfillment update' });
        }
        const result = await shopifyFulfillmentService.updateFulfillment(shopDomain, shopifyOrderId, trackingNumber, carrier);
        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to update fulfillment' });
    }
};

// PUT /api/shopify/settings
exports.saveSettings = async (req, res) => {
    try {
        const { shop, settings } = req.body;
        if (!isValidShopDomain(shop)) {
            return res.status(400).json({ success: false, message: 'Missing or invalid shop parameter' });
        }

        const store = await ShopifyStore.findOneAndUpdate(
            { shopDomain: shop },
            { settings },
            { new: true }
        ).select('-accessToken');

        if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

        return res.status(200).json({ success: true, message: 'Settings saved', data: store.settings });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to save settings' });
    }
};

// DELETE /api/shopify/disconnect or DELETE /api/shopify/disconnect/:storeId
exports.disconnectStore = async (req, res) => {
    try {
        const storeId = req.params?.storeId;
        const shop = req.body?.shop || req.query?.shop;
        const origin = req.body?.origin || req.query?.origin;

        let query = null;
        if (storeId) {
            query = { _id: storeId };
        } else if (origin === 'user' && req.user?._id) {
            query = { userId: req.user._id, isActive: true };
            if (shop) query.shopDomain = shop;
        } else if (origin === 'admin') {
            query = { connectedBy: 'admin', isActive: true };
            if (shop) query.shopDomain = shop;
        } else if (shop) {
            if (!isValidShopDomain(shop)) {
                return res.status(400).json({ success: false, message: 'Missing or invalid shop parameter' });
            }
            if (req.user?.isAdmin) {
                query = { shopDomain: shop };
            } else {
                query = { shopDomain: shop, userId: req.user._id };
            }
        } else if (req.user?._id) {
            query = { userId: req.user._id, isActive: true };
        } else if (req.user?.isAdmin) {
            query = { connectedBy: 'admin', isActive: true };
        }

        if (!query) {
            return res.status(400).json({ success: false, message: 'Missing store identifier' });
        }

        await ShopifyStore.findOneAndUpdate(query, { isActive: false, accessToken: null });
        return res.status(200).json({ success: true, message: 'Store disconnected successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Failed to disconnect store' });
    }
};

// POST /api/shopify/connect-custom-app
exports.connectCustomApp = async (req, res) => {
    try {
        const { shopDomain, accessToken, origin } = req.body;
        if (!shopDomain || !accessToken) {
            return res.status(400).json({ success: false, message: 'Shop domain and access token are required' });
        }

        let cleanDomain = shopDomain.trim().toLowerCase();
        if (!cleanDomain.endsWith('.myshopify.com')) {
            cleanDomain = `${cleanDomain}.myshopify.com`;
        }

        const cleanToken = accessToken.trim();

        // 1. Verify token against Shopify
        let shopData = null;
        try {
            const shopRes = await axios.get(`https://${cleanDomain}/admin/api/${config.apiVersion}/shop.json`, {
                headers: { 'X-Shopify-Access-Token': cleanToken },
                timeout: 10000
            });
            shopData = shopRes.data?.shop;
        } catch (apiErr) {
            const msg = apiErr.response?.data?.errors || apiErr.response?.data?.error || apiErr.message;
            return res.status(400).json({
                success: false,
                message: `Failed to verify Shopify token: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`
            });
        }

        // 2. Check scopes
        let grantedScopes = [];
        try {
            const scopeRes = await axios.get(`https://${cleanDomain}/admin/oauth/access_scopes.json`, {
                headers: { 'X-Shopify-Access-Token': cleanToken },
                timeout: 10000
            });
            grantedScopes = (scopeRes.data?.access_scopes || []).map(s => s.handle);
        } catch (_) {}

        const scopeString = grantedScopes.join(',') || 'write_orders,write_fulfillments,read_orders,read_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders';

        // 3. Save Store
        const targetUserId = req.user?.isAdmin ? null : req.user?._id;
        const targetOrigin = origin || (req.user?.isAdmin ? 'admin' : 'user');

        await shopifyAuthService.saveStore(
            cleanDomain,
            {
                access_token: cleanToken,
                scope: scopeString,
                refresh_token: null,
                expires_in: null
            },
            {
                origin: targetOrigin,
                targetUserId: targetUserId || req.user?._id
            }
        );

        // 4. Force fulfill all booked orders for this store immediately in the background
        shopifyFulfillmentService.forceFulfillAllBookedOrders(cleanDomain).catch(err => {
            console.error('[connectCustomApp] Error auto-fulfilling booked orders:', err.message);
        });

        return res.status(200).json({
            success: true,
            message: `Connected successfully to ${shopData?.name || cleanDomain}! Booked orders are being fulfilled.`,
            data: {
                shopDomain: cleanDomain,
                shopName: shopData?.name,
                scope: scopeString
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message || 'Internal server error while connecting custom app' });
    }
};

// POST /api/shopify/force-fulfill
exports.forceFulfillBooked = async (req, res) => {
    try {
        const { shopDomain } = req.body;
        const result = await shopifyFulfillmentService.forceFulfillAllBookedOrders(shopDomain || null);
        return res.json({ success: true, result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

