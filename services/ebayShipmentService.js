const EbayOrder = require('../models/EbayOrder');
const User = require('../models/User');
const { calculateRatesInternal } = require('../controllers/ratesController');
const { createShipment } = require('../controllers/shipmentController');

/**
 * Calculates shipping rates for a specific eBay order
 * @param {string} userId
 * @param {string} ebayOrderId
 */
const getRatesForOrder = async (userId, ebayOrderId) => {
    const order = await EbayOrder.findOne({ ebayOrderId, userId });
    if (!order) {
        throw new Error(`eBay order not found: ${ebayOrderId}`);
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const billing = user.kycData?.billingAddress || {};

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
 * Books a DFL shipment on behalf of the customer for their eBay order
 * @param {string} userId
 * @param {string} ebayOrderId
 * @param {object} serviceDetails
 * @param {object} shipmentDetails
 */
const createShipmentForOrder = async (userId, ebayOrderId, serviceDetails, shipmentDetails) => {
    const order = await EbayOrder.findOne({ ebayOrderId, userId });
    if (!order) {
        throw new Error(`eBay order not found: ${ebayOrderId}`);
    }

    // Prevent duplicate booking
    if (order.dflShipmentId || order.orderStatus === 'SHIPMENT_CREATED') {
        throw new Error(`Shipment has already been booked for this eBay order (AWB: ${order.dflAwbNumber || 'N/A'})`);
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const billing = user.kycData?.billingAddress || {};

    const shipmentPayload = {
        shipperDetails: {
            shipperName: user.name,
            mobileNo: user.phone || '',
            email: user.email || '',
            addressLine1: billing.addressLine1 || '',
            addressLine2: billing.addressLine2 || '',
            city: billing.city || 'Delhi',
            state: billing.state || 'Delhi',
            pincode: billing.pincode || '110001',
            country: 'India',
            countryCode: 'IN'
        },
        consigneeDetails: {
            consigneeName: order.shippingAddress?.fullName || order.buyer?.username || '',
            mobileNo: order.shippingAddress?.phone || '',
            email: order.buyer?.email || '',
            addressLine1: order.shippingAddress?.addressLine1 || '',
            addressLine2: order.shippingAddress?.addressLine2 || '',
            city: order.shippingAddress?.city || '',
            state: order.shippingAddress?.state || '',
            pincode: order.shippingAddress?.postalCode || '',
            country: 'United States',
            countryCode: order.shippingAddress?.country || 'US'
        },
        shipmentDetails: {
            ...shipmentDetails,
            referenceNumber: order.ebayOrderId,
            currency: order.currency || 'USD',
            shipmentCategory: 'csb5',
            boxes: shipmentDetails.boxes || [
                {
                    weight: shipmentDetails.weight || 0.5,
                    length: shipmentDetails.length || 10,
                    width: shipmentDetails.width || 10,
                    height: shipmentDetails.height || 10,
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
        userId: userId.toString()
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
    order.orderStatus = 'SHIPMENT_CREATED';
    await order.save();

    return {
        success: true,
        shipment: createdShipment,
        ebayOrder: order
    };
};

/**
 * Retrieves the recorded DFL shipment details for the specified eBay order
 * @param {string} userId
 * @param {string} ebayOrderId
 */
const getShipmentForOrder = async (userId, ebayOrderId) => {
    const order = await EbayOrder.findOne({ ebayOrderId, userId });
    if (!order) {
        throw new Error(`eBay order not found: ${ebayOrderId}`);
    }

    return {
        ebayOrderId: order.ebayOrderId,
        orderStatus: order.orderStatus,
        dflShipmentId: order.dflShipmentId,
        dflAwbNumber: order.dflAwbNumber,
        trackingStatus: order.trackingStatus,
        shippingAddress: order.shippingAddress,
        lineItems: order.lineItems
    };
};

module.exports = {
    getRatesForOrder,
    createShipmentForOrder,
    getShipmentForOrder
};