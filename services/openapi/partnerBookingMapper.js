const mapLivePartnerBookingResponse = (shipment, reservation, outbox, cancellation) => {
    return {
        bookingId: shipment.partnerApiBookingId,
        shipmentId: shipment.shipmentId,
        partnerRequestId: shipment.partnerRequestId,
        environment: shipment.environment || 'LIVE',
        status: shipment.processingStatus || 'PROCESSING',
        shipmentStatus: shipment.status,
        carrierBookingStatus: shipment.carrierBookingStatus,
        walletReservation: reservation ? {
            status: reservation.status,
            amount: reservation.amount,
            currency: reservation.currency,
            expiresAt: reservation.expiresAt
        } : null,
        outbox: outbox ? {
            status: outbox.status,
            queueJobId: outbox.queueJobId || null,
            attempts: outbox.attempts
        } : null,
        cancellation: cancellation ? {
            cancellationId: cancellation.cancellationId,
            status: cancellation.status,
            requestedAt: cancellation.requestedAt,
            completedAt: cancellation.completedAt
        } : null,
        payment: {
            status: cancellation?.refundStatus || shipment.refundStatus || shipment.walletSettlementStatus || null,
            refundedAt: cancellation?.refundedAt || shipment.refundedAt || null,
            currency: reservation?.currency || shipment.pricingSnapshot?.currency || 'INR'
        },
        pricing: shipment.pricingSnapshot ? {
            calculatedAmount: shipment.pricingSnapshot.calculatedAmount,
            currency: shipment.pricingSnapshot.currency,
            chargeableWeight: shipment.pricingSnapshot.chargeableWeight,
            calculatedAt: shipment.pricingSnapshot.calculatedAt
        } : null,
        recipient: {
            name: shipment.consigneeDetails?.consigneeName,
            phone: shipment.consigneeDetails?.mobileNo,
            email: shipment.consigneeDetails?.email,
            addressLine1: shipment.consigneeDetails?.addressLine1,
            addressLine2: shipment.consigneeDetails?.addressLine2,
            city: shipment.consigneeDetails?.city,
            state: shipment.consigneeDetails?.state,
            countryCode: shipment.consigneeDetails?.countryCode,
            postalCode: shipment.consigneeDetails?.pincode
        },
        package: {
            weightKg: shipment.shipmentDetails?.boxes?.[0]?.weight || shipment.packageDetails?.weightKg || null,
            lengthCm: shipment.shipmentDetails?.boxes?.[0]?.length || shipment.packageDetails?.lengthCm || null,
            widthCm: shipment.shipmentDetails?.boxes?.[0]?.width || shipment.packageDetails?.widthCm || null,
            heightCm: shipment.shipmentDetails?.boxes?.[0]?.height || shipment.packageDetails?.heightCm || null,
            declaredValue: shipment.shipmentDetails?.totalItemValue || null,
            currency: shipment.shipmentDetails?.currency || 'INR'
        },
        service: {
            serviceName: shipment.serviceDetails?.serviceName,
            serviceCode: shipment.serviceDetails?.serviceCode
        },
        trackingNumber: shipment.trackingId || null,
        timeline: Array.isArray(shipment.trackingHistory) ? shipment.trackingHistory.map(evt => ({
            status: evt.status,
            location: evt.location || 'Gateway',
            timestamp: evt.timestamp,
            description: evt.description
        })) : [],
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt
    };
};

