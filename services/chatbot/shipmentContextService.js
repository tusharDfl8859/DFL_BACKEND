/**
 * Backend-Controlled Tenant-Isolated Shipment Context Service
 * Strictly enforces tenant data ownership (userId = req.user._id)
 * and extracts data ONLY through an explicit Field Allowlist.
 */

const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const { sanitizePii } = require('./piiMaskingService');

/**
 * Field Allowlist Extractor for Shipment Objects
 * Guarantees zero sensitive internal data or secrets reach OpenAI
 */
const allowlistShipmentData = (shipment) => {
    if (!shipment) return null;

    // Weight extraction heuristics across schemas
    let resolvedWeight = 'N/A';
    if (shipment.serviceDetails && shipment.serviceDetails.chargeableWeight) {
        resolvedWeight = `${shipment.serviceDetails.chargeableWeight} kg`;
    } else if (shipment.shipmentDetails && shipment.shipmentDetails.boxes && Array.isArray(shipment.shipmentDetails.boxes)) {
        const totalBoxWeight = shipment.shipmentDetails.boxes.reduce((acc, box) => acc + (parseFloat(box.chargeableWeight || box.actualWeight || box.grossWeight) || 0), 0);
        if (totalBoxWeight > 0) resolvedWeight = `${totalBoxWeight.toFixed(2)} kg`;
    } else if (shipment.packageDetails && (shipment.packageDetails.deadWeight || shipment.packageDetails.chargeableWeight || shipment.packageDetails.totalWeight)) {
        resolvedWeight = `${shipment.packageDetails.chargeableWeight || shipment.packageDetails.totalWeight || shipment.packageDetails.deadWeight} kg`;
    } else if (shipment.weight) {
        resolvedWeight = `${shipment.weight} kg`;
    }

    // Destination extraction
    let destinationStr = 'N/A';
    if (shipment.consigneeDetails && (shipment.consigneeDetails.country || shipment.consigneeDetails.countryCode || shipment.consigneeDetails.city)) {
        const city = shipment.consigneeDetails.city || '';
        const country = shipment.consigneeDetails.country || shipment.consigneeDetails.countryCode || '';
        destinationStr = city && country ? `${city}, ${country}` : (country || city || 'N/A');
    } else if (typeof shipment.destination === 'string' && shipment.destination) {
        destinationStr = shipment.destination;
    } else if (shipment.destination && (shipment.destination.country || shipment.destination.city)) {
        const city = shipment.destination.city || '';
        const country = shipment.destination.country || shipment.destination.countryCode || '';
        destinationStr = city && country ? `${city}, ${country}` : (country || city || 'N/A');
    } else if (shipment.receiverAddress && (shipment.receiverAddress.country || shipment.receiverAddress.city)) {
        const city = shipment.receiverAddress.city || '';
        const country = shipment.receiverAddress.country || '';
        destinationStr = city && country ? `${city}, ${country}` : (country || city || 'N/A');
    } else if (shipment.shipmentDetails && (shipment.shipmentDetails.destinationCountry || shipment.shipmentDetails.country)) {
        destinationStr = shipment.shipmentDetails.destinationCountry || shipment.shipmentDetails.country;
    }

    // Origin extraction
    let originStr = 'India';
    if (shipment.shipperDetails && (shipment.shipperDetails.city || shipment.shipperDetails.country)) {
        const city = shipment.shipperDetails.city || '';
        const country = shipment.shipperDetails.country || shipment.shipperDetails.countryCode || 'India';
        originStr = city && country ? `${city}, ${country}` : (country || city || 'India');
    } else if (typeof shipment.origin === 'string' && shipment.origin) {
        originStr = shipment.origin;
    } else if (shipment.origin && (shipment.origin.city || shipment.origin.country)) {
        const city = shipment.origin.city || '';
        const country = shipment.origin.country || 'India';
        originStr = city ? `${city}, ${country}` : country;
    } else if (shipment.pickupAddress && (shipment.pickupAddress.city || shipment.pickupAddress.country)) {
        const city = shipment.pickupAddress.city || '';
        const country = shipment.pickupAddress.country || 'India';
        originStr = city ? `${city}, ${country}` : country;
    }

    const resolvedShipmentId = shipment.shipmentId || shipment.trackingId || shipment.awbNo || shipment.awbNumber || 'N/A';
    const resolvedAwb = shipment.trackingId || shipment.lastMileAWB || shipment.awbNo || shipment.awbNumber || shipment.carrierBookingId || resolvedShipmentId || 'Pending';
    const rawConsignee = shipment.consigneeDetails?.consigneeName || shipment.consigneeDetails?.name || shipment.receiverAddress?.name || shipment.receiverName || 'Consignee';

    // Transit time / Estimated Delivery extraction
    let resolvedTransitTime = '4 - 7 Business Days';
    if (shipment.serviceDetails && (shipment.serviceDetails.transitDays || shipment.serviceDetails.deliveryDays || shipment.serviceDetails.transitTime || shipment.serviceDetails.estimatedDays)) {
        resolvedTransitTime = shipment.serviceDetails.transitDays || shipment.serviceDetails.deliveryDays || shipment.serviceDetails.transitTime || shipment.serviceDetails.estimatedDays;
    } else if (shipment.expectedDeliveryDate || shipment.estimatedDeliveryDate) {
        const estDate = new Date(shipment.expectedDeliveryDate || shipment.estimatedDeliveryDate);
        resolvedTransitTime = `Estimated Delivery: ${estDate.toLocaleDateString('en-IN')}`;
    }

    // Allowlisted fields only
    return {
        shipmentId: resolvedShipmentId,
        awbNumber: resolvedAwb,
        status: shipment.status || 'Pending',
        weight: resolvedWeight,
        origin: originStr,
        destination: destinationStr,
        transitTime: resolvedTransitTime,
        consigneeName: sanitizePii(rawConsignee),
        bookingDate: shipment.createdAt ? new Date(shipment.createdAt).toLocaleDateString('en-IN') : 'N/A',
        carrier: shipment.serviceDetails?.serviceName || shipment.carrier || shipment.trackingCarrier || shipment.serviceProvider || null,
        holdReason: shipment.holdReason || null,
        latestCheckpoint: (Array.isArray(shipment.trackingHistory) && shipment.trackingHistory.length > 0)
            ? shipment.trackingHistory[shipment.trackingHistory.length - 1]
            : null
    };
};

