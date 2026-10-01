/**
 * Utility helper to calculate shipment delay metrics:
 * 1. Pickup Delay: Scheduled pickup date passed & shipment not yet picked up.
 * 2. Dispatch Delay: Arrived at Hub > 24 hours ago & not yet dispatched.
 * 3. Delivery Delay: Service ETA + 2 grace days passed & not yet delivered.
 */

/**
 * Format hours into readable day/hour string
 */
function formatDelayTime(totalHours) {
    if (totalHours <= 0) return '0h';
    const days = Math.floor(totalHours / 24);
    const hours = Math.floor(totalHours % 24);
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    return `${hours}h`;
}

/**
 * Calculate Pickup Delay metrics
 */
function calculatePickupDelay(shipment, now = new Date()) {
    if (!shipment) return { isDelayed: false, delayHours: 0, delayText: null };

    // Terminal/post-pickup statuses where pickup delay no longer applies
    const postPickupStatuses = [
        'Shipment Received at Our Hub',
        'Received at Destination Hub',
        'Shipment Dispatched',
        'In Transit',
        'Out for Delivery',
        'Delivered',
        'Cancelled',
        'RTO'
    ];

    if (postPickupStatuses.includes(shipment.status)) {
        return { isDelayed: false, delayHours: 0, delayText: null };
    }

    if (shipment.pickupDetails?.status === 'Picked Up') {
        return { isDelayed: false, delayHours: 0, delayText: null };
    }

    // Determine scheduled pickup date
    const pickupDateRaw = shipment.shipperDetails?.date || shipment.pickupDetails?.pickedAt || shipment.createdAt;
    if (!pickupDateRaw) return { isDelayed: false, delayHours: 0, delayText: null };

    const pickupScheduledDate = new Date(pickupDateRaw);
    // Standard pickup cutoff: end of scheduled pickup day (23:59:59)
    const cutoffDate = new Date(pickupScheduledDate);
    cutoffDate.setHours(23, 59, 59, 999);

    if (now > cutoffDate) {
        const diffMs = now - cutoffDate;
        const delayHours = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60)));
        return {
            isDelayed: true,
            delayHours,
            delayText: `${formatDelayTime(delayHours)} overdue`
        };
    }

    return { isDelayed: false, delayHours: 0, delayText: null };
}

/**
 * Calculate Dispatch Delay (Hub Delay) metrics
 */
function calculateDispatchDelay(shipment, now = new Date()) {
    if (!shipment) return { isDelayed: false, delayHours: 0, delayText: null };

    // Post-dispatch statuses where hub delay no longer applies
    const postDispatchStatuses = [
        'Shipment Dispatched',
        'In Transit',
        'Out for Delivery',
        'Delivered',
        'Cancelled'
    ];

    if (postDispatchStatuses.includes(shipment.status)) {
        return { isDelayed: false, delayHours: 0, delayText: null };
    }

    // Find arrival at hub timestamp
    let hubArrivalTimestamp = null;

    if (shipment.status === 'Shipment Received at Our Hub') {
        // Look in tracking history
        const hubEvent = shipment.trackingHistory?.find(e => 
            e.status === 'Shipment Received at Our Hub' || 
            (e.description && e.description.toLowerCase().includes('received at our hub'))
        );
        hubArrivalTimestamp = hubEvent?.timestamp || shipment.updatedAt || shipment.createdAt;
    } else {
        const hubEvent = shipment.trackingHistory?.find(e => 
            e.status === 'Shipment Received at Our Hub' || 
            (e.description && e.description.toLowerCase().includes('received at our hub'))
        );
        if (hubEvent) {
            hubArrivalTimestamp = hubEvent.timestamp;
        }
    }

    if (!hubArrivalTimestamp) {
        return { isDelayed: false, delayHours: 0, delayText: null };
    }

    const hubDate = new Date(hubArrivalTimestamp);
    const diffMs = now - hubDate;
    const hoursAtHub = Math.floor(diffMs / (1000 * 60 * 60));

    // Threshold: > 24 hours (1 day) at hub without dispatch
    if (hoursAtHub > 24) {
        const delayHours = hoursAtHub - 24;
        return {
            isDelayed: true,
            delayHours,
            totalHubHours: hoursAtHub,
            delayText: `${formatDelayTime(hoursAtHub)} at Hub`
        };
    }

    return { isDelayed: false, delayHours: 0, delayText: null };
}

/**
 * Extract numeric ETA days from serviceDetails.eta string (e.g. "4-5 Days", "3 Days")
 */
function parseEtaDays(etaStr) {
    if (!etaStr) return 5; // Default SLA: 5 days
    const match = String(etaStr).match(/(\d+)/g);
    if (match && match.length > 0) {
        // Return maximum number found in range (e.g., "4-5 Days" -> 5)
        return Math.max(...match.map(Number));
    }
    return 5;
}

/**
 * Calculate Delivery Delay metrics
 */
function calculateDeliveryDelay(shipment, now = new Date()) {
    if (!shipment) return { isDelayed: false, delayDays: 0, delayText: null };

    if (shipment.status === 'Delivered' || shipment.status === 'Cancelled') {
        return { isDelayed: false, delayDays: 0, delayText: null };
    }

    // Determine start of transit date (dispatched date or booking date)
    const dispatchedEvent = shipment.trackingHistory?.find(e => 
        e.status === 'Shipment Dispatched' || e.status === 'In Transit'
    );
    const startDateRaw = dispatchedEvent?.timestamp || shipment.createdAt;
    if (!startDateRaw) return { isDelayed: false, delayDays: 0, delayText: null };

    const startDate = new Date(startDateRaw);
    const baseEtaDays = parseEtaDays(shipment.serviceDetails?.eta);
    // Add 2 grace days as specified in requirement
    const allowedDays = baseEtaDays + 2;

    const expectedDeliveryDate = new Date(startDate);
    expectedDeliveryDate.setDate(expectedDeliveryDate.getDate() + allowedDays);
    expectedDeliveryDate.setHours(23, 59, 59, 999);

    if (now > expectedDeliveryDate) {
        const diffMs = now - expectedDeliveryDate;
        const delayDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        return {
            isDelayed: true,
            delayDays,
            expectedDeliveryDate,
            delayText: `${delayDays}d past SLA`
        };
    }

    return { isDelayed: false, delayDays: 0, delayText: null };
}

/**
 * Combined evaluator for a shipment
 */
function evaluateShipmentDelays(shipment, now = new Date()) {
    const pickupDelay = calculatePickupDelay(shipment, now);
    const dispatchDelay = calculateDispatchDelay(shipment, now);
    const deliveryDelay = calculateDeliveryDelay(shipment, now);

    let delayType = null;
    let primaryText = null;

    if (pickupDelay.isDelayed) {
        delayType = 'pickup_delay';
        primaryText = `Pickup: ${pickupDelay.delayText}`;
    } else if (dispatchDelay.isDelayed) {
        delayType = 'dispatch_delay';
        primaryText = `Hub: ${dispatchDelay.delayText}`;
    } else if (deliveryDelay.isDelayed) {
        delayType = 'delivery_delay';
        primaryText = `Delivery: ${deliveryDelay.delayText}`;
    }

    return {
        isDelayed: pickupDelay.isDelayed || dispatchDelay.isDelayed || deliveryDelay.isDelayed,
        delayType,
        primaryText,
        pickupDelay,
        dispatchDelay,
        deliveryDelay
    };
}

module.exports = {
    calculatePickupDelay,
    calculateDispatchDelay,
    calculateDeliveryDelay,
    evaluateShipmentDelays,
    formatDelayTime
};