const mapSandboxPartnerBookingResponse = (sb) => {
    return {
        bookingId: sb.sandboxBookingId,
        shipmentId: null,
        partnerRequestId: sb.partnerRequestId,
        environment: 'SANDBOX',
        status: sb.status || 'PROCESSING',
        shipmentStatus: sb.status,
        carrierBookingStatus: sb.status === 'CANCELLED' ? 'SKIPPED_CANCELLED' : 'BOOKED',
        walletReservation: {
            status: sb.status === 'CANCELLED' ? 'RELEASED' : 'SETTLED',
            amount: sb.simulatedCharge?.amount || 0,
            currency: sb.simulatedCharge?.currency || 'INR',
            expiresAt: sb.createdAt
        },
        outbox: null,
        cancellation: sb.status === 'CANCELLED' ? {
            cancellationId: `PCAN-SB-${sb.sandboxBookingId}`,
            status: 'CANCELLED',
            requestedAt: sb.updatedAt,
            completedAt: sb.updatedAt
        } : null,
        payment: {
            status: sb.status === 'CANCELLED' ? 'RESERVATION_RELEASED' : 'SETTLED',
            refundedAt: sb.status === 'CANCELLED' ? sb.updatedAt : null,
            currency: sb.simulatedCharge?.currency || 'INR'
        },
        pricing: sb.simulatedCharge ? {
            calculatedAmount: sb.simulatedCharge.amount,
            currency: sb.simulatedCharge.currency,
            chargeableWeight: sb.package?.weightKg || 0,
            calculatedAt: sb.createdAt
        } : null,
        recipient: {
            name: sb.recipient?.name,
            phone: sb.recipient?.phone,
            email: sb.recipient?.email,
            addressLine1: sb.recipient?.addressLine1,
            addressLine2: sb.recipient?.addressLine2,
            city: sb.recipient?.city,
            state: sb.recipient?.state,
            countryCode: sb.recipient?.countryCode,
            postalCode: sb.recipient?.postalCode
        },
        package: {
            weightKg: sb.package?.weightKg || null,
            lengthCm: sb.package?.lengthCm || null,
            widthCm: sb.package?.widthCm || null,
            heightCm: sb.package?.heightCm || null,
            declaredValue: sb.package?.declaredValue || null,
            currency: sb.package?.currency || 'INR'
        },
        service: {
            serviceName: 'DFL Sandbox Simulator',
            serviceCode: 'DFL_SANDBOX'
        },
        trackingNumber: sb.trackingNumber || null,
        timeline: Array.isArray(sb.tracking?.events) ? sb.tracking.events.map(evt => ({
            status: evt.status,
            location: evt.location || 'Sandbox Facility',
            timestamp: evt.timestamp,
            description: evt.description
        })) : [],
        createdAt: sb.createdAt,
        updatedAt: sb.updatedAt
    };
};

const mapPartnerBookingListItem = (item, environment) => {
    if (String(environment).toUpperCase() === 'LIVE') {
        return {
            bookingId: item.partnerApiBookingId,
            partnerRequestId: item.partnerRequestId,
            trackingNumber: item.trackingId || null,
            serviceName: item.serviceDetails?.serviceName,
            serviceCode: item.serviceDetails?.serviceCode,
            recipientCountry: item.recipient?.countryCode || item.consigneeDetails?.countryCode,
            processingStatus: item.processingStatus || 'PROCESSING',
            cancellationStatus: item.cancellationStatus || null,
            paymentStatus: item.refundStatus || item.walletSettlementStatus || 'RESERVED',
            amount: item.price?.chargedAmount || item.pricingSnapshot?.calculatedAmount || null,
            currency: item.price?.currency || item.pricingSnapshot?.currency || 'INR',
            createdAt: item.createdAt,
            environment: 'LIVE'
        };
    } else {
        return {
            bookingId: item.sandboxBookingId,
            partnerRequestId: item.partnerRequestId,
            trackingNumber: item.trackingNumber || null,
            serviceName: 'DFL Sandbox Simulator',
            serviceCode: 'DFL_SANDBOX',
            recipientCountry: item.recipient?.countryCode,
            processingStatus: item.status || 'PROCESSING',
            cancellationStatus: item.status === 'CANCELLED' ? 'CANCELLED' : null,
            paymentStatus: item.status === 'CANCELLED' ? 'RESERVATION_RELEASED' : 'SETTLED',
            amount: item.simulatedCharge?.amount || null,
            currency: item.simulatedCharge?.currency || 'INR',
            createdAt: item.createdAt,
            environment: 'SANDBOX'
        };
    }
};

module.exports = {
    mapLivePartnerBookingResponse,
    mapSandboxPartnerBookingResponse,
    mapPartnerBookingListItem
};
