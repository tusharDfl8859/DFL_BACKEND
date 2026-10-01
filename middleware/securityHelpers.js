const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const extractBearerToken = (req) => {
    if (!req) return null;
    const header = req.headers?.authorization;
    if (header && header.startsWith('Bearer ')) {
        const token = header.split(' ')[1];
        if (token) return token;
    }

    if (req.headers && req.headers['x-auth-token']) {
        return req.headers['x-auth-token'];
    }

    if (req.query && req.query.token) {
        return req.query.token;
    }

    if (req.cookies && (req.cookies.token || req.cookies.jwt)) {
        return req.cookies.token || req.cookies.jwt;
    }

    return null;
};

const verifyJwtToken = (token) => {
    return jwt.verify(token, process.env.JWT_SECRET);
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const verifyResourceOwnership = (resource, authenticatedCustomerId, ownershipField = 'customerID') => {
    if (!resource || !authenticatedCustomerId) {
        return false;
    }

    return String(resource[ownershipField]) === String(authenticatedCustomerId);
};

const sanitizeTrackingResponse = (shipment) => {
    if (!shipment) {
        return null;
    }

    const object = shipment.toObject ? shipment.toObject() : shipment;
    const trackingHistory = Array.isArray(object.trackingHistory)
        ? object.trackingHistory.map((event) => ({
            status: event.status,
            location: event.location,
            date: event.timestamp || event.date || null
        }))
        : [];

    const shipperDetails = object.shipperDetails || {};
    const consigneeDetails = object.consigneeDetails || {};
    const shipmentDetails = object.shipmentDetails || {};
    const serviceDetails = object.serviceDetails || {};
    const invoice = object.invoice || {};
    const boxes = Array.isArray(shipmentDetails.boxes) ? shipmentDetails.boxes : [];

    return {
        _id: object._id,
        shipmentId: object.shipmentId || null,
        trackingNumber: object.trackingId || object.shipmentId || null,
        status: object.status || null,
        holdReason: object.holdReason || null,
        lastMileAWB: object.lastMileAWB || object.carrierBookingId || null,
        currentLocation: trackingHistory[0]?.location || object.currentLocation || null,
        expectedDeliveryDate: object.expectedDeliveryDate || object.estimatedDeliveryDate || null,
        shipperDetails: {
            shipperName: maskName(shipperDetails.shipperName),
            companyName: shipperDetails.companyName || '',
            mobileNo: maskPhone(shipperDetails.mobileNo),
            email: maskEmail(shipperDetails.email),
            location: shipperDetails.location || '',
            addressLine1: shipperDetails.addressLine1 || '',
            addressLine2: shipperDetails.addressLine2 || '',
            city: shipperDetails.city || '',
            state: shipperDetails.state || '',
            country: shipperDetails.country || '',
            countryCode: shipperDetails.countryCode || '',
            pincode: shipperDetails.pincode || '',
            alternateName: maskName(shipperDetails.alternateName),
            alternateMobile: maskPhone(shipperDetails.alternateMobile),
            shipperType: shipperDetails.shipperType || '',
            shipperIdType: shipperDetails.shipperIdType || '',
            shipperIdNo: shipperDetails.shipperIdNo ? `${String(shipperDetails.shipperIdNo).slice(0, 2)}***` : ''
        },
        consigneeDetails: {
            consigneeName: maskName(consigneeDetails.consigneeName),
            companyName: consigneeDetails.companyName || '',
            mobileNo: maskPhone(consigneeDetails.mobileNo),
            email: maskEmail(consigneeDetails.email),
            location: consigneeDetails.location || '',
            addressLine1: consigneeDetails.addressLine1 || '',
            addressLine2: consigneeDetails.addressLine2 || '',
            city: consigneeDetails.city || '',
            state: consigneeDetails.state || '',
            country: consigneeDetails.country || '',
            countryCode: consigneeDetails.countryCode || '',
            pincode: consigneeDetails.pincode || '',
            alternateName: maskName(consigneeDetails.alternateName),
            alternateMobile: maskPhone(consigneeDetails.alternateMobile)
        },
        shipmentDetails: {
            shipmentType: shipmentDetails.shipmentType || '',
            shipmentCategory: shipmentDetails.shipmentCategory || '',
            shipmentMode: shipmentDetails.shipmentMode || '',
            preferredUnit: shipmentDetails.preferredUnit || '',
            noOfBoxes: shipmentDetails.noOfBoxes || '',
            totalWeight: shipmentDetails.totalWeight || shipmentDetails.chargeableWeight || '',
            currency: shipmentDetails.currency || '',
            referenceNumber: shipmentDetails.referenceNumber || '',
            invoiceNumber: shipmentDetails.invoiceNumber || '',
            invoiceDate: shipmentDetails.invoiceDate || null,
            totalItemValue: shipmentDetails.totalItemValue || '',
            totalTaxableValue: shipmentDetails.totalTaxableValue || '',
            totalIgstPaid: shipmentDetails.totalIgstPaid || '',
            totalCessPaid: shipmentDetails.totalCessPaid || '',
            boxes: boxes.map((box) => ({
                length: box.length || '',
                width: box.width || '',
                height: box.height || '',
                weight: box.weight || '',
                hsnCode: box.hsnCode || '',
                productDescription: box.productDescription || '',
                productUnitValue: box.productUnitValue || '',
                items: Array.isArray(box.items) ? box.items.map((item) => ({
                    productName: item.productName || '',
                    hsnCode: item.hsnCode || '',
                    quantity: item.quantity || '',
                    unitPrice: item.unitPrice || '',
                    igst: item.igst || ''
                })) : []
            })),
            gstPaymentType: shipmentDetails.gstPaymentType || ''
        },
        serviceDetails: {
            serviceName: serviceDetails.serviceName || '',
            serviceCode: serviceDetails.serviceCode || '',
            carrierName: serviceDetails.carrierName || '',
            price: serviceDetails.price || '',
            eta: serviceDetails.eta || null,
            chargeableWeight: serviceDetails.chargeableWeight || '',
            currency: serviceDetails.currency || ''
        },
        invoice: {
            status: invoice.status || 'Draft',
            invoiceId: invoice.invoiceId || null,
            invoiceDate: invoice.invoiceDate || null,
            totalAmount: invoice.totalAmount || 0,
            pdfUrl: null
        },
        trackingHistory
    };
};

const maskName = (name) => {
    if (!name) return '';
    const parts = String(name).split(/\s+/).filter(Boolean);
    return parts.map((part) => `${part[0]}${'*'.repeat(Math.max(0, part.length - 1))}`).join(' ');
};

const maskPhone = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 4) return digits;
    return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
};

const maskEmail = (email) => {
    const value = String(email || '');
    const [local, domain] = value.split('@');
    if (!domain) return value;
    const visible = Math.max(1, Math.min(2, local.length));
    return `${local.slice(0, visible)}***@${domain}`;
};

const sanitizeErrorMessage = (error) => {
    if (!error) return 'Unexpected error';
    return process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : (error.message || 'Unexpected error');
};

module.exports = {
    extractBearerToken,
    verifyJwtToken,
    isValidObjectId,
    verifyResourceOwnership,
    sanitizeTrackingResponse,
    maskName,
    maskPhone,
    maskEmail,
    sanitizeErrorMessage
};
