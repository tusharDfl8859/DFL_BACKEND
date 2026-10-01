const BulkUpload = require('../models/BulkUpload');
const XLSX = require('xlsx');

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sendEmail = require('../utils/emailService');

const User = require('../models/User');
const Shipment = require('../models/Shipment');
const bulkBookingQueue = require('../queues/bulkBookingQueue');
const serviceConfig = require('../config/service_config.json');
const { calculateRowPrice } = require('../utils/bulkPricingCalculator');

// Configure Multer Storage (Memory)
const storage = multer.memoryStorage();

// File Filter (CSV/Excel only)
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'text/csv' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only CSV and Excel files are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: fileFilter
});

// Official DFL service names for strict validation
const ALLOWED_DFL_SERVICES = [
    "DFL EXPRESS - Standard",
    "DFL EXPRESS - Economy",
    "DFL EXPRESS - Priority",
    "DFL EXPRESS - Swift",
    "DFL EXPRESS - Ecommerce",
    "DFL EXPRESS - FBA",
    "DFL EXPRESS - Standard Heavy",
    "DFL EXPRESS - USPS",
    "DFL EXPRESS - Priority Plus",
    "DFL EXPRESS - Economy Ground",
    "DFL EXPRESS - Economy Saver",
    "DFL EXPRESS - Standard Express",
    "DFL EXPRESS UK Standard",
    "DFL EXPRESS UK Priority"
];

let requiredFields = [
    'invoice_no', 'invoice_date', 'service', 'service_code', 'package_weight',
    'consignee_shipping_firstname', 'consignee_shipping_lastname',
    'consignee_shipping_mobile', 'consignee_shipping_email',
    'consignee_shipping_address', 'consignee_shipping_city',
    'consignee_shipping_postcode', 'consignee_shipping_country_code',
    'consignee_shipping_state', 'vendor_order_item_name',
    'vendor_order_item_quantity', 'vendor_order_item_unit_price',
    'vendor_order_item_hsn'
];

const rsaRequiredFields = [
    'invoice_no', 'invoice_date', 'order_reference', 'service', 'package_weight',
    'package_length', 'package_breadth', 'package_height', 'currency_code',
    'csb5_status', 'pick Up Address /shipper address', 'shipper_city',
    'shipper_state', 'shipper_pincode', 'consignee_shipping_firstname',
    'consignee_shipping_lastname', 'consignee_shipping_mobile',
    'consignee_shipping_email', 'consignee_shipping_address',
    'consignee_shipping_address_2', 'consignee_shipping_city',
    'consignee_shipping_postcode', 'consignee_shipping_country_code',
    'consignee_shipping_state', 'vendor_order_item_name',
    'vendor_order_item_quantity', 'vendor_order_item_unit_price',
    'vendor_order_item_hsn', 'vendor_order_item_tax_rate',
    'csbv5_limit_comfirmation'
];

const getRequiredFields = (bulkType) => {
    if (bulkType === 'RSA') {
        return rsaRequiredFields;
    }
    return requiredFields;
};

const MAX_BULK_ORDERS = 100;

