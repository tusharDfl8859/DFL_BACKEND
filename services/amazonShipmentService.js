const AmazonOrder = require('../models/AmazonOrder');
const User = require('../models/User');
const Admin = require('../models/Admin');
const amazonService = require('./amazonService');
const { calculateRatesInternal } = require('../controllers/ratesController');
const { createShipment } = require('../controllers/shipmentController');

/**
 * Imports unshipped orders from Amazon SP-API and persists them into AmazonOrder collection
 * @param {string} userId - User or Admin ID
 * @returns {Promise<{ success: boolean, imported: number, skipped: number, message?: string }>}
 */
const importOrders = async (userId) => {
    let account = await User.findById(userId);
    if (!account) {
        account = await Admin.findById(userId);
    }

    if (!account || !account.amazonStore || account.amazonStore.status !== 'connected') {
        return {
            success: false,
            imported: 0,
            skipped: 0,
            message: 'Amazon store is not connected for this account'
        };
    }

    const refreshToken = account.amazonStore.refreshToken;
    const marketplaceId = account.amazonStore.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV';

    // Fetch unshipped/partially shipped orders from SP-API (with sandbox support)
    const rawOrders = await amazonService.getOrders({
        refreshToken,
        marketplaceId,
        orderStatuses: ['Unshipped', 'PartiallyShipped']
    });

    let importedCount = 0;
    let skippedCount = 0;

    for (const rawOrder of rawOrders) {
        const orderId = rawOrder.AmazonOrderId;
        if (!orderId) continue;

        // Check for deduplication
        const existing = await AmazonOrder.findOne({ amazonOrderId: orderId });
        if (existing) {
            skippedCount++;
            continue;
        }

        // Fetch line items for the order
        let rawItems = [];
        try {
            rawItems = await amazonService.getOrderItems({
                refreshToken,
                amazonOrderId: orderId
            });
        } catch (itemErr) {
            console.warn(`[AmazonSync] Could not fetch items for order ${orderId}, using defaults:`, itemErr.message);
        }

        const lineItems = (rawItems.length > 0 ? rawItems : [
            {
                OrderItemId: `ITEM-${orderId}-01`,
                Title: 'Amazon Marketplace Item',
                QuantityOrdered: rawOrder.NumberOfItemsUnshipped || 1,
                ItemPrice: { Amount: rawOrder.OrderTotal?.Amount || 0, CurrencyCode: rawOrder.OrderTotal?.CurrencyCode || 'USD' },
                SellerSKU: ''
            }
        ]).map(item => ({
            orderItemId: item.OrderItemId || '',
            title: item.Title || 'Amazon Marketplace Item',
            sku: item.SellerSKU || '',
            quantity: Number(item.QuantityOrdered) || 1,
            price: Number(item.ItemPrice?.Amount) || 0,
            currency: item.ItemPrice?.CurrencyCode || rawOrder.OrderTotal?.CurrencyCode || 'USD'
        }));

        const shippingAddress = {
            fullName: rawOrder.ShippingAddress?.Name || rawOrder.BuyerInfo?.BuyerName || 'Amazon Customer',
            addressLine1: rawOrder.ShippingAddress?.AddressLine1 || '',
            addressLine2: rawOrder.ShippingAddress?.AddressLine2 || '',
            city: rawOrder.ShippingAddress?.City || '',
            state: rawOrder.ShippingAddress?.StateOrRegion || '',
            postalCode: rawOrder.ShippingAddress?.PostalCode || '',
            country: rawOrder.ShippingAddress?.CountryCode || 'US',
            phone: rawOrder.ShippingAddress?.Phone || ''
        };

        await AmazonOrder.create({
            userId,
            amazonOrderId: orderId,
            orderStatus: 'AWAITING_FULFILLMENT',
            currency: rawOrder.OrderTotal?.CurrencyCode || 'USD',
            orderTotal: Number(rawOrder.OrderTotal?.Amount) || 0,
            purchaseDate: rawOrder.PurchaseDate ? new Date(rawOrder.PurchaseDate) : new Date(),
            buyer: {
                name: rawOrder.BuyerInfo?.BuyerName || shippingAddress.fullName,
                email: rawOrder.BuyerInfo?.BuyerEmail || '',
                buyerCounty: rawOrder.BuyerInfo?.BuyerCounty || ''
            },
            shippingAddress,
            lineItems,
            marketplaceId,
            rawData: rawOrder
        });

        importedCount++;
    }

    return {
        success: true,
        imported: importedCount,
        skipped: skippedCount
    };
};

