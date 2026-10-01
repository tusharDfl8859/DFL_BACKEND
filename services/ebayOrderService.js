const axios = require('axios');
const EbayOrder = require('../models/EbayOrder');
const { getValidAccessToken } = require('./ebayAuthService');

const BASE_URL = process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com'
    : 'https://api.ebay.com';

const mapEbayStatus = (status) => {
    if (status === 'NOT_STARTED' || status === 'IN_PROGRESS') {
        return 'AWAITING_FULFILLMENT';
    }
    if (status === 'FULFILLED') {
        return 'DISPATCHED';
    }
    return status || 'AWAITING_FULFILLMENT';
};

/**
 * Fetches new order details from the eBay Fulfillment API and persists them locally
 * @param {string} userId
 */
const importOrders = async (userId) => {
    try {
        const accessToken = await getValidAccessToken(userId);

        const response = await axios.get(`${BASE_URL}/sell/fulfillment/v1/order`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            params: {
                limit: 50,
                filter: 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}'
            }
        });

        const orders = response.data.orders || [];

        if (orders.length === 0) {
            return { success: true, imported: 0, skipped: 0, message: 'No pending orders found on eBay' };
        }

        let imported = 0;
        let skipped = 0;

        for (const order of orders) {
            try {
                const exists = await EbayOrder.findOne({ ebayOrderId: order.orderId });
                const mappedStatus = mapEbayStatus(order.orderFulfillmentStatus);
                if (exists) {
                    // Update fulfillment status if changed on eBay
                    if (mappedStatus && exists.orderStatus !== mappedStatus && exists.orderStatus !== 'SHIPMENT_CREATED' && exists.orderStatus !== 'DISPATCHED') {
                        exists.orderStatus = mappedStatus;
                        await exists.save();
                    }
                    skipped++;
                    continue;
                }

                const ship = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};

                const lineItems = (order.lineItems || []).map(item => ({
                    lineItemId: item.lineItemId || null,
                    title: item.title,
                    sku: item.sku || null,
                    quantity: item.quantity,
                    price: item.lineItemCost?.value || 0,
                    currency: item.lineItemCost?.currency || 'USD'
                }));

                await EbayOrder.create({
                    userId,
                    ebayOrderId: order.orderId,
                    orderStatus: mappedStatus,
                    currency: order.pricingSummary?.total?.currency || 'USD',
                    orderTotal: parseFloat(order.pricingSummary?.total?.value || 0),
                    buyer: {
                        username: order.buyer?.username || null,
                        email: order.buyer?.taxAddress?.email || null
                    },
                    shippingAddress: {
                        fullName: ship.fullName || null,
                        addressLine1: ship.contactAddress?.addressLine1 || null,
                        addressLine2: ship.contactAddress?.addressLine2 || null,
                        city: ship.contactAddress?.city || null,
                        state: ship.contactAddress?.stateOrProvince || null,
                        postalCode: ship.contactAddress?.postalCode || null,
                        country: ship.contactAddress?.countryCode || null,
                        phone: ship.primaryPhone?.phoneNumber || null
                    },
                    lineItems,
                    rawData: order
                });

                imported++;
            } catch (err) {
                throw new Error(`Error importing eBay order ${order.orderId}: ` + err.message);
            }
        }

        return { success: true, imported, skipped, message: `Successfully synchronized ${imported} new orders (${skipped} existing)` };
    } catch (error) {
        
        throw new Error(error.response?.data?.errors?.[0]?.message || error.message);
    }
};

/**
 * Retrieves all imported eBay orders for the specified user ID
 * @param {string} userId
 */
const getOrders = async (userId) => {
    return await EbayOrder.find({ userId }).sort({ createdAt: -1 });
};

module.exports = {
    importOrders,
    getOrders
};