const validateOrderLimit = (count) => {
    if (count > MAX_BULK_ORDERS) {
        return {
            success: false,
            message: `Maximum ${MAX_BULK_ORDERS} orders allowed per upload.`
        };
    }
    return null;
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ======================================================
// SHARED ROW VALIDATOR
// Used by BOTH uploadBulkOrder (main flow) and preCheckBulkUpload
// (insufficient-balance / resume flow) so validation is never skipped.
// Mutates `row` in place: sets row.validationError if anything fails,
// and pushes human-readable messages into groupedErrors for the API response.
// Returns nothing — check row.validationError after calling.
// ======================================================
const validateBulkRow = (row, rowIndex, groupedErrors, shipperCountryCode, shipperCountryRaw, reqFields = requiredFields, bulkType = 'DFL') => {
    const addRowError = (msg) => {
        groupedErrors.dataErrors.push(`Row ${rowIndex}: ${msg}`);
        row.validationError = row.validationError
            ? `${row.validationError}; ${msg}`
            : msg;
    };

    const addServiceError = (msg) => {
        groupedErrors.serviceErrors.push(`Row ${rowIndex}: ${msg}`);
        row.validationError = row.validationError
            ? `${row.validationError}; ${msg}`
            : msg;
    };

    // Cross-Country Validation: Consignee and Shipper must not be in the same country
    const destCountryRaw = (row.consignee_shipping_country_code || row.consignee_shipping_country || '').toString().trim().toUpperCase();
    const destCountryCode = (destCountryRaw === 'INDIA' || destCountryRaw === 'IN') ? 'IN' : destCountryRaw;

    if (destCountryCode === shipperCountryCode) {
        addRowError(`Consignee country (${destCountryRaw}) cannot be the same as Shipper country (${shipperCountryRaw}). Domestic shipments are not supported in bulk upload.`);
    }

    // USA Currency Validation: currency_code must be USD for US-bound shipments
    if (destCountryCode === 'US' || destCountryCode === 'USA') {
        const rowCurrency = (row.currency_code || '').toString().trim().toUpperCase();
        if (rowCurrency !== 'USD') {
            addRowError(`For USA shipments, "currency_code" must be "USD". Provided value: "${row.currency_code || 'empty'}".`);
        }
    }

    // UK Currency Validation: For UK shipments, if GBP, value must be <= 135
    if (destCountryCode === 'GB' || destCountryCode === 'UK' || destCountryCode.includes('UNITED KINGDOM')) {
        const rowCurrency = (row.currency_code || '').toString().trim().toUpperCase();
        const qty = parseFloat(row.vendor_order_item_quantity || 1);
        const unitPrice = parseFloat(row.vendor_order_item_unit_price || 0);
        const totalValue = qty * unitPrice;

        if (rowCurrency === 'GBP' && totalValue > 135) {
            addRowError(`Shipment value (${totalValue} GBP) exceeds the maximum limit of 135 GBP for UK DDP shipments. If your value is actually in INR, please change "currency_code" to "INR".`);
        }
    }

    // Validate Shipper Country from the row if provided in the sheet
    const rowShipperCountry = (row.shipper_country || row.sender_country || '').toString().trim().toUpperCase();
    if (rowShipperCountry && rowShipperCountry !== 'IN' && rowShipperCountry !== 'INDIA') {
        groupedErrors.dataErrors.push(`Row ${rowIndex}: Shipper country must be INDIA. We only support bulk exports from India at this time.`);
    }

    const invoiceNo = row.invoice_no ? row.invoice_no.toString().trim() : '';
    if (!invoiceNo) {
        addRowError(`"invoice_no" is missing. All order rows must have an invoice number.`);
        return;
    }

    const orderRef = row.order_reference ? row.order_reference.toString().trim() : '';
    if (bulkType === 'RSA' && invoiceNo && orderRef && invoiceNo.toLowerCase() === orderRef.toLowerCase()) {
        const errorMsg = `"invoice_no" and "order_reference" cannot have the same value.`;
        row.validationError = row.validationError ? `${row.validationError}; ${errorMsg}` : errorMsg;
    }

    // Check mandatory fields
    reqFields.forEach(field => {
        const val = row[field];
        if (val === undefined || val === null || val.toString().trim() === '') {
            addRowError(`Field "${field}" is required but missing or empty.`);
        }
    });

    // Weight & Early Service Check
    let isSkynetEcom = false;
    const actualWeight = parseFloat(row.package_weight);
    if (row.package_weight && isNaN(actualWeight)) {
        addRowError(`"package_weight" must be a number.`);
    } else if (actualWeight <= 0) {
        addRowError(`"package_weight" must be greater than 0.`);
    } else {
        try {
            const countryCode = (row.consignee_shipping_country_code || row.consignee_shipping_country || 'US').toString().trim().toUpperCase();

            const L = parseFloat(row.package_length) || 10;
            const W = parseFloat(row.package_breadth) || 10;
            const H = parseFloat(row.package_height) || 10;
            const volWeight = (L * W * H) / 5000;
            const chargeableWeight = Math.max(actualWeight, volWeight);

            const rateResult = rateCalculator.getRate({
                weight: chargeableWeight,
                country: countryCode,
                state: row.consignee_shipping_state,
                postcode: row.consignee_shipping_postcode
            });

            const availableRates = rateResult?.rates || [];

            if ((countryCode === 'GB' || countryCode === 'UK') && bulkType === 'RSA') {
                // UK Auto-Detection: Bypass strict service config validation
                if (chargeableWeight > 30) {
                    addServiceError(`Weight ${chargeableWeight.toFixed(2)}kg exceeds the maximum limit (30kg) for UK services.`);
                } else if (row.service || row.service_code) {
                    // If explicitly provided, check if it's a valid UK service
                    const sName = (row.service || '').toString().trim().toLowerCase();
                    const sNameNormalized = sName.replace(/[\s-]/g, '');
                    const isRSAService = sNameNormalized === 'dflexpressstandard' || sNameNormalized === 'dflexpresseconomy' || sNameNormalized === 'dflexpresspriority' || sName.includes('rsa') || bulkType === 'RSA';
                    if (bulkType !== 'RSA' && !isRSAService && !sName.includes('uk priority') && !sName.includes('uk standard') && !sName.includes('uk economy')) {
                        addServiceError(`"${row.service}" is not a valid UK service. Leave blank for auto-assignment or use "DFL EXPRESS UK Standard" / "DFL EXPRESS UK Priority".`);
                    } else if (!isRSAService && (sName.includes('uk priority') || sName.includes('priority')) && chargeableWeight > 3) {
                        addServiceError(`Weight ${chargeableWeight.toFixed(2)}kg exceeds the limit (3kg) for UK Priority.`);
                    }
                }
            } else {
                if (row.service || row.service_code) {
                    const cleanStr = (str) => (str || '').toString().replace(/[\u200B-\u200D\uFEFF\u00A0\r\n]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const originalRowService = (row.service || '').toString().trim();
                    const rowService = cleanStr(originalRowService);
                    const originalRowCode = (row.service_code || '').toString().trim();
                    const rowCode = cleanStr(originalRowCode);
                    const countryRaw = row.consignee_shipping_country_code || row.consignee_shipping_country || 'US';
                    const countryCodeClean = cleanStr(countryRaw);
                    const isUKDestination = countryCodeClean === 'gb' || countryCodeClean === 'uk' || countryCodeClean.includes('united kingdom') || countryCodeClean.includes('gbr');

                    let foundConfig = null;
                    const services = Object.entries(serviceConfig).flatMap(([carrierName, p]) =>
                        (p.services || []).map(svc => ({ ...svc, carrierName }))
                    );
                    foundConfig = services.find(svc => {
                        const nameMatch = bulkType === 'RSA'
                            ? (svc.code && cleanStr(svc.code) === rowService)
                            : (svc.displayName && cleanStr(svc.displayName) === rowService);
                        const isRSAService = bulkType === 'RSA' || (svc.code && svc.code.toUpperCase().includes('RSA')) || (isUKDestination && (rowService.includes('standard') || rowService.includes('priority')));
                        const codeMatch = (isRSAService || rowCode === '') ? true : (svc.serviceCode && cleanStr(svc.serviceCode) === rowCode);
                        return nameMatch && codeMatch;
                    });

                    if (!foundConfig) {
                        addServiceError(`Service and Service Code Mismatch. The service name "${originalRowService}" and code "${originalRowCode}" do not match any active configuration. Please check the Service Directory for valid combinations.`);
                    } else {
                        if (foundConfig.carrierName === 'SKYNET-ECOMMERCE') {
                            isSkynetEcom = true;
                        }
                        const availableService = availableRates.find(r =>
                            r.serviceName.toLowerCase().trim() === foundConfig.displayName.toLowerCase().trim()
                        );

                        if (!availableService) {
                            const availableNames = availableRates.length > 0
                                ? availableRates.slice(0, 3).map(r => `"${r.serviceName}"`).join(', ')
                                : null;

                            try {
                                const sampleRate = rateCalculator.getRate({ weight: 0.5, country: countryCode });
                                const serviceExistsForCountry = sampleRate.rates.some(r =>
                                    r.serviceName.toLowerCase().trim() === foundConfig.displayName.toLowerCase().trim()
                                );

                                if (serviceExistsForCountry) {
                                    let msg = `Weight ${chargeableWeight.toFixed(2)}kg exceeds the limit for "${foundConfig.displayName}" to ${countryCode}.`;
                                    if (availableNames) msg += ` Available services for this weight: ${availableNames}.`;
                                    addServiceError(msg);
                                } else {
                                    let msg = `"${foundConfig.displayName}" is not available for shipping to ${countryCode}.`;
                                    if (availableNames) msg += ` Consider using: ${availableNames}.`;
                                    addServiceError(msg);
                                }
                            } catch (err) {
                                addServiceError(`"${originalRowService}" is not available for this weight/destination.`);
                            }
                        }
                    }
                } else if (availableRates.length === 0) {
                    addServiceError(`No services are available (No "Service Cards" matches) for ${countryCode} at weight ${chargeableWeight.toFixed(2)}kg.`);
                } else {
                    const top3 = availableRates.slice(0, 3).map(r => `"${r.serviceName}"`).join(', ');
                    addServiceError(`Service name is missing. Available options for this weight/country: ${top3}.`);
                }
            }
        } catch (calcErr) {
            addServiceError(`Unable to validate service/weight for row ${rowIndex}. Please check package weight and destination country.`);
        }
    }

    // Names (should not be just numbers)
    ['consignee_shipping_firstname', 'consignee_shipping_lastname'].forEach(nameField => {
        const nameVal = row[nameField] ? row[nameField].toString().trim() : '';
        if (nameVal && /^\d+$/.test(nameVal)) {
            addRowError(`"${nameField.split('_').pop()}" cannot be just numbers.`);
        }
    });

    // Mobile (flexible check allowing formatting & extensions)
    if (row.consignee_shipping_mobile) {
        const mobileStr = row.consignee_shipping_mobile.toString().trim();
        const phoneRegex = /^[+\d\s().xX-]+(?:ext\.?\s*\d+)?$/i;
        if (!phoneRegex.test(mobileStr)) {
            addRowError(`"consignee_shipping_mobile" has an invalid format. Allowed formats: numeric, with dashes (-), spaces, or extensions (e.g., ext. 22355 or x123).`);
        }
    }

    // Country Code (2 letters)
    if (row.consignee_shipping_country_code) {
        const cc = row.consignee_shipping_country_code.toString().trim();
        if (cc.length !== 2) {
            addRowError(`"consignee_shipping_country_code" must be a 2-character ISO code (e.g., US, IN).`);
        }
    }

    // Email
    if (row.consignee_shipping_email && !emailRegex.test(row.consignee_shipping_email)) {
        addRowError(`Invalid email format in "consignee_shipping_email".`);
    }

    // Quantity
    if (row.vendor_order_item_quantity) {
        const qty = parseInt(row.vendor_order_item_quantity);
        if (isNaN(qty)) {
            addRowError(`"vendor_order_item_quantity" must be a valid integer.`);
        } else if (qty <= 0) {
            addRowError(`"vendor_order_item_quantity" must be greater than 0.`);
        }
    }

    // Price
    if (row.vendor_order_item_unit_price) {
        const price = parseFloat(row.vendor_order_item_unit_price);
        if (isNaN(price)) {
            addRowError(`"vendor_order_item_unit_price" must be a number.`);
        } else if (price < 0) {
            addRowError(`"vendor_order_item_unit_price" cannot be negative.`);
        }
    }

    // HSN code (standard 8 digit check)
    if (row.vendor_order_item_hsn) {
        const hsnStr = row.vendor_order_item_hsn.toString().trim();
        if (!/^\d+$/.test(hsnStr)) {
            addRowError(`HSN code must contain only numbers.`);
        } else if (hsnStr.length < 8) {
            addRowError(`HSN code must be at least 8 digits.`);
        }
    }

    // Auto convert HSN to 10 digits for shipments below 1 KG (Only for Skynet Ecommerce shipments)
    const weight = parseFloat(row.package_weight || 0);
    if (row.vendor_order_item_hsn && weight < 1 && isSkynetEcom) {
        row.vendor_order_item_hsn = row.vendor_order_item_hsn
            .toString()
            .trim()
            .padStart(10, '0');
    }
};

// ======================================================
// UPLOAD BULK ORDER
// ======================================================
const uploadBulkOrder = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const shipmentCategory = req.body.shipmentCategory || 'csb4';

        // Parse File
        let data = [];
        let headers = [];
        try {
            const isCSVFile = req.file.originalname.toLowerCase().endsWith('.csv') || req.file.mimetype === 'text/csv';
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: isCSVFile });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];

            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            if (rows.length === 0) {
                return res.status(400).json({ message: 'The uploaded file is empty.' });
            }

            headers = rows[0].map(h => h ? h.toString().trim() : '');

            const rawData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            data = rawData.map(row => {
                const normalizedRow = {};
                Object.keys(row).forEach(key => {
                    const cleanKey = key.toString().trim();
                    normalizedRow[cleanKey] = row[key];
                });
                return normalizedRow;
            });
        } catch (err) {
            return res.status(400).json({ message: 'Failed to parse file. Please ensure it is a valid CSV or Excel file: ' + err.message });
        }

        const groupedErrors = {
            headerErrors: [],
            dataErrors: [],
            serviceErrors: []
        };

        // Header Validation
        const bulkType = req.body.bulkType || (req.body.shipmentCategory === 'RSA' ? 'RSA' : 'DFL');
        const isRSA = bulkType === 'RSA';
        const reqFields = getRequiredFields(isRSA ? 'RSA' : 'DFL');
        const missingHeaders = reqFields.filter(f => !headers.includes(f));
        if (missingHeaders.length > 0) {
            groupedErrors.headerErrors = missingHeaders.map(h => `Missing mandatory column: "${h}"`);
            return res.status(400).json({
                message: 'Invalid file format. Missing required columns.',
                errors: groupedErrors
            });
        }

        // Identify the User
        let user = req.user;
        if (user.isAdmin && req.body.userId) {
            const targetUser = await User.findById(req.body.userId);
            if (targetUser) user = targetUser;
        }

        if (shipmentCategory === 'csb5' && user.accountType !== 'business') {
            return res.status(403).json({
                message: 'CSB-5 bulk upload is only permitted for business accounts. Please upgrade your account to Business to use this feature.'
            });
        }

        const shipperCountryRaw = (user.kycData?.billingAddress?.country || 'IN').toString().trim().toUpperCase();
        const shipperCountryCode = (shipperCountryRaw === 'INDIA' || shipperCountryRaw === 'IN') ? 'IN' : shipperCountryRaw;

        if (shipperCountryCode !== 'IN') {
            return res.status(403).json({
                message: `Bulk upload service is currently restricted to shippers located in India. Your account origin is ${shipperCountryRaw}.`
            });
        }

        // Pre-load rate data
        try {
            await rateCalculator.loadData();
        } catch (loadErr) {
            return res.status(500).json({ message: `Failed to pre-load rate data: ${loadErr.message}` });
        }

        const sanitizedData = [];

        data.forEach((row, index) => {
            const rowIndex = index + 2;

            const invoiceNoRaw = row.invoice_no ? row.invoice_no.toString().trim() : '';
            const isDocRow = invoiceNoRaw === 'Required' ||
                invoiceNoRaw === 'INV-001' ||
                invoiceNoRaw.includes('UNIQUE FOR DIFFERENT ORDERS') ||
                invoiceNoRaw.includes('Valid Values');

            if (isDocRow) return;

            const isRowEmpty = reqFields.every(field => !row[field] || row[field].toString().trim() === '');
            if (isRowEmpty) return;
            validateBulkRow(row, rowIndex, groupedErrors, shipperCountryCode, shipperCountryRaw, reqFields, bulkType);
            sanitizedData.push(row);
        });

        const hasHeaderErrors = groupedErrors.headerErrors.length > 0;

        let duplicateErrorsPresent = false;
        if (bulkType === 'RSA') {
            const seenInvoices = new Set();
            const seenOrderRefs = new Set();

            const sheetInvoices = [];
            const sheetOrderRefs = [];
            sanitizedData.forEach(row => {
                const inv = row.invoice_no ? row.invoice_no.toString().trim() : '';
                const ref = row.order_reference ? row.order_reference.toString().trim() : '';
                if (inv) sheetInvoices.push(inv);
                if (ref) sheetOrderRefs.push(ref);
            });

            const Shipment = require('../models/Shipment');
            const existingShipments = await Shipment.find({
                user: user._id,
                $or: [
                    { 'shipmentDetails.invoiceNumber': { $in: sheetInvoices } },
                    { 'shipmentDetails.referenceNumber': { $in: sheetOrderRefs } }
                ]
            }).lean();

            const dbInvoices = new Set(existingShipments.map(s => s.shipmentDetails?.invoiceNumber).filter(Boolean));
            const dbOrderRefs = new Set(existingShipments.map(s => s.shipmentDetails?.referenceNumber).filter(Boolean));

            sanitizedData.forEach(row => {
                const inv = row.invoice_no ? row.invoice_no.toString().trim() : '';
                const invLower = inv.toLowerCase();
                const ref = row.order_reference ? row.order_reference.toString().trim() : '';
                const refLower = ref.toLowerCase();

                let isDuplicate = false;
                let errorMsg = [];

                if (invLower && seenInvoices.has(invLower)) {
                    isDuplicate = true;
                    errorMsg.push(`Duplicate invoice_no "${row.invoice_no}" found in sheet.`);
                } else if (invLower) {
                    seenInvoices.add(invLower);
                }

                if (refLower && seenOrderRefs.has(refLower)) {
                    isDuplicate = true;
                    errorMsg.push(`Duplicate order_reference "${row.order_reference}" found in sheet.`);
                } else if (refLower) {
                    seenOrderRefs.add(refLower);
                }

                if (inv && dbInvoices.has(inv)) {
                    isDuplicate = true;
                    duplicateErrorsPresent = true;
                    const msg = `this [invoice_no & order_refrence] is already used please use different [invoice_no & order_refrence] (invoice_no: ${inv})`;
                    errorMsg.push(msg);
                    groupedErrors.dataErrors.push(`Row ${row.rowNumber || 'Unknown'}: ${msg}`);
                }

                if (ref && dbOrderRefs.has(ref)) {
                    isDuplicate = true;
                    duplicateErrorsPresent = true;
                    const msg = `this [invoice_no & order_refrence] is already used please use different [invoice_no & order_refrence] (order_reference: ${ref})`;
                    errorMsg.push(msg);
                    groupedErrors.dataErrors.push(`Row ${row.rowNumber || 'Unknown'}: ${msg}`);
                }

                if (isDuplicate) {
                    const finalMsg = errorMsg.join(' ');
                    row.validationError = row.validationError ? `${row.validationError}; ${finalMsg}` : finalMsg;
                    groupedErrors.dataErrors.push(`Row: ${finalMsg}`);
                }
            });

            // DB validation
            const invoicesToCheck = [...seenInvoices];
            const orderRefsToCheck = [...seenOrderRefs];
            let orConditions = [];
            if (invoicesToCheck.length > 0) orConditions.push({ 'shipmentDetails.invoiceNumber': { $in: invoicesToCheck.map(i => new RegExp(`^${i}$`, 'i')) } });
            if (orderRefsToCheck.length > 0) orConditions.push({ 'shipmentDetails.referenceNumber': { $in: orderRefsToCheck.map(i => new RegExp(`^${i}$`, 'i')) } });

            if (orConditions.length > 0) {
                const existingShipments = await Shipment.find({ $or: orConditions }).select('shipmentDetails.invoiceNumber shipmentDetails.referenceNumber');
                const dbInvoices = new Set(existingShipments.map(s => s.shipmentDetails?.invoiceNumber?.toLowerCase()).filter(Boolean));
                const dbOrderRefs = new Set(existingShipments.map(s => s.shipmentDetails?.referenceNumber?.toLowerCase()).filter(Boolean));

                sanitizedData.forEach((row, index) => {
                    const inv = row.invoice_no ? row.invoice_no.toString().trim().toLowerCase() : '';
                    const ref = row.order_reference ? row.order_reference.toString().trim().toLowerCase() : '';

                    let errorMsg = [];
                    if (inv && dbInvoices.has(inv)) {
                        errorMsg.push(`Invoice number "${row.invoice_no}" already exists in the system.`);
                    }
                    if (ref && dbOrderRefs.has(ref)) {
                        errorMsg.push(`Order reference "${row.order_reference}" already exists in the system.`);
                    }
                    if (errorMsg.length > 0) {
                        const finalMsg = errorMsg.join(' ');
                        row.validationError = row.validationError ? `${row.validationError}; ${finalMsg}` : finalMsg;
                        // Determine row index based on the sanitizedData index or properties. (Ideally we have rowIndex, but we'll prepend to dataErrors)
                        groupedErrors.dataErrors.push(`Row (Invoice: ${row.invoice_no}): ${finalMsg}`);
                    }
                });
            }
        }
        const hasOriginErrors = groupedErrors.dataErrors.some(e => e.includes('Shipper country must be INDIA'));
        const hasDataErrors = groupedErrors.dataErrors.length > 0;
        const hasServiceErrors = groupedErrors.serviceErrors.length > 0;

        if (hasHeaderErrors || hasOriginErrors || duplicateErrorsPresent) {
            return res.status(400).json({
                message: duplicateErrorsPresent ? 'Validation Failed. Duplicate records found.' : 'Invalid file format. Missing or incorrect mandatory columns.',
                errors: groupedErrors
            });
        }

        const limitError = validateOrderLimit(sanitizedData.length);
        if (limitError) return res.status(400).json(limitError);

        if (sanitizedData.length === 0) {
            return res.status(400).json({ message: 'No valid order rows found to upload.' });
        }

        const fileName = req.file.originalname;

        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const bulkOrderId = `BLK-${dateStr}-${randomSuffix}`;

        const bulkUpload = await BulkUpload.create({
            user: user._id,
            fileName: req.file.originalname,
            originalName: fileName,
            filePath: 'Emailed - Not Stored',
            fileSize: req.file.size,
            status: 'Processed',
            bulkOrderId: bulkOrderId,
            uploadedData: sanitizedData.map((row, index) => ({
                ...row,
                status: "Pending",
                rowNumber: index + 1
            })),
            shipmentCategory: shipmentCategory,
            bulkType: bulkType,
            bookingStatus: 'In Progress',
            proceedWithAvailableBalance: req.body.proceedWithAvailableBalance === 'true'
        });

        // AUTO-BOOK: Queue background booking
        try {
            await bulkBookingQueue.add('process-bulk-booking', {
                bulkUploadId: bulkUpload._id,
                adminId: null
            });
        } catch (queueErr) {
            return res.status(500).json({ message: `Failed to queue bulk booking: ${queueErr.message}` });
        }

        // Email Templates
        const userDetails = `
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin-top: 15px;">
                <h4 style="margin: 0 0 10px 0; color: #0B4F6C; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">Customer Details</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <tr>
                        <td style="padding: 5px 0; color: #64748b; width: 40%;">Name:</td>
                        <td style="padding: 5px 0; color: #0f172a; font-weight: 500;">${user.name}</td>
                    </tr>
                    <tr>
                        <td style="padding: 5px 0; color: #64748b;">Email:</td>
                        <td style="padding: 5px 0; color: #0f172a; font-weight: 500;">${user.email}</td>
                    </tr>
                    <tr>
                        <td style="padding: 5px 0; color: #64748b;">Phone:</td>
                        <td style="padding: 5px 0; color: #0f172a; font-weight: 500;">${user.phone || 'N/A'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 5px 0; color: #64748b;">Customer ID:</td>
                        <td style="padding: 5px 0; color: #0f172a; font-weight: 500;">${user.customerId || 'N/A'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 5px 0; color: #64748b;">Account Type:</td>
                        <td style="padding: 5px 0; color: #0f172a; font-weight: 500;">${user.accountType ? user.accountType.charAt(0).toUpperCase() + user.accountType.slice(1) : 'Personal'}</td>
                    </tr>
                </table>
            </div>
        `;

        const emailHeader = `
            <div style="text-align: center; padding: 24px 0; border-bottom: 1px solid #f1f5f9;">
                <h2 style="color: #0B4F6C; margin: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700;">DFL Group</h2>
            </div>
        `;

        const emailFooter = `
            <div style="text-align: center; padding-top: 32px; margin-top: 32px; border-top: 1px solid #f1f5f9;">
                <p style="color: #94a3b8; font-size: 13px; margin: 0;">&copy; ${new Date().getFullYear()} DFL Group. All rights reserved.</p>
                <div style="margin-top: 12px;">
                    <a href="#" style="color: #cbd5e1; text-decoration: none; margin: 0 8px; font-size: 12px;">Privacy</a>
                    <a href="#" style="color: #cbd5e1; text-decoration: none; margin: 0 8px; font-size: 12px;">Terms</a>
                </div>
            </div>
        `;

        // Sales Email
        const salesEmailOptions = {
            email: 'pb@thedflgroup.com, jameswaltercop@gmail.com, express.ops@thedflgroup.com',
            subject: `New Bulk Order Upload | ${user.name} (${user.customerId})`,
            html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
                    ${emailHeader}
                    <div style="padding: 32px;">
                        <h3 style="color: #0f172a; margin-top: 0; margin-bottom: 16px; font-size: 18px; font-weight: 600;">New Bulk Order Received</h3>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin-bottom: 24px;">A new bulk order CSV file has been uploaded and is waiting for processing.</p>
                        ${userDetails}
                        <div style="background-color: #f8fafc; padding: 16px; border-radius: 10px; margin-top: 24px; border: 1px solid #e2e8f0; display: flex; align-items: center;">
                            <div style="font-size: 24px; margin-right: 12px;">📄</div>
                            <div>
                                <p style="margin: 0; color: #64748b; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Attached File</p>
                                <p style="margin: 2px 0 0 0; color: #0f172a; font-weight: 600; font-size: 15px;">${fileName}</p>
                            </div>
                        </div>
                    </div>
                    ${emailFooter}
                </div>
            `,
            attachments: [{ filename: fileName, content: req.file.buffer }]
        };

        // Sales Email error handled below with customer email

        // Customer Confirmation Email
        const customerEmailOptions = {
            email: user.email,
            subject: 'We received your bulk order file',
            html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #f1f5f9; overflow: hidden;">
                    ${emailHeader}
                    <div style="padding: 40px 32px;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <div style="width: 64px; height: 64px; background-color: #ecfdf5; border-radius: 50%; display: inline-block; vertical-align: middle; line-height: 64px;">
                                <span style="color: #059669; font-size: 30px; vertical-align: middle; display: inline-block; line-height: normal; margin-top: -2px;">✔</span>
                            </div>
                        </div>
                        <h3 style="color: #0f172a; margin: 0 0 12px 0; text-align: center; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">Upload Successful</h3>
                        <p style="color: #475569; text-align: center; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
                            Thanks, <strong>${user.name}</strong>. We have received your file and our team has started processing your orders.
                        </p>
                        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: left; display: flex; align-items: center;">
                            <div style="font-size: 28px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; margin-right: 16px; min-width: 48px;">📄</div>
                            <div style="flex: 1;">
                                <p style="margin: 0; color: #64748b; font-size: 13px; font-weight: 500;">File Reference</p>
                                <p style="margin: 4px 0 0 0; color: #0f172a; font-weight: 600; font-size: 16px;">${fileName}</p>
                            </div>
                        </div>
                        <div style="text-align: center; margin-top: 32px;">
                            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/bulk-upload" style="display: inline-block; background-color: #0B4F6C; color: #ffffff; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-size: 15px; box-shadow: 0 4px 12px rgba(11, 79, 108, 0.2);">
                                View Dashboard
                            </a>
                        </div>
                    </div>
                    ${emailFooter}
                </div>
            `
        };

        // Send emails in background safely without parallel document saves
        Promise.allSettled([
            sendEmail(salesEmailOptions),
            sendEmail(customerEmailOptions)
        ]).then(async (results) => {
            let errors = [];
            if (results[0].status === 'rejected') errors.push(`Sales email failed: ${results[0].reason?.message || 'Unknown'}`);
            if (results[1].status === 'rejected') errors.push(`Customer email failed: ${results[1].reason?.message || 'Unknown'}`);

            if (errors.length > 0) {
                await BulkUpload.findByIdAndUpdate(bulkUpload._id, {
                    $set: { remarks: (bulkUpload.remarks ? bulkUpload.remarks + ' | ' : '') + errors.join(' | ') }
                });
            }
        });

        return res.status(200).json({
            message: bulkBookingQueue.isMock
                ? 'File uploaded successfully, but background booking is currently disabled (Redis Bypassed).'
                : 'File uploaded successfully. Booking started automatically.',
            file: req.file,
            uploadId: bulkUpload._id,
            bookingStatus: bulkBookingQueue.isMock ? 'Pending' : 'In Progress',
            warning: bulkBookingQueue.isMock ? 'Background processing is offline. Please contact administrator.' : null
        });

    } catch (error) {
        return res.status(500).json({ message: 'Server error during upload', error: error.message });
    }
};

