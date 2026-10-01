/**
 * Maps raw CSV row data and calculated pricing into a structured Shipment object.
 * Standardizes carrier naming, address formatting, and invoice itemization.
 * 
 * @param {Object} row - The CSV data row
 * @param {Object} targetUser - The user document (shipper)
 * @param {Object} bulkUpload - The bulk upload metadata (context)
 * @param {Object} pricingResult - Results from bulkPricingCalculator
 * @returns {Object} - Shipment data object ready for Mongoose creation
*/
const { randomInt } = require('crypto');
const { normalizeShipmentServiceDetails } = require('./shipmentServiceDetails');

const mapRowToShipment = (row, targetUser, bulkUpload, pricingResult) => {
    const { finalPrice, matchedRate, chargeableWeight, breakdown, resolvedProvider, matchedServiceConfig } = pricingResult;
    let provider = resolvedProvider || matchedRate?.provider || 'Speedbox';
    if (provider.toUpperCase() === 'SKYNET' && (row.service || '').toLowerCase().includes('ecommerce')) {
        provider = 'SKYNET-ECOMMERCE';
    }

    const rowCsb5Status = String(row.csb5_status || '').trim();
    const resolvedCategory = (rowCsb5Status === '1' || rowCsb5Status.toLowerCase() === 'true') ? 'csb5' : 'csb4';

    // Carrier name standardization for tracking visibility
    const carrierTrackingMap = {
        'Skynet': 'Skynet',
        'SKYNET': 'Skynet',
        'TPL': 'TPL',
        'UNITED': 'United Courier',
        'United Courier': 'United Courier',
        'SKYNET-ECOMMERCE': 'Skynet Ecommerce',
        'UK-ECONOMY': 'RSA',
        'UK-PRIORITY': 'RSA',
        'RSAXB': 'RSA',
        'RSA': 'RSA'
    };

    const trackingCarrier = carrierTrackingMap[provider] || provider;
    const carrierName = trackingCarrier;
    const shipmentId = `DFL${randomInt(10000000, 99999999)}`;

    const billing = targetUser.kycData?.billingAddress || {};

    // [NEW] Condition 1 & 2: Shipper Address Picking Logic
    // Prioritize sheet-provided address, fallback to User Address Book (KYC)
    const sheetShipperAddress = (row['pick Up Address /shipper address'] || '').toString().trim();
        // Normalize invoice date
let invoiceDate = row.invoice_date;

const monthMap = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
};

const parseInvoiceDate = (value) => {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }

    // Already a valid Date object
    if (value instanceof Date) {
        return !isNaN(value.getTime()) ? value : null;
    }

    // Excel serial number
    if (typeof value === 'number' && value > 30000) {
        const parsedDate = new Date(
            Math.round((value - 25569) * 86400 * 1000)
        );

        return !isNaN(parsedDate.getTime()) ? parsedDate : null;
    }

    const dateStr = String(value).trim();

    // Supports:
    // DD-MM-YYYY
    // DD/MM/YYYY
    // DD-Month-YYYY
    // DD/Month/YYYY
    // DD Month YYYY
    // DD-Mon-YYYY
    // DD/Mon/YYYY
    // DD Mon YYYY
    const match = dateStr.match(
        /^(\d{1,2})[-/\s]+([A-Za-z]+|\d{1,2})[-/\s]+(\d{4})$/
    );

    if (!match) {
        return null;
    }

    const day = parseInt(match[1], 10);
    const monthValue = match[2];
    const year = parseInt(match[3], 10);

    let month;

    if (/^\d{1,2}$/.test(monthValue)) {
        month = parseInt(monthValue, 10) - 1;
    } else {
        month = monthMap[monthValue.toLowerCase()];
    }

    if (
        !Number.isInteger(day) ||
        !Number.isInteger(year) ||
        month === undefined ||
        month < 0 ||
        month > 11
    ) {
        return null;
    }

    const parsedDate = new Date(year, month, day);

    // Prevent JavaScript from silently converting invalid dates
    // e.g. 31-February-2026 -> March
    if (
        parsedDate.getFullYear() !== year ||
        parsedDate.getMonth() !== month ||
        parsedDate.getDate() !== day
    ) {
        return null;
    }

    return parsedDate;
};

