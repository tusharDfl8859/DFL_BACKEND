const mongoose = require('mongoose');
const MarketplaceAccount = require('../models/MarketplaceAccount');
const MarketplaceLog = require('../models/MarketplaceLog');
const EtsyOrder = require('../models/EtsyOrder');
const EbayOrder = require('../models/EbayOrder');
const ShopifyStore = require('../models/ShopifyStore');
const ShopifyOrder = require('../models/ShopifyOrder');
const User = require('../models/User');
const Admin = require('../models/Admin');
const { encryptToken } = require('../utils/encryption');
const cacheService = require('../utils/cacheService');
const crypto = require('crypto');
const axios = require('axios');
const etsySyncService = require('../services/etsy/etsySyncService');
const shopifyOrderService = require('../services/shopifyOrderService');

/**
 * Helper to generate PKCE verifier and challenge pairs
 */
const generatePKCE = () => {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
};

/**
 * Generates the authorization URL for Etsy connection
 */
exports.getEtsyAuthUrl = async (req, res) => {
    try {
        const userId = req.user._id;
        const { codeVerifier, codeChallenge } = generatePKCE();
        const state = crypto.randomBytes(16).toString('hex');

        // Store PKCE verifier, userId, role, and dynamic frontend origin in cache
        const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || process.env.FRONTEND_URL || 'http://localhost:5173';
        cacheService.set(`etsy_oauth_${state}`, {
            codeVerifier,
            userId: userId.toString(),
            role: req.user.role,
            frontendUrl: requestOrigin
        }, 600);

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.ETSY_CLIENT_ID,
            redirect_uri: process.env.ETSY_REDIRECT_URI,
            scope: 'email_r listings_r transactions_r transactions_w profile_r shops_r',
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });

        const authUrl = `https://www.etsy.com/oauth/connect?${params.toString()}`;

        return res.status(200).json({ success: true, url: authUrl });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Handles the Etsy OAuth callback redirection
 */
exports.etsyCallback = async (req, res) => {
    let authData;
    let frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    try {
        const { code, state, error } = req.query;

        if (error) {
            return res.redirect(`${frontendUrl}/marketplace?error=auth_denied`);
        }

        // Retrieve PKCE verifier and original frontend URL from cache
        authData = cacheService.get(`etsy_oauth_${state}`);
        if (!authData) {
            return res.redirect(`${frontendUrl}/marketplace?error=invalid_state`);
        }

        // Use the exact frontend URL the user originated from to prevent session/cookie loss
        if (authData.frontendUrl) {
            frontendUrl = authData.frontendUrl;
        }

        const isUserAdmin = authData.role === 'admin' || authData.role === 'super_admin';
        const redirectBase = isUserAdmin ? `${frontendUrl}/admin/marketplace` : `${frontendUrl}/marketplace`;

        // If duplicate callback occurs, redirect to success directly if already processed or processing
        if (authData.status === 'completed' || authData.status === 'processing') {
            if (authData.status === 'processing') {
                // Wait for the first request to complete (up to 5 seconds)
                for (let i = 0; i < 25; i++) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                    const currentAuth = cacheService.get(`etsy_oauth_${state}`);
                    if (currentAuth && currentAuth.status === 'completed') {
                        break;
                    }
                }
            }
            return res.redirect(`${redirectBase}?success=etsy_connected`);
        }

        // Mark state as processing to handle concurrent requests gracefully
        cacheService.set(`etsy_oauth_${state}`, { ...authData, status: 'processing' }, 60);

        const { codeVerifier, userId } = authData;

        const tokenParams = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: process.env.ETSY_CLIENT_ID,
            redirect_uri: process.env.ETSY_REDIRECT_URI,
            code: code,
            code_verifier: codeVerifier
        });

        const tokenResponse = await axios.post('https://api.etsy.com/v3/public/oauth/token', tokenParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        // Retrieve Etsy shop and user details
        const userResponse = await axios.get('https://api.etsy.com/v3/application/users/me', {
            headers: {
                'x-api-key': `${process.env.ETSY_CLIENT_ID}:${process.env.ETSY_CLIENT_SECRET}`,
                'Authorization': `Bearer ${access_token}`
            }
        });
        const etsyUserId = userResponse.data.user_id;

        const shopResponse = await axios.get(`https://api.etsy.com/v3/application/users/${etsyUserId}/shops`, {
            headers: {
                'x-api-key': `${process.env.ETSY_CLIENT_ID}:${process.env.ETSY_CLIENT_SECRET}`,
                'Authorization': `Bearer ${access_token}`
            }
        });

        const shop = shopResponse.data;

        const encryptedAccess = encryptToken(access_token);
        const encryptedRefresh = encryptToken(refresh_token);
        const expiryDate = new Date(Date.now() + expires_in * 1000);

        await MarketplaceAccount.findOneAndUpdate(
            { userId: userId, shopId: shop.shop_id.toString(), platform: 'Etsy' },
            {
                shopName: shop.shop_name,
                accessToken: encryptedAccess,
                refreshToken: encryptedRefresh,
                tokenExpiry: expiryDate,
                status: 'Connected',
                isActive: true
            },
            { upsert: true, new: true }
        );

        await MarketplaceLog.create({
            userId,
            platform: 'Etsy',
            action: 'OAuthConnect',
            status: 'Success',
            message: `Successfully connected Etsy shop: ${shop.shop_name}`
        });

        // Mark state as completed for subsequent page reloads within 10 seconds
        cacheService.set(`etsy_oauth_${state}`, { ...authData, status: 'completed' }, 10);

        return res.redirect(`${redirectBase}?success=etsy_connected`);
    } catch (error) {
        if (authData?.userId) {
            await MarketplaceLog.create({
                userId: authData.userId,
                platform: 'Etsy',
                action: 'OAuthConnect',
                status: 'Error',
                message: 'Failed to connect Etsy shop',
                details: error.response?.data || error.message
            }).catch((logErr) => {
                const logFailed = logErr.message;
            });
        }

        const redirectBase = authData ? (authData.role === 'admin' || authData.role === 'super_admin' ? `${frontendUrl}/admin/marketplace` : `${frontendUrl}/marketplace`) : null;
        return res.redirect(`${redirectBase || (frontendUrl + '/marketplace')}?error=connection_failed`);
    }
};