// ======================================================
// PRE-CHECK BULK UPLOAD
// Validate Pricing + Wallet Balance Before Booking
// ======================================================
const preCheckBulkUpload = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        let user = req.user;

        if (user.isAdmin && req.body.userId) {
            const targetUser = await User.findById(req.body.userId);
            if (targetUser) user = targetUser;
        }

        const shipperCountryRaw = (user.kycData?.billingAddress?.country || 'IN').toString().trim().toUpperCase();
        const shipperCountryCode = (shipperCountryRaw === 'INDIA' || shipperCountryRaw === 'IN') ? 'IN' : shipperCountryRaw;

        try {
            await rateCalculator.loadData();
        } catch (loadErr) {
            return res.status(500).json({ message: `Failed to load rate calculator data: ${loadErr.message}` });
        }

        const groupedErrors = {
            headerErrors: [],
            dataErrors: [],
            serviceErrors: []
        };

        const isCSVFile = req.file.originalname.toLowerCase().endsWith('.csv') || req.file.mimetype === 'text/csv';
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: isCSVFile });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        const bulkType = req.body.bulkType || (req.body.shipmentCategory === 'RSA' ? 'RSA' : 'DFL');
        const isRSA = bulkType === 'RSA';

        let dbInvoices = new Set();
        let dbOrderRefs = new Set();
        let duplicateErrorsPresent = false;

        if (isRSA) {
            const sheetInvoices = [];
            const sheetOrderRefs = [];
            rows.forEach(row => {
                const inv = row.invoice_no ? row.invoice_no.toString().trim() : '';
                const ref = row.order_reference ? row.order_reference.toString().trim() : '';
                if (inv) sheetInvoices.push(inv);
                if (ref) sheetOrderRefs.push(ref);
            });
            if (sheetInvoices.length > 0 || sheetOrderRefs.length > 0) {
                const Shipment = require('../models/Shipment');
                const existingShipments = await Shipment.find({
                    user: user._id,
                    $or: [
                        { 'shipmentDetails.invoiceNumber': { $in: sheetInvoices } },
                        { 'shipmentDetails.referenceNumber': { $in: sheetOrderRefs } }
                    ]
                }).lean();
                dbInvoices = new Set(existingShipments.map(s => s.shipmentDetails?.invoiceNumber).filter(Boolean));
                dbOrderRefs = new Set(existingShipments.map(s => s.shipmentDetails?.referenceNumber).filter(Boolean));
            }
        }

        let totalRequiredAmount = 0;
        let validOrders = 0;
        const validRows = [];

        for (let idx = 0; idx < rows.length; idx++) {
            const row = rows[idx];
            const rowIndex = idx + 2;

            try {
                const invoiceNo = row.invoice_no?.toString().trim();
                const isDocRow =
                    invoiceNo === 'Required' ||
                    invoiceNo === 'INV-001' ||
                    invoiceNo?.includes('UNIQUE FOR DIFFERENT ORDERS') ||
                    invoiceNo?.includes('Valid Values');

                if (isDocRow) continue;

                const reqFields = getRequiredFields(isRSA ? 'RSA' : 'DFL');
                const isRowEmpty = reqFields.every(field => !row[field] || row[field].toString().trim() === '');
                if (isRowEmpty) continue;

                validateBulkRow(row, rowIndex, groupedErrors, shipperCountryCode, shipperCountryRaw, reqFields, bulkType);

                if (bulkType === 'RSA') {
                    const inv = row.invoice_no ? row.invoice_no.toString().trim() : '';
                    const ref = row.order_reference ? row.order_reference.toString().trim() : '';
                    let isDup = false;
                    if (inv && dbInvoices.has(inv)) {
                        groupedErrors.dataErrors.push(`Row ${rowIndex}: this [invoice_no & order_refrence] is already used please use different [invoice_no & order_refrence] (invoice_no: ${inv})`);
                        isDup = true;
                    }
                    if (ref && dbOrderRefs.has(ref)) {
                        groupedErrors.dataErrors.push(`Row ${rowIndex}: this [invoice_no & order_refrence] is already used please use different [invoice_no & order_refrence] (order_reference: ${ref})`);
                        isDup = true;
                    }
                    if (isDup) {
                        duplicateErrorsPresent = true;
                        row.validationError = row.validationError ? `${row.validationError}; Duplicate in DB` : "Duplicate in DB";
                    }
                }

                if (row.validationError) continue;

                const pricing = await calculateRowPrice(row, user, null, bulkType);
                totalRequiredAmount += pricing.finalPrice;
                validOrders++;

                validRows.push({ row, price: pricing.finalPrice });

                const limitError = validateOrderLimit(validOrders);
                if (limitError) return res.status(400).json(limitError);

            } catch (err) {
                groupedErrors.dataErrors.push(`Row ${rowIndex} error: ${err.message}`);
                continue;
            }
        }

        if (duplicateErrorsPresent) {
            return res.status(400).json({
                message: 'Validation Failed. Duplicate records found.',
                errors: groupedErrors
            });
        }

        const walletBalance = user.walletBalance || 0;
        let runningAmount = 0;
        let processableOrders = 0;

        for (const item of validRows) {
            if (runningAmount + item.price <= walletBalance) {
                runningAmount += item.price;
                processableOrders++;
            } else {
                break;
            }
        }

        if (walletBalance < totalRequiredAmount) {
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const randomSuffix = Math.floor(1000 + Math.random() * 9000);
            const bulkOrderId = `BLK-${dateStr}-${randomSuffix}`;

            const bulkUpload = await BulkUpload.create({
                user: user._id,
                fileName: req.file.originalname,
                originalName: req.file.originalname,
                filePath: 'Pending Wallet Topup',
                fileSize: req.file.size,
                status: 'Processed',
                bulkOrderId,
                uploadedData: rows.map((row, index) => ({
                    ...row,
                    status: "Pending",
                    rowNumber: index + 1
                })),
                shipmentCategory: req.body.shipmentCategory || 'csb4',
                bookingStatus: 'Pending Wallet Topup'
            });

            return res.status(200).json({
                success: true,
                insufficientBalance: true,
                uploadId: bulkUpload._id,
                bulkOrderId,
                walletBalance,
                requiredAmount: Number(totalRequiredAmount.toFixed(2)),
                validOrders,
                processableOrders,
                remainingOrders: validOrders - processableOrders
            });
        }

        return res.status(200).json({
            success: true,
            walletBalance,
            requiredAmount: Number(totalRequiredAmount.toFixed(2)),
            validOrders,
            processableOrders,
            remainingOrders: validOrders - processableOrders,
            insufficientBalance: false
        });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// ======================================================