/**
 * Calculates shipping rates for a specific Amazon order using DFL rate engine
 * @param {string} userId
 * @param {string} amazonOrderId
 */
const getRatesForOrder = async (userId, amazonOrderId) => {
    let order = await AmazonOrder.findOne({ amazonOrderId, userId });
    if (!order) {
        // Fallback check if user is admin
        const adminAccount = await Admin.findById(userId);
        if (adminAccount) {
            order = await AmazonOrder.findOne({ amazonOrderId });
        }
    }

    if (!order) {
        throw new Error(`Amazon order not found: ${amazonOrderId}`);
    }

    let user = await User.findById(userId);
    if (!user) {
        user = await Admin.findById(userId);
    }
    if (!user) {
        throw new Error('User account not found');
    }

    const billing = user.kycData?.billingAddress || {};

    // Calculate rates with 0.5kg default box or line items weight
    const rates = await calculateRatesInternal({
        weight: 0.5,
        destination: {
            country: order.shippingAddress?.country === 'US' ? 'United States' : (order.shippingAddress?.country || 'United States'),
            countryCode: order.shippingAddress?.country || 'US',
            city: order.shippingAddress?.city || '',
            state: order.shippingAddress?.state || '',
            postalCode: order.shippingAddress?.postalCode || '',
            zip: order.shippingAddress?.postalCode || ''
        },
        packageDetails: {
            box: [{ weight: 0.5, length: 10, width: 10, height: 10 }]
        },
        shipmentType: 'express',
        userId: userId.toString()
    });

    return {
        order,
        rates,
        shipperAddress: billing
    };
};

/**
 * Books a DFL shipment on behalf of the customer for their Amazon order
 * @param {string} userId
 * @param {string} amazonOrderId
 * @param {object} serviceDetails
 * @param {object} shipmentDetails
 */
const createShipmentForOrder = async (userId, amazonOrderId, serviceDetails, shipmentDetails) => {
    let order = await AmazonOrder.findOne({ amazonOrderId, userId });
    if (!order) {
        const adminAccount = await Admin.findById(userId);
        if (adminAccount) {
            order = await AmazonOrder.findOne({ amazonOrderId });
        }
    }

    if (!order) {
        throw new Error(`Amazon order not found: ${amazonOrderId}`);
    }

    // Prevent duplicate booking
    if (order.dflShipmentId || order.orderStatus === 'SHIPMENT_CREATED' || order.orderStatus === 'SHIPPED') {
        throw new Error(`Shipment has already been booked for this Amazon order (AWB: ${order.dflAwbNumber || 'N/A'})`);
    }

    let user = await User.findById(userId);
    if (!user) {
        user = await Admin.findById(userId);
    }
    if (!user) {
        throw new Error('User account not found');
    }

    const billing = user.kycData?.billingAddress || {};

    const shipmentPayload = {
        shipperDetails: {
            shipperName: user.name || 'DFL Shipper',
            mobileNo: user.phone || billing.mobileNo || '',
            email: user.email || '',
            addressLine1: billing.addressLine1 || 'Warehouse 1',
            addressLine2: billing.addressLine2 || '',
            city: billing.city || 'Delhi',
            state: billing.state || 'Delhi',
            pincode: billing.pincode || '110001',
            country: 'India',
            countryCode: 'IN'
        },
        consigneeDetails: {
            consigneeName: order.shippingAddress?.fullName || order.buyer?.name || 'Amazon Buyer',
            mobileNo: order.shippingAddress?.phone || '',
            email: order.buyer?.email || '',
            addressLine1: order.shippingAddress?.addressLine1 || '',
            addressLine2: order.shippingAddress?.addressLine2 || '',
            city: order.shippingAddress?.city || '',
            state: order.shippingAddress?.state || '',
            pincode: order.shippingAddress?.postalCode || '',
            country: order.shippingAddress?.country === 'US' ? 'United States' : (order.shippingAddress?.country || 'United States'),
            countryCode: order.shippingAddress?.country || 'US'
        },
        shipmentDetails: {
            ...shipmentDetails,
            referenceNumber: order.amazonOrderId,
            currency: order.currency || 'USD',
            shipmentCategory: 'csb5',
            boxes: shipmentDetails?.boxes || [
                {
                    weight: shipmentDetails?.weight || 0.5,
                    length: shipmentDetails?.length || 10,
                    width: shipmentDetails?.width || 10,
                    height: shipmentDetails?.height || 10,
                    items: order.lineItems.map(item => ({
                        description: item.title,
                        quantity: item.quantity,
                        unitPrice: item.price,
                        sku: item.sku || ''
                    }))
                }
            ]
        },
        serviceDetails,
        paymentMode: 'Wallet',
        userId: userId.toString(),
        amazonOrderId: order.amazonOrderId
    };

    // Construct mock request and response context to delegate to internal shipmentController
    const mockReq = {
        body: shipmentPayload,
        user: { _id: userId, isAdmin: true },
        partner: null
    };

    let createdShipment = null;
    const mockRes = {
        status: () => ({
            json: (data) => { createdShipment = data; }
        }),
        json: (data) => { createdShipment = data; }
    };

    await createShipment(mockReq, mockRes);

    if (!createdShipment || !createdShipment.shipmentId) {
        throw new Error('Shipment creation failed: ' + JSON.stringify(createdShipment));
    }

    order.dflShipmentId = createdShipment.shipmentId;
    order.dflAwbNumber = createdShipment.trackingId || createdShipment.shipmentId;
    order.trackingCarrier = createdShipment.serviceDetails?.carrierName || createdShipment.trackingCarrier || 'DFL Express';
    order.orderStatus = 'SHIPMENT_CREATED';
    await order.save();

    return {
        success: true,
        shipment: createdShipment,
        amazonOrder: order
    };
};