invoiceDate = parseInvoiceDate(invoiceDate);

if (!invoiceDate) {
    throw new Error(`Invalid invoice_date: ${row.invoice_date}`);
}

    const isRSAPovider = provider === 'UK-ECONOMY' || provider === 'UK-PRIORITY' || provider === 'RSA' || provider === 'RSAXB';
    const resolvedInternalCode = matchedRate.zoneCode || (matchedServiceConfig && matchedServiceConfig.code) || row.service_code;
    const resolvedZone = (matchedServiceConfig && (matchedServiceConfig.zone || matchedServiceConfig.zoneMatch))
        || matchedRate.zone
        || matchedRate.zoneCode
        || row.service_code;
    const normalizedServiceDetails = normalizeShipmentServiceDetails({
        serviceName: matchedRate.serviceName || (matchedServiceConfig && matchedServiceConfig.displayName) || row.service,
        serviceCode: isRSAPovider ? '' : (matchedRate.serviceCode || (matchedServiceConfig && matchedServiceConfig.serviceCode) || row.service_code || ''),
        code: resolvedInternalCode,
        zone: resolvedZone,
        carrierName,
        price: finalPrice.toString(),
        chargeableWeight: chargeableWeight.toString(),
        eta: `${String(matchedRate.transitTime || (matchedServiceConfig && matchedServiceConfig.transitTime) || "5-7 Working Days").replace(/ Working Days| Business Days/gi, '').trim()} Business Days`,
        provider,
        cost: (breakdown && breakdown.baseRate) || 0,
        markup: (breakdown && breakdown.markup) || 0,
        handling: (breakdown && breakdown.handlingCharge) || 0,
        countrySurcharge: (breakdown && breakdown.countrySurcharge) || 0,
        fuelSurcharge: (breakdown && breakdown.fuelSurcharge) || 0,
        carrierCode: (matchedRate && matchedRate.carrierCode) || (matchedServiceConfig && matchedServiceConfig.carrierCode) || 1,
        igstTaxPercentage: ((breakdown && breakdown.taxRate) || (matchedRate && matchedRate.igstTaxPercentage) || "18").toString()
    }, {
        provider,
        carrierName,
        code: resolvedInternalCode,
        zone: resolvedZone,
        carrierCode: (matchedRate && matchedRate.carrierCode) || (matchedServiceConfig && matchedServiceConfig.carrierCode) || 1
    });

    return {
        user: targetUser._id,
        shipperDetails: {
            shipperName: targetUser.name || 'DFL Customer',
            companyName: targetUser.companyName || '',
            email: targetUser.email,
            mobileNo: targetUser.phone || row.consignee_shipping_mobile || '9999999999',

            // Exclusive Choice Logic:
            // 1. If user provided ANY address info in sheet, use sheet ONLY (Clean display)
            // 2. Otherwise, use full KYC Billing Address (Fallback)
            addressLine1: sheetShipperAddress || (sheetShipperAddress ? '' : billing.addressLine1) || 'As per Profile',
            addressLine2: sheetShipperAddress ? '' : (billing.addressLine2 || ''),
            city: row['shipper_city'] || (sheetShipperAddress ? '.' : billing.city) || 'City',
            state: row['shipper_state'] || (sheetShipperAddress ? '.' : billing.state) || '',
            country: 'India',
            countryCode: 'IN',
            pincode: row['shipper_pincode'] || (sheetShipperAddress ? '.' : billing.pincode) || '000000',
            pickupType: 'Pickup',
            date: new Date()
        },
        consigneeDetails: {
            consigneeName: `${row.consignee_shipping_firstname} ${row.consignee_shipping_lastname}`.trim() || 'Consignee',
            email: row.consignee_shipping_email,
            mobileNo: row.consignee_shipping_mobile || '9999999999',
            addressLine1: row.consignee_shipping_address || 'Address',
            addressLine2: row.consignee_shipping_address_2 || '',
            city: row.consignee_shipping_city,
            state: row.consignee_shipping_state || '',
            country: row.consignee_shipping_country_code || 'US',
            countryCode: row.consignee_shipping_country_code || 'US',
            pincode: row.consignee_shipping_postcode || '000000'
        },
        shipmentDetails: {
            shipmentCategory: resolvedCategory,
            gstinType: resolvedCategory === 'csb5' ? 'GSTIN (Normal)' : undefined,
            gstinId: resolvedCategory === 'csb5' ? (targetUser.kycData?.gstNumber || '') : undefined,
            bondOrUt: resolvedCategory === 'csb5' ? (targetUser.kycData?.gstPaymentType === 'lut' ? 'LUT/Bond' : 'IGST') : undefined,
            iecNumber: resolvedCategory === 'csb5' ? (targetUser.kycData?.iecNumber || '') : undefined,
            adCode: resolvedCategory === 'csb5' ? (targetUser.kycData?.adCode || '') : undefined,
            bankName: resolvedCategory === 'csb5' ? (targetUser.kycData?.bankName || '') : undefined,
            ifscCode: resolvedCategory === 'csb5' ? (targetUser.kycData?.ifscCode || '') : undefined,
            accountNo: resolvedCategory === 'csb5' ? (targetUser.kycData?.bankAccountNumber || '') : undefined,
            nfetFlag: resolvedCategory === 'csb5' ? 'Y' : undefined,
            govNonGovType: resolvedCategory === 'csb5' ? 'P' : undefined,
            packageWeight: row.package_weight,
            noOfBoxes: "1",
            currency: (() => {
                let userCurr = (row.currency_code || row.currency || row.invoice_currency || '').toString().trim().toUpperCase();
                if (userCurr) return userCurr;
                return 'INR'; // Default to INR if empty
            })(),
            dimensions: {
                length: row.package_length || 10,
                breadth: row.package_breadth || row.package_width || 10,
                height: row.package_height || 10
            },
            boxes: [{
                length: row.package_length || 10,
                width: row.package_breadth || row.package_width || 10,
                height: row.package_height || 10,
                weight: row.package_weight,
                items: [{
                    productName: row.vendor_order_item_name,
                    quantity: row.vendor_order_item_quantity,
                    unitPrice: row.vendor_order_item_unit_price,
                    hsnCode: row.vendor_order_item_hsn
                }]
            }],

            invoiceNumber: row.invoice_no,
            referenceNumber: row.order_reference,
            invoiceDate: invoiceDate
        },
        serviceDetails: normalizedServiceDetails,
        invoice: {
            invoiceId: `INV-${shipmentId.slice(3)}`,
            invoiceDate: new Date(),
            currency: 'INR',
            billedTo: {
                name: targetUser.name || '',
                companyName: targetUser.companyName || '',
                address: billing.addressLine1 || '',
                city: billing.city || '',
                state: billing.state || '',
                country: billing.country || 'India',
                pincode: billing.pincode || '',
                phone: targetUser.phone || '',
                email: targetUser.email || '',
                gstin: targetUser.kycData?.gstNumber || ''
            },
            lineItems: [
                { description: 'Shipping & Handling Charges', amount: Math.round((breakdown.baseRate + breakdown.markup + breakdown.handlingCharge) * 100) / 100 },
                { description: 'Country Surcharge', amount: Math.round(breakdown.countrySurcharge * 100) / 100 }
            ],
            tax: {
                type: 'IGST',
                rate: 18,
                amount: Math.round(breakdown.gst * 100) / 100
            },
            subtotal: Math.round((breakdown.baseRate + breakdown.markup + breakdown.handlingCharge + breakdown.countrySurcharge) * 100) / 100,
            totalAmount: finalPrice,
            status: 'Draft'
        },
        bulkUploadId: bulkUpload._id,
        bulkOrderId: bulkUpload.bulkOrderId,
        shipmentId: shipmentId,
        trackingCarrier: trackingCarrier,
        status: (provider === 'UK-ECONOMY' || provider === 'UK-PRIORITY') ? 'Processing' : 'Pending',
        trackingHistory: [{
            status: (provider === 'UK-ECONOMY' || provider === 'UK-PRIORITY') ? 'Processing' : 'Pending',
            location: targetUser.city || 'Origin',
            description: `Bulk Shipment Created via ${bulkUpload.bulkOrderId}`,
            timestamp: new Date()
        }]
    };
};

module.exports = { mapRowToShipment };
