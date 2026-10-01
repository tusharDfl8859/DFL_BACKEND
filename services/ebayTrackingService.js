const axios = require('axios');
const EbayOrder = require('../models/EbayOrder');
const Shipment = require('../models/Shipment');
const { getValidAccessToken } = require('./ebayAuthService');

const BASE_URL = process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com'
    : 'https://api.ebay.com';

/**
 * Pushes tracking updates back to eBay for a single order with strict DFL branding
 * @param {string} userId
 * @param {string} ebayOrderId
 */
const pushTrackingToEbay = async (userId, ebayOrderId) => {
    const order = await EbayOrder.findOne({ ebayOrderId, userId });
    if (!order) {
        throw new Error(`eBay order not found: ${ebayOrderId}`);
    }

    if (!order.dflShipmentId) {
        throw new Error(`No DFL shipment found for eBay order: ${ebayOrderId}`);
    }

    const shipment = await Shipment.findOne({ shipmentId: order.dflShipmentId });
    if (!shipment) {
        throw new Error(`DFL shipment not found: ${order.dflShipmentId}`);
    }

    // Always use DFL shipmentId as the tracking/AWB number and booked serviceName as carrier/service code
    const awbNumber = shipment.shipmentId;
    const serviceName = shipment.serviceDetails?.serviceName || 'DFL Express';

    const accessToken = await getValidAccessToken(userId);

    const rawLineItems = order.rawData?.lineItems || order.lineItems || [];
    const lineItemsPayload = rawLineItems.map((item, index) => ({
        lineItemId: item.lineItemId || String(index + 1),
        quantity: item.quantity || 1
    }));

    const trackingPayload = {
        lineItems: lineItemsPayload,
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: serviceName,
        trackingNumber: awbNumber
    };

    await axios.post(
        `${BASE_URL}/sell/fulfillment/v1/order/${ebayOrderId}/shipping_fulfillment`,
        trackingPayload,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        }
    );

    order.trackingStatus = 'TRACKING_UPLOADED';
    order.orderStatus = 'DISPATCHED';
    order.dflAwbNumber = awbNumber;
    await order.save();

    return {
        success: true,
        ebayOrderId,
        awbNumber,
        serviceName,
        trackingStatus: 'TRACKING_UPLOADED'
    };
};

/**
 * Synchronizes tracking status updates for all pending shipments of a user with eBay
 * @param {string} userId
 */
const syncAllPendingTracking = async (userId) => {
    const pendingOrders = await EbayOrder.find({
        userId,
        orderStatus: 'SHIPMENT_CREATED',
        dflShipmentId: { $ne: null }
    });

    const results = {
        total: pendingOrders.length,
        success: 0,
        failed: 0,
        errors: []
    };

    for (const order of pendingOrders) {
        try {
            await pushTrackingToEbay(userId, order.ebayOrderId);
            results.success++;
        } catch (error) {
            results.failed++;
            results.errors.push({
                orderId: order.ebayOrderId,
                error: error.message
            });
        }
    }

    return results;
};

/**
 * Updates status of local eBay orders based on DFL transit updates
 * @param {string} dflShipmentId
 */
const syncTrackingFromDFL = async (dflShipmentId) => {
    const shipment = await Shipment.findOne({ shipmentId: dflShipmentId });
    if (!shipment) {
        throw new Error(`DFL shipment not found: ${dflShipmentId}`);
    }

    const order = await EbayOrder.findOne({ dflShipmentId });
    if (!order) {
        // Not all shipments are from eBay, safe return if not found
        return { success: false, message: `No eBay order linked to shipment: ${dflShipmentId}` };
    }

    const statusMap = {
        'Pending': 'SHIPMENT_CREATED',
        'Processing': 'PROCESSING',
        'Shipment Received at Our Hub': 'RECEIVED_AT_HUB',
        'Shipment Dispatched': 'DISPATCHED',
        'In Transit': 'IN_TRANSIT',
        'Received at Destination Hub': 'IN_TRANSIT',
        'Out for Delivery': 'OUT_FOR_DELIVERY',
        'Delivered': 'DELIVERED',
        'Cancelled': 'CANCELLED',
        'Returned': 'RETURNED',
        'RTO': 'RETURNED',
        'Dispute Raised': 'ON_HOLD',
        'On Hold': 'ON_HOLD'
    };

    const newOrderStatus = statusMap[shipment.status] || order.orderStatus;
    order.orderStatus = newOrderStatus;
    order.dflAwbNumber = shipment.shipmentId;

    // Automatically push tracking to eBay if dispatched/in-transit and not already uploaded
    if (['Shipment Dispatched', 'In Transit'].includes(shipment.status) && order.trackingStatus !== 'TRACKING_UPLOADED') {
        try {
            await pushTrackingToEbay(order.userId, order.ebayOrderId);
        } catch (pushErr) {
            console.error(`[eBay Tracking Push Error] For order ${order.ebayOrderId}:`, pushErr.message);
        }
    }

    await order.save();

    return {
        success: true,
        ebayOrderId: order.ebayOrderId,
        dflStatus: shipment.status,
        orderStatus: order.orderStatus,
        awbNumber: order.dflAwbNumber
    };
};

module.exports = {
    pushTrackingToEbay,
    syncAllPendingTracking,
    syncTrackingFromDFL
};