/**
 * Pushes tracking number (AWB) and carrier name to Amazon via confirmShipment SP-API
 * @param {object} params
 * @param {string} params.amazonOrderId
 * @param {string} params.trackingNumber
 * @param {string} params.carrierName
 */
const pushTrackingToAmazon = async ({ amazonOrderId, trackingNumber, carrierName }) => {
    if (!amazonOrderId || !trackingNumber) return;

    const order = await AmazonOrder.findOne({ amazonOrderId });
    if (!order) {
        console.warn(`[AmazonTracking] Amazon order not found: ${amazonOrderId}`);
        return;
    }

    if (order.isTrackingSynced) {
        return; // Already pushed to Amazon
    }

    let account = await User.findById(order.userId);
    if (!account) {
        account = await Admin.findById(order.userId);
    }

    if (!account || !account.amazonStore || !account.amazonStore.refreshToken) {
        console.warn(`[AmazonTracking] No connected Amazon store credentials found for user ${order.userId}`);
        return;
    }

    const refreshToken = account.amazonStore.refreshToken;
    const carrier = carrierName || order.trackingCarrier || 'DFL Express';

    try {
        await amazonService.confirmShipment({
            refreshToken,
            amazonOrderId: order.amazonOrderId,
            marketplaceId: order.marketplaceId,
            trackingNumber,
            carrierName: carrier,
            orderItems: order.lineItems
        });

        order.isTrackingSynced = true;
        order.trackingSyncedAt = new Date();
        order.orderStatus = 'SHIPPED';
        order.dflAwbNumber = trackingNumber;
        order.trackingCarrier = carrier;
        await order.save();

        console.log(`[AmazonTracking] Successfully confirmed shipment on Amazon for order ${order.amazonOrderId} with AWB: ${trackingNumber}`);
    } catch (error) {
        console.error(`[AmazonTracking] Failed to confirm shipment on Amazon for order ${order.amazonOrderId}:`, error.message);
        order.trackingSyncError = error.message;
        await order.save();
    }
};

/**
 * Retrieves orders from database for a user/admin with filtering
 * @param {string} userId
 * @param {object} queryParams
 */
const getOrders = async (userId, queryParams = {}) => {
    const query = { userId };
    if (queryParams.status) {
        query.orderStatus = queryParams.status;
    }
    return await AmazonOrder.find(query).sort({ createdAt: -1 });
};

module.exports = {
    importOrders,
    getRatesForOrder,
    createShipmentForOrder,
    pushTrackingToAmazon,
    getOrders
};