// GET BULK UPLOAD HISTORY (With Server-Side Pagination)
// ======================================================
const getBulkUploadHistory = async (req, res) => {
    try {
        let userId = req.user._id;
        if (req.user.isAdmin && req.query.userId) {
            userId = req.query.userId;
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const count = await BulkUpload.countDocuments({ user: userId });
        const history = await BulkUpload.find({ user: userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        return res.status(200).json({
            history,
            totalPages: Math.ceil(count / limit) || 1,
            currentPage: page,
            totalRecords: count
        });
    } catch (error) {
        return res.status(500).json({ message: 'Failed to fetch upload history', error: error.message });
    }
};

// ======================================================
// GET BULK SERVICES
// ======================================================
const getBulkServices = async (req, res) => {
    try {
        const serviceConfig = require('../config/service_config.json');
        const allServices = [];

        Object.keys(serviceConfig).forEach(carrierKey => {
            const carrier = serviceConfig[carrierKey];
            if (carrier && Array.isArray(carrier.services)) {
                carrier.services.forEach(svc => {
                    allServices.push({
                        displayName: svc.displayName,
                        serviceCode: svc.serviceCode || '',
                        country: svc.country,
                        carrier: carrierKey
                    });
                });
            }
        });

        const seen = new Set();
        const uniqueServices = [];
        allServices.forEach(svc => {
            const key = `${svc.displayName}-${svc.serviceCode}-${svc.country}`.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                uniqueServices.push(svc);
            }
        });

        uniqueServices.sort((a, b) => {
            const countryCompare = (a.country || '').localeCompare(b.country || '');
            if (countryCompare !== 0) return countryCompare;
            return (a.displayName || '').localeCompare(b.displayName || '');
        });

        return res.status(200).json(uniqueServices);
    } catch (error) {
        return res.status(500).json({ message: 'Failed to fetch services config', error: error.message });
    }
};

// ======================================================
// GET SINGLE BULK UPLOAD BY ID
// ======================================================
const getBulkUploadById = async (req, res) => {
    try {
        const bulkUpload = await BulkUpload.findById(req.params.id);

        if (!bulkUpload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        return res.status(200).json(bulkUpload);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// ======================================================
// RESUME BULK UPLOAD (after wallet topup)
// ======================================================
const resumeBulkUpload = async (req, res) => {
    try {
        const bulkUpload = await BulkUpload.findById(req.params.id);

        if (!bulkUpload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        if (bulkUpload.bookingStatus !== 'Pending Wallet Topup') {
            return res.status(400).json({ message: 'This upload cannot be resumed' });
        }

        bulkUpload.bookingStatus = 'In Progress';
        await bulkUpload.save();

        await bulkBookingQueue.add('process-bulk-booking', {
            bulkUploadId: bulkUpload._id,
            adminId: null
        });

        return res.status(200).json({
            success: true,
            message: 'Booking resumed successfully'
        });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// ======================================================
// DOWNLOAD FAILED ORDERS CSV
// User can fix failed rows and upload again
// ======================================================
const downloadFailedCsv = async (req, res) => {
    try {
        const bulkUpload = await BulkUpload.findById(req.params.id);

        if (!bulkUpload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        const failedRows = bulkUpload.uploadedData.filter(row => row.status === 'Failed');

        return res.status(200).json({
            success: true,
            totalFailed: failedRows.length,
            failedRows
        });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const rateCalculator = require('../utils/rateCalculator');
const { checkWeightLimit } = require('../utils/weightLimitChecker');

module.exports = {
    upload,
    preCheckBulkUpload,
    uploadBulkOrder,
    getBulkUploadHistory,
    getBulkServices,
    getBulkUploadById,
    resumeBulkUpload,
    downloadFailedCsv,
    validateBulkRow
};