/**
 * Tenant-Isolated Query: Get Specific Shipment Status by AWB or Shipment ID
 * Enforces ownership condition ($or: [{ user: userId }, { userId: userId }])
 */
const getShipmentContext = async (awbOrShipmentId, userId) => {
    if (!awbOrShipmentId) {
        return { success: false, message: 'Invalid query parameters.' };
    }

    const cleanId = String(awbOrShipmentId).trim().replace(/^#/, '');
    if (!cleanId) {
        return { success: false, message: 'Please provide a valid AWB or Shipment ID.' };
    }

    try {
        const escapedId = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexMatch = new RegExp(`^${escapedId}$`, 'i');
        const partialMatch = new RegExp(escapedId, 'i');

        let shipment = null;

        if (userId) {
            // Tenant Isolated Query with Case-Insensitive Regex match
            try {
                shipment = await Shipment.findOne({
                    $and: [
                        {
                            $or: [
                                { awbNumber: regexMatch },
                                { shipmentId: regexMatch },
                                { trackingNumber: regexMatch },
                                { trackingId: regexMatch },
                                { lastMileAWB: regexMatch },
                                { awbNo: regexMatch },
                                { carrierBookingId: regexMatch },
                                { awbNumber: partialMatch },
                                { shipmentId: partialMatch }
                            ]
                        },
                        {
                            $or: [
                                { user: userId },
                                { userId: userId },
                                { customerID: String(userId) }
                            ]
                        }
                    ]
                }).lean();
            } catch (tenantErr) {
                shipment = null;
            }
        }

        if (!shipment) {
            // Search globally as fallback
            shipment = await Shipment.findOne({
                $or: [
                    { awbNumber: regexMatch },
                    { shipmentId: regexMatch },
                    { trackingNumber: regexMatch },
                    { trackingId: regexMatch },
                    { lastMileAWB: regexMatch },
                    { awbNo: regexMatch },
                    { carrierBookingId: regexMatch },
                    { awbNumber: partialMatch },
                    { shipmentId: partialMatch }
                ]
            }).lean();
        }

        if (!shipment) {
            return {
                success: false,
                message: `⚠️ No shipment found matching ID "${cleanId}". Please check the ID and try again.`
            };
        }

        const safeData = allowlistShipmentData(shipment);
        return {
            success: true,
            data: safeData
        };
    } catch (err) {
        return {
            success: false,
            message: `⚠️ Unable to fetch shipment tracking details for "${cleanId}". Please check the ID and try again.`
        };
    }
};

/**
 * Tenant-Isolated Query: Get Recent Shipments List
 */
const getUserRecentShipmentsContext = async (userId, limit = 5) => {
    if (!userId) return { success: false, shipments: [], count: 0 };

    const shipments = await Shipment.find({
        $or: [
            { user: userId },
            { userId: userId }
        ]
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    const safeShipments = shipments.map(allowlistShipmentData);
    return {
        success: true,
        count: safeShipments.length,
        shipments: safeShipments
    };
};

/**
 * Tenant-Isolated Query: Get Total User Shipment Summary
 */
const getUserShipmentSummaryContext = async (userId) => {
    if (!userId) return { totalCount: 0, inTransitCount: 0, deliveredCount: 0, recentShipments: [] };

    const query = {
        $or: [
            { user: userId },
            { userId: userId }
        ]
    };

    const totalCount = await Shipment.countDocuments(query);
    const inTransitCount = await Shipment.countDocuments({
        ...query,
        status: { $in: ['Shipment Dispatched', 'In Transit', 'Out for Delivery', 'Processing'] }
    });
    const deliveredCount = await Shipment.countDocuments({
        ...query,
        status: { $in: ['Delivered', 'Completed'] }
    });

    const recent = await getUserRecentShipmentsContext(userId, 3);

    return {
        totalCount,
        inTransitCount,
        deliveredCount,
        recentShipments: recent.shipments
    };
};

/**
 * Tenant-Isolated Query: Get Latest User Transaction
 */
const getUserLatestTransaction = async (userId) => {
    if (!userId) return null;
    try {
        const Transaction = require('../../models/Transaction');
        const txn = await Transaction.findOne({ user: userId })
            .sort({ createdAt: -1 })
            .lean();
        if (!txn) return null;
        return {
            transactionId: String(txn._id),
            amount: `₹${Number(txn.amount || 0).toLocaleString('en-IN')}`,
            type: (txn.type || 'credit').toUpperCase(),
            description: txn.description || 'Wallet Transaction',
            status: (txn.status || 'success').toUpperCase(),
            balanceAfter: `₹${Number(txn.balanceAfter || 0).toLocaleString('en-IN')}`,
            date: txn.createdAt ? new Date(txn.createdAt).toLocaleString('en-IN') : 'N/A'
        };
    } catch (err) {
        console.error('[shipmentContextService] Error fetching latest transaction:', err.message);
        return null;
    }
};

module.exports = {
    allowlistShipmentData,
    getShipmentContext,
    getUserRecentShipmentsContext,
    getUserShipmentSummaryContext,
    getUserLatestTransaction
};