/**
 * Returns all connected marketplace accounts for a user
 */
exports.getConnectedAccounts = async (req, res) => {
    try {
        let query = {};
        const selfOnly = req.query.selfOnly === 'true';

        if (selfOnly || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
            query.userId = req.user._id;
        }

        const accounts = await MarketplaceAccount.find(query)
            .populate('userId', 'name email dflId')
            .select('-accessToken -refreshToken');

        return res.status(200).json({ success: true, data: accounts });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Triggers Etsy order sync for a specific account
 */
exports.syncEtsyOrders = async (req, res) => {
    try {
        const { accountId, userId } = req.body;
        const targetId = accountId || userId;

        if (!targetId && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.status(400).json({ success: false, message: 'Account ID or User ID is required' });
        }

        const effectiveId = targetId || req.user._id;
        const isValidObjectId = mongoose.Types.ObjectId.isValid(effectiveId);

        let query = {};
        if (req.user.role === 'admin' || req.user.role === 'super_admin') {
            query = {
                $or: [
                    ...(isValidObjectId ? [{ _id: effectiveId }] : []),
                    { userId: effectiveId }
                ]
            };
        } else {
            query = {
                $or: [
                    ...(isValidObjectId ? [{ _id: effectiveId, userId: req.user._id }] : []),
                    { userId: req.user._id }
                ]
            };
        }

        const account = await MarketplaceAccount.findOne(query);
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        const result = await etsySyncService.syncOrdersForShop(account._id);
        if (result.success) {
            return res.status(200).json(result);
        } else {
            return res.status(400).json(result);
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Returns all synced Etsy orders for a user
 */
exports.getEtsyOrders = async (req, res) => {
    try {
        let query = {};
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            query.userId = req.user._id;
        }

        const orders = await EtsyOrder.find(query)
            .populate('marketplaceAccountId', 'shopName')
            .populate('userId', 'name email dflId')
            .sort({ orderDate: -1 });

        return res.status(200).json({ success: true, data: orders });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Helper to build comprehensive prefilled shipperDetails from User profile & KYC
 */
const buildShipperDetailsFromUser = (user, storeShipper = {}) => {
    const kyc = user?.kycData || {};
    const billing = kyc.billingAddress || {};

    let shipperIdType = '';
    let shipperIdNo = '';
    if (kyc.gstNumber) {
        shipperIdType = 'GST NO';
        shipperIdNo = kyc.gstNumber;
    } else if (kyc.panNumber) {
        shipperIdType = 'PAN NO';
        shipperIdNo = kyc.panNumber;
    } else if (kyc.iecNumber) {
        shipperIdType = 'IEC NO';
        shipperIdNo = kyc.iecNumber;
    } else if (kyc.documentType && kyc.documentNumber) {
        const dt = kyc.documentType.toUpperCase();
        if (dt.includes('AADHAAR') || dt.includes('AADHAR')) shipperIdType = 'AADHAR NO';
        else if (dt.includes('PAN')) shipperIdType = 'PAN NO';
        else if (dt.includes('PASSPORT')) shipperIdType = 'PASSPORT NO';
        else if (dt.includes('INCORPORATION') || dt.includes('COI')) shipperIdType = 'CIN NO';
        else shipperIdType = dt;
        shipperIdNo = kyc.documentNumber;
    } else if (kyc.companyAadhaarNumber) {
        shipperIdType = 'AADHAR NO';
        shipperIdNo = kyc.companyAadhaarNumber;
    }

    const isBiz = user?.accountType === 'business' || Boolean(kyc.gstNumber || kyc.companyPanNumber);
    const companyPanName = isBiz ? (kyc.companyPanName || kyc.panName || billing.companyName || user?.companyName || storeShipper.companyName || '') : '';

    return {
        shipperName: user?.name || storeShipper.shipperName || '',
        companyName: companyPanName,
        email: user?.email || storeShipper.email || '',
        mobileNo: user?.phone || user?.contactNumber || billing.mobileNo || storeShipper.mobileNo || '',
        location: '',
        addressLine1: billing.addressLine1 || storeShipper.addressLine1 || '',
        addressLine2: billing.addressLine2 || storeShipper.addressLine2 || '',
        city: billing.city || storeShipper.city || '',
        state: billing.state || storeShipper.state || '',
        country: billing.country || storeShipper.country || 'India',
        countryCode: billing.countryCode || 'IN',
        pincode: billing.pincode || storeShipper.pincode || '',
        alternateName: '',
        alternateMobile: '',
        shipperType: user?.accountType === 'business' ? 'Company' : 'Individual',
        shipperIdType,
        shipperIdNo,
        date: new Date().toISOString().split('T')[0],
        pickupType: 'pickup'
    };
};

/**
 * Maps an Etsy order into a standard DFL shipment draft structure
 */
exports.getEtsyOrderAsDraft = async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (req.user.role === 'User') {
            query.userId = req.user._id;
        }

        const order = await EtsyOrder.findOne(query).populate('userId');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const targetUserId = req.query.userId || order.userId?._id || order.userId;
        let user = null;
        if (targetUserId) {
            user = await User.findById(targetUserId).select('name email phone contactNumber companyName accountType role kycData');
            if (!user) user = await Admin.findById(targetUserId).select('name email phone role');
        }
        if (!user && req.user) user = req.user;

        const draftData = {
            user: user,
            shipperDetails: buildShipperDetailsFromUser(user),
            consigneeDetails: {
                consigneeName: order.buyerName || '',
                companyName: '',
                email: order.buyerEmail || '',
                contactNo: '',
                mobileNo: '',
                addressLine1: order.shippingAddress?.firstLine || '',
                addressLine2: order.shippingAddress?.secondLine || '',
                city: order.shippingAddress?.city || '',
                state: order.shippingAddress?.state || '',
                country: order.shippingAddress?.countryIso === 'GB' ? 'United Kingdom' :
                    order.shippingAddress?.countryIso === 'US' ? 'United States' :
                        order.shippingAddress?.countryIso || '',
                countryCode: order.shippingAddress?.countryIso || '',
                pincode: order.shippingAddress?.zip || ''
            },
            shipmentDetails: {
                shipmentType: 'parcel',
                purposeOfShipment: 'Commercial',
                itemDescription: order.items?.map(i => `${i.title} (Qty: ${i.quantity})`).join(', ') || 'Etsy Goods',
                declaredValue: order.totalValue || 0,
                currency: order.currency || 'USD',
                invoiceNumber: order.etsyOrderId || '',
                invoiceDate: order.orderDate ? new Date(order.orderDate).toISOString().split('T')[0] : '',
                boxes: [{
                    length: '', width: '', height: '', weight: '',
                    items: order.items?.length > 0 ? order.items.map(item => ({
                        productName: item.title,
                        hsnCode: '',
                        quantity: item.quantity,
                        unitPrice: item.price,
                        igst: ''
                    })) : [{
                        productName: '',
                        hsnCode: '',
                        quantity: '',
                        unitPrice: '',
                        igst: ''
                    }]
                }],
                chargeableWeight: 0
            }
        };

        return res.status(200).json(draftData);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Maps an eBay order into a standard DFL shipment draft structure
 */
exports.getEbayOrderAsDraft = async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (req.user.role === 'User') {
            query.userId = req.user._id;
        }

        const order = await EbayOrder.findOne(query);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const targetUserId = req.query.userId || order.userId;
        let user = null;
        if (targetUserId) {
            user = await User.findById(targetUserId).select('name email phone contactNumber companyName accountType role kycData');
            if (!user) user = await Admin.findById(targetUserId).select('name email phone role');
        }
        if (!user && req.user) user = req.user;

        const draftData = {
            user: user,
            shipperDetails: buildShipperDetailsFromUser(user),
            consigneeDetails: {
                consigneeName: order.shippingAddress?.fullName || order.buyer?.username || '',
                companyName: '',
                email: order.buyer?.email || '',
                contactNo: order.shippingAddress?.phone || '',
                mobileNo: order.shippingAddress?.phone || '',
                addressLine1: order.shippingAddress?.addressLine1 || '',
                addressLine2: order.shippingAddress?.addressLine2 || '',
                city: order.shippingAddress?.city || '',
                state: order.shippingAddress?.state || '',
                country: order.shippingAddress?.country === 'GB' ? 'United Kingdom' :
                    order.shippingAddress?.country === 'US' ? 'United States' :
                        order.shippingAddress?.country || '',
                countryCode: order.shippingAddress?.country || '',
                pincode: order.shippingAddress?.postalCode || ''
            },
            shipmentDetails: {
                shipmentType: 'parcel',
                purposeOfShipment: 'Commercial',
                itemDescription: order.lineItems?.map(i => `${i.title} (Qty: ${i.quantity})`).join(', ') || 'eBay Goods',
                declaredValue: order.orderTotal || 0,
                currency: order.currency || 'USD',
                invoiceNumber: order.ebayOrderId || '',
                invoiceDate: order.createdAt ? new Date(order.createdAt).toISOString().split('T')[0] : '',
                boxes: [{
                    length: '', width: '', height: '', weight: '',
                    items: order.lineItems?.length > 0 ? order.lineItems.map(item => ({
                        productName: item.title,
                        hsnCode: '',
                        quantity: item.quantity,
                        unitPrice: item.price,
                        igst: ''
                    })) : [{
                        productName: '',
                        hsnCode: '',
                        quantity: '',
                        unitPrice: '',
                        igst: ''
                    }]
                }],
                chargeableWeight: 0
            }
        };

        return res.status(200).json(draftData);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Maps a Shopify order into a standard DFL shipment draft structure
 */
exports.getShopifyOrderAsDraft = async (req, res) => {
    try {
        const order = await ShopifyOrder.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Shopify order not found' });
        }

        // Find the associated store to get user details
        const store = await ShopifyStore.findOne({ shopDomain: order.shopDomain });
        const targetUserId = req.query.userId || store?.userId || store?.adminId;

        let user = null;
        if (targetUserId) {
            user = await User.findById(targetUserId).select('name email phone contactNumber companyName accountType role kycData');
            if (!user) {
                const adminDoc = await Admin.findById(targetUserId).select('name email phone role');
                if (adminDoc?.email) {
                    user = await User.findOne({ email: adminDoc.email }).select('name email phone contactNumber companyName accountType role kycData');
                }
                if (!user) {
                    user = adminDoc;
                }
            }
        }
        if (!user && req.user) {
            if (req.user.isAdmin && req.user.email) {
                user = await User.findOne({ email: req.user.email }).select('name email phone contactNumber companyName accountType role kycData');
            }
            if (!user) {
                user = req.user;
            }
        }

        const addr = order.shippingAddress || {};
        const consigneeName = addr.name || order.customerName || '';
        const phone = addr.phone || order.customerPhone || '';
        const email = order.customerEmail || '';

        const draftData = {
            user: user,
            shipperDetails: buildShipperDetailsFromUser(user, store?.shipperDetails),
            consigneeDetails: {
                consigneeName: consigneeName,
                companyName: '',
                email: email,
                contactNo: phone,
                mobileNo: phone,
                addressLine1: addr.address1 || '',
                addressLine2: addr.address2 || '',
                city: addr.city || '',
                state: addr.state || '',
                country: addr.country === 'GB' || addr.country === 'United Kingdom' ? 'United Kingdom' :
                    addr.country === 'US' || addr.country === 'United States' ? 'United States' :
                        addr.country || '',
                countryCode: addr.country || '',
                pincode: addr.zip || ''
            },
            shipmentDetails: {
                shipmentType: 'parcel',
                purposeOfShipment: 'Commercial',
                itemDescription: order.products?.map(i => `${i.title || 'Product'} (Qty: ${i.quantity || 1})`).join(', ') || 'Shopify Goods',
                declaredValue: order.totalPrice || 0,
                currency: order.currency || 'INR',
                invoiceNumber: order.orderNumber ? `#${order.orderNumber}` : order.shopifyOrderId || '',
                invoiceDate: order.shopifyCreatedAt ? new Date(order.shopifyCreatedAt).toISOString().split('T')[0] : (order.createdAt ? new Date(order.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
                boxes: [{
                    length: '', width: '', height: '',
                    weight: order.products?.reduce((acc, p) => acc + ((p.weight || 0.5) * (p.quantity || 1)), 0) || '',
                    items: order.products?.length > 0 ? order.products.map(item => ({
                        productName: item.title || 'Product Item',
                        hsnCode: '',
                        quantity: item.quantity || 1,
                        unitPrice: item.price || 0,
                        igst: ''
                    })) : [{
                        productName: '',
                        hsnCode: '',
                        quantity: '',
                        unitPrice: '',
                        igst: ''
                    }]
                }],
                chargeableWeight: 0
            }
        };

        return res.status(200).json(draftData);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Returns dynamic stats of active marketplace connections
 */
exports.adminGetMarketplaceStats = async (req, res) => {
    try {
        const ebayCount = await MarketplaceAccount.countDocuments({ platform: { $regex: /^ebay$/i }, isActive: true });
        const etsyCount = await MarketplaceAccount.countDocuments({ platform: { $regex: /^etsy$/i }, isActive: true });
        const shopifyCount = await ShopifyStore.countDocuments({ isActive: true });
        const amazonCount = await MarketplaceAccount.countDocuments({ platform: { $regex: /^amazon$/i }, isActive: true });
        const wooCount = await MarketplaceAccount.countDocuments({ platform: { $regex: /^(woocommerce|woo)$/i }, isActive: true });

        return res.status(200).json({
            success: true,
            stats: {
                eBay: ebayCount,
                Etsy: etsyCount,
                Shopify: shopifyCount,
                Amazon: amazonCount,
                WooCommerce: wooCount
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Lists all connected stores with populated user details
 */
exports.adminGetConnectedStores = async (req, res) => {
    try {
        const { platform } = req.query;
        if (!platform) {
            return res.status(400).json({ success: false, message: 'Platform query parameter is required' });
        }

        if (platform.toLowerCase() === 'shopify') {
            const shopifyStores = await ShopifyStore.find({ isActive: true })
                .populate('userId', 'name email role customerId dflId')
                .populate('adminId', 'name email role')
                .sort({ createdAt: -1 });

            const formattedStores = shopifyStores.map(store => {
                const userObj = store.userId || (store.adminId ? {
                    _id: store.adminId._id,
                    name: store.adminId.name,
                    email: store.adminId.email,
                    role: 'Admin'
                } : {
                    name: 'Admin / Merchant',
                    email: 'N/A',
                    role: 'Merchant'
                });

                return {
                    _id: store._id,
                    shopName: store.shopDomain,
                    shopId: store.shopDomain,
                    shopDomain: store.shopDomain,
                    platform: 'Shopify',
                    userId: userObj,
                    createdAt: store.installedAt || store.createdAt,
                    isActive: store.isActive
                };
            });

            return res.status(200).json({ success: true, data: formattedStores });
        }

        const accounts = await MarketplaceAccount.find({
            platform: { $regex: new RegExp(`^${platform}$`, 'i') },
            isActive: true
        }).select('-accessToken -refreshToken');

        const populatedAccounts = await Promise.all(accounts.map(async (acc) => {
            const accObj = acc.toObject();
            let user = await User.findById(acc.userId).select('name email role');
            if (!user) {
                user = await Admin.findById(acc.userId).select('name email role');
                if (user) {
                    user = {
                        _id: user._id,
                        name: user.name,
                        email: user.email,
                        role: user.role || 'admin'
                    };
                }
            }
            accObj.userId = user || { name: 'Unknown User', email: 'N/A', role: 'Unknown' };
            return accObj;
        }));

        return res.status(200).json({ success: true, data: populatedAccounts });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Lists all orders synced for a specific connected store account
 */
exports.adminGetConnectedStoreOrders = async (req, res) => {
    try {
        const { userId, platform, shop } = req.query;
        if (!userId || !platform) {
            return res.status(400).json({ success: false, message: 'userId and platform query parameters are required' });
        }

        if (platform === 'eBay') {
            const orders = await EbayOrder.find({ userId })
                .populate('dflShipmentId', 'shipmentId trackingId status')
                .sort({ createdAt: -1 });
            return res.status(200).json({ success: true, data: orders });
        } else if (platform === 'Etsy') {
            const orders = await EtsyOrder.find({ userId })
                .populate('marketplaceAccountId', 'shopName')
                .populate('dflShipmentId', 'shipmentId trackingId status')
                .sort({ orderDate: -1 });
            return res.status(200).json({ success: true, data: orders });
        } else if (platform.toLowerCase() === 'shopify') {
            let storeQuery = shop ? { shopDomain: shop } : {
                $or: [
                    { userId: userId },
                    { _id: userId },
                    { adminId: userId }
                ]
            };
            const store = await ShopifyStore.findOne(storeQuery);
            if (!store) {
                const orders = await ShopifyOrder.find({ userId })
                    .populate('dflShipmentId', 'shipmentId trackingId status')
                    .sort({ shopifyCreatedAt: -1, createdAt: -1 });
                return res.status(200).json({ success: true, data: orders });
            }
            const orders = await ShopifyOrder.find({ shopDomain: store.shopDomain })
                .populate('dflShipmentId', 'shipmentId trackingId status')
                .sort({ shopifyCreatedAt: -1, createdAt: -1 });
            return res.status(200).json({ success: true, data: orders, shopDomain: store.shopDomain });
        } else {
            return res.status(200).json({ success: true, data: [] });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Triggers Shopify order sync on behalf of a connected store
 */
exports.adminSyncShopifyOrders = async (req, res) => {
    try {
        const { userId, shop } = req.body;
        let shopDomain = shop;
        if (!shopDomain && userId) {
            const isValidObjectId = mongoose.Types.ObjectId.isValid(userId);
            const store = await ShopifyStore.findOne({
                $or: [
                    { userId: userId },
                    ...(isValidObjectId ? [{ _id: userId }] : []),
                    { adminId: userId },
                    { shopDomain: userId }
                ],
                isActive: true
            });
            if (store) shopDomain = store.shopDomain;

            if (!shopDomain) {
                // Check if any ShopifyOrder has this userId or shopDomain
                const anyOrder = await ShopifyOrder.findOne({
                    $or: [
                        { userId: userId },
                        { shopDomain: userId }
                    ]
                });
                if (anyOrder?.shopDomain) shopDomain = anyOrder.shopDomain;
            }

            if (!shopDomain) {
                // Fallback to active store
                const fallbackStore = await ShopifyStore.findOne({ isActive: true }).sort({ updatedAt: -1 });
                if (fallbackStore) shopDomain = fallbackStore.shopDomain;
            }
        }

        if (!shopDomain) {
            const fallbackStore = await ShopifyStore.findOne({ isActive: true }).sort({ updatedAt: -1 });
            if (fallbackStore) shopDomain = fallbackStore.shopDomain;
        }

        if (!shopDomain) {
            return res.status(400).json({ success: false, message: 'Shop domain or active store connection not found' });
        }

        const result = await shopifyOrderService.syncOrders(shopDomain);

        // Forcefully push fulfillment and tracking for all booked orders (incoming and past)
        try {
            const shopifyFulfillmentService = require('../services/shopifyFulfillmentService');
            await shopifyFulfillmentService.forceFulfillAllBookedOrders(shopDomain);
        } catch (syncFulErr) {
            console.warn('[Shopify Force Fulfill Note]:', syncFulErr.message);
        }

        return res.status(200).json({
            success: true,
            imported: result?.imported || 0,
            skipped: result?.skipped || 0,
            message: `Successfully synchronized and fulfilled Shopify orders for ${shopDomain}`
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Triggers eBay order sync on behalf of a specific connected store user (Admin access)
 */
exports.adminSyncEbayOrders = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }

        const ebayOrderService = require('../services/ebayOrderService');
        const result = await ebayOrderService.importOrders(userId);

        return res.status(200).json({
            success: true,
            imported: result.imported,
            skipped: result.skipped,
            message: result.message || `Successfully synchronized ${result.imported} orders`
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Disconnects an Etsy store connection
 */
exports.disconnectEtsyStore = async (req, res) => {
    try {
        const { accountId } = req.params;
        const query = { _id: accountId };

        // Ensure user can only delete their own unless admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            query.userId = req.user._id;
        }

        const account = await MarketplaceAccount.findOneAndDelete(query);
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found or unauthorized' });
        }

        await MarketplaceLog.create({
            userId: req.user._id,
            platform: 'Etsy',
            action: 'Disconnect',
            status: 'Success',
            message: `Disconnected Etsy shop: ${account.shopName}`
        }).catch((logErr) => {
            const logFailed = logErr.message;
        });

        return res.status(200).json({ success: true, message: 'Etsy store disconnected successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Marks a marketplace order as fulfilled, linking it to a DFL shipment and uploading tracking
 */
exports.fulfillOrder = async (req, res) => {
    try {
        const { type, id } = req.params;
        const { shipmentId, awbNumber, userId } = req.body;

        // If admin is booking on behalf of user, use body.userId, else use logged-in user
        const targetUserId = (req.user.isAdmin && userId) ? userId : req.user._id;

        if (!shipmentId || !awbNumber) {
            return res.status(400).json({ success: false, message: 'Missing shipmentId or awbNumber' });
        }

        if (type === 'ebay') {
            const EbayOrder = require('../models/EbayOrder');
            const ebayOrder = await EbayOrder.findOne({ _id: id, userId: targetUserId });
            if (!ebayOrder) {
                return res.status(404).json({ success: false, message: 'eBay order not found' });
            }

            // Link shipment details
            ebayOrder.dflShipmentId = shipmentId;
            ebayOrder.dflAwbNumber = awbNumber;
            ebayOrder.orderStatus = 'SHIPMENT_CREATED';
            await ebayOrder.save();

            // Automatically push tracking details to eBay via Redis Queue
            try {
                const ebayQueue = require('../queues/ebayQueue');
                await ebayQueue.add('pushTracking', {
                    userId: targetUserId,
                    ebayOrderId: ebayOrder.ebayOrderId
                });
            } catch (queueErr) {
                const queueAddFailed = queueErr.message;
                if (process.env.BYPASS_REDIS !== 'true') {
                    const MarketplaceLog = require('../models/MarketplaceLog');
                    await MarketplaceLog.create({
                        userId: targetUserId,
                        platform: 'eBay',
                        action: 'QueueTrackingSync',
                        status: 'Error',
                        message: `Failed to queue tracking sync for eBay Order #${ebayOrder.ebayOrderId}: ${queueErr.message}`
                    }).catch((logErr) => {
                        const logWriteFailed = logErr.message;
                    });
                }
            }

            return res.status(200).json({ success: true, message: 'eBay order successfully marked as fulfilled' });

        } else if (type === 'etsy') {
            const EtsyOrder = require('../models/EtsyOrder');
            const etsyOrder = await EtsyOrder.findOne({ _id: id, userId: targetUserId });
            if (!etsyOrder) {
                return res.status(404).json({ success: false, message: 'Etsy order not found' });
            }

            etsyOrder.dflShipmentId = shipmentId;
            etsyOrder.awbNumber = awbNumber;
            etsyOrder.fulfillmentStatus = 'Shipment Created';
            await etsyOrder.save();

            return res.status(200).json({ success: true, message: 'Etsy order successfully marked as fulfilled' });
        } else if (type === 'shopify') {
            const ShopifyOrder = require('../models/ShopifyOrder');
            const Shipment = require('../models/Shipment');
            const shopifyFulfillmentService = require('../services/shopifyFulfillmentService');

            const isObjectId = typeof id === 'string' && id.match(/^[0-9a-fA-F]{24}$/);
            const shopifyOrder = isObjectId
                ? await ShopifyOrder.findById(id)
                : await ShopifyOrder.findOne({ $or: [{ shopifyOrderId: String(id) }, { orderNumber: String(id) }, { orderNumber: `#${id}` }] });
            if (!shopifyOrder) {
                return res.status(404).json({ success: false, message: 'Shopify order not found' });
            }

            // Lookup shipment to get real readable shipmentId (e.g. DFL...) or trackingId
            let shipmentDoc = null;
            if (shipmentId) {
                const isObjectId = typeof shipmentId === 'string' && shipmentId.match(/^[0-9a-fA-F]{24}$/);
                shipmentDoc = await Shipment.findOne({
                    $or: [
                        ...(isObjectId ? [{ _id: shipmentId }] : []),
                        { shipmentId: shipmentId }
                    ]
                });
            }

            const realAwbNumber = shipmentDoc?.trackingId
                || shipmentDoc?.shipmentId
                || (awbNumber && !awbNumber.match(/^[0-9a-fA-F]{24}$/) ? awbNumber : (shipmentDoc?.shipmentId || awbNumber));

            shopifyOrder.dflShipmentId = shipmentDoc?._id || shipmentId;
            shopifyOrder.dflAwbNumber = realAwbNumber;
            shopifyOrder.dflShipmentBooked = true;
            shopifyOrder.syncStatus = 'booked';
            shopifyOrder.lastTrackingStatus = shipmentDoc?.status || 'Pending';
            await shopifyOrder.save();

            // Dynamically synchronize fulfillment, tracking milestones, and status tags via service
            try {
                await shopifyFulfillmentService.syncShopifyOrderTracking(shopifyOrder, shipmentDoc);
            } catch (shopErr) {
                console.error('[Shopify Fulfillment Sync Warning]:', shopErr.message);
            }

            // Return standardized API response
            return res.status(200).json({
                success: true,
                message: 'Shopify order successfully processed for fulfillment',
                data: {
                    orderId: shopifyOrder._id,
                    shopifyOrderId: shopifyOrder.shopifyOrderId,
                    orderNumber: shopifyOrder.orderNumber,
                    awbNumber: realAwbNumber,
                    status: shopifyOrder.lastTrackingStatus || shipmentDoc?.status || 'Pending',
                    fulfillmentStatus: shopifyOrder.fulfillmentStatus || 'fulfilled',
                    syncStatus: shopifyOrder.syncStatus || 'booked'
                }
            });
        } else {
            return res.status(400).json({ success: false, message: 'Invalid marketplace platform type' });
        }
    } catch (error) {
        const safeMessage = String(error.message || 'Internal server error')
            .replace(/(Bearer|token|secret|password|key)\s*[:=]\s*[^,\s]+/gi, '$1: [REDACTED]')
            .replace(/shpat_[a-zA-Z0-9_]+/gi, '[REDACTED_SHOPIFY_TOKEN]');
        return res.status(500).json({ success: false, message: safeMessage });
    }
};