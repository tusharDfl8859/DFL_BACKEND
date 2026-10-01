const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const Carrier = require('../../models/Carrier');
const BoxConfig = require('../../models/BoxConfig');
const PackingBox = require('../../models/PackingBox');
const PackingBoxShipment = require('../../models/PackingBoxShipment');
const BoxSequence = require('../../models/BoxSequence');
const sendEmail = require('../../utils/emailService');
const { generateShipmentStatusUpdateEmail } = require('../../utils/emailTemplates');
const XLSX = require('xlsx');
const { sendShipmentStatusNotification } = require('../whatsappService');

let CountryStateCity = null;
try {
    CountryStateCity = require('../../../Frontend/node_modules/country-state-city');
} catch (error) {
    try {
        CountryStateCity = require('country-state-city');
    } catch (innerError) {
        CountryStateCity = null;
    }
}

const DEFAULT_MAX_GROSS_WEIGHT = 30;
const COUNTRY_CODES = CountryStateCity?.Country?.getAllCountries?.() || [];
const REGION_NAME_TO_CODE = new Map();
const REGION_CODE_TO_NAME = new Map();
const STATIC_ISO3_TO_ISO2 = new Map([
    ['GBR', 'GB'], ['USA', 'US'], ['IND', 'IN'], ['ARE', 'AE'], ['CAN', 'CA'],
    ['AUS', 'AU'], ['DEU', 'DE'], ['FRA', 'FR'], ['ITA', 'IT'], ['ESP', 'ES'],
    ['NLD', 'NL'], ['SGP', 'SG'], ['MYS', 'MY'], ['JPN', 'JP'], ['KOR', 'KR'],
    ['NZL', 'NZ'], ['CHN', 'CN'], ['HKG', 'HK'], ['ZAF', 'ZA'], ['SAU', 'SA'],
    ['QAT', 'QA'], ['KWT', 'KW'], ['OMN', 'OM'], ['BHR', 'BH']
]);

const COUNTRY_ALIASES = new Map([
    ['UNITED STATES OF AMERICA', 'US'],
    ['UNITED STATES', 'US'],
    ['USA', 'US'],
    ['U.S.A.', 'US'],
    ['AMERICA', 'US'],
    ['UNITED KINGDOM', 'GB'],
    ['UK', 'GB'],
    ['GREAT BRITAIN', 'GB'],
    ['BRITAIN', 'GB'],
    ['ENGLAND', 'GB'],
    ['SCOTLAND', 'GB'],
    ['WALES', 'GB'],
    ['NORTHERN IRELAND', 'GB'],
    ['INDIA', 'IN'],
    ['UNITED ARAB EMIRATES', 'AE'],
    ['UAE', 'AE'],
    ['U.A.E.', 'AE'],
    ['DUBAI', 'AE'],
    ['ABU DHABI', 'AE'],
    ['CANADA', 'CA'],
    ['AUSTRALIA', 'AU'],
    ['GERMANY', 'DE'],
    ['FRANCE', 'FR'],
    ['ITALY', 'IT'],
    ['SPAIN', 'ES'],
    ['NETHERLANDS', 'NL'],
    ['SINGAPORE', 'SG'],
    ['MALAYSIA', 'MY'],
    ['JAPAN', 'JP'],
    ['SOUTH KOREA', 'KR'],
    ['NEW ZEALAND', 'NZ'],
    ['CHINA', 'CN'],
    ['HONG KONG', 'HK'],
    ['SOUTH AFRICA', 'ZA'],
    ['SAUDI ARABIA', 'SA'],
    ['QATAR', 'QA'],
    ['KUWAIT', 'KW'],
    ['OMAN', 'OM'],
    ['BAHRAIN', 'BH']
]);

const normalizeCountryToken = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[._]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

for (const country of COUNTRY_CODES) {
    if (!country?.isoCode || !country?.name) continue;
    REGION_NAME_TO_CODE.set(normalizeCountryToken(country.name), country.isoCode.toUpperCase());
    REGION_CODE_TO_NAME.set(country.isoCode.toUpperCase(), country.name.toUpperCase());
}

// Fallback static entries if CountryStateCity is unavailable or incomplete
for (const [name, code] of COUNTRY_ALIASES.entries()) {
    if (!REGION_NAME_TO_CODE.has(name)) REGION_NAME_TO_CODE.set(name, code);
    if (!REGION_CODE_TO_NAME.has(code)) REGION_CODE_TO_NAME.set(code, name);
}

const resolveCountryCode = (value) => {
    const token = normalizeCountryToken(value);
    if (!token) return null;
    if (COUNTRY_ALIASES.has(token)) return COUNTRY_ALIASES.get(token);
    if (REGION_NAME_TO_CODE.has(token)) return REGION_NAME_TO_CODE.get(token);
    if (/^[A-Z]{2}$/.test(token)) return token;
    if (/^[A-Z]{3}$/.test(token)) {
        const match = COUNTRY_CODES.find((country) => String(country.isoCode3 || '').toUpperCase() === token);
        if (match) return match.isoCode.toUpperCase();
        if (STATIC_ISO3_TO_ISO2.has(token)) return STATIC_ISO3_TO_ISO2.get(token);
    }
    return null;
};

const getCountryDisplayName = (value) => {
    const code = resolveCountryCode(value);
    if (!code) return String(value || '').trim().toUpperCase() || null;
    return REGION_CODE_TO_NAME.get(code) || code;
};

const makeCode = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const isObjectIdLike = (value) => /^[a-f\d]{24}$/i.test(String(value || '').trim());

const getCarrierShipperCode = (carrier) => {
    const raw = makeCode(carrier?.shortCode || carrier?.code || 'BOX');
    const condensed = raw.replace(/[^A-Z0-9]/g, '');
    return (condensed.slice(0, 3) || 'BOX').padEnd(3, 'X');
};

const getBoxYear = (date = new Date()) => String(date.getFullYear()).slice(-2);

const generateBoxId = async (boxConfig, destinationCountry) => {
    const countryCode = resolveCountryCode(destinationCountry) || 'XX';
    const shipperCode = getCarrierShipperCode(boxConfig?.carrier);
    const year = getBoxYear(new Date());
    const scopeKey = `${countryCode}-${shipperCode}-${year}`;

    const sequence = await BoxSequence.findOneAndUpdate(
        { scopeKey },
        {
            $setOnInsert: {
                scopeKey,
                countryCode,
                shipperCode,
                year,
            },
            $inc: { counter: 1 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const serial = String(sequence.counter).padStart(5, '0');
    return `DFL-${countryCode}-${shipperCode}-${year}-${serial}`;
};

const toNumber = (value) => {
    const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
};

const getShipmentWeight = (shipment) => {
    const boxWeights = Array.isArray(shipment?.shipmentDetails?.boxes)
        ? shipment.shipmentDetails.boxes.map((box) => toNumber(box?.weight)).filter((value) => value !== null)
        : [];
    const total = boxWeights.reduce((sum, value) => sum + value, 0);
    return total > 0 ? total : null;
};

const getShipmentDimensions = (shipment) => {
    const firstBox = Array.isArray(shipment?.shipmentDetails?.boxes) ? shipment.shipmentDetails.boxes[0] : null;
    return {
        length: toNumber(firstBox?.length),
        width: toNumber(firstBox?.width),
        height: toNumber(firstBox?.height),
    };
};

const getShipmentDestinationCountry = (shipment) => {
    const candidate = shipment?.consigneeDetails?.countryCode ||
        shipment?.consigneeDetails?.country ||
        shipment?.destinationCountry ||
        shipment?.serviceDetails?.destinationCountry ||
        shipment?.shipmentDetails?.consigneeCountry ||
        shipment?.consigneeDetails?.country_code;
    return resolveCountryCode(candidate) || (candidate && /^[A-Z]{2}$/i.test(String(candidate).trim()) ? String(candidate).trim().toUpperCase() : null);
};

const sendShipmentStatusEmail = async ({ shipment, statusLabel, actionLabel }) => {
    try {
        const user = shipment?.user && typeof shipment.user === 'object'
            ? shipment.user
            : await User.findById(shipment?.user).lean();
        const recipients = [
            user?.email,
            shipment?.shipperDetails?.email,
            shipment?.consigneeDetails?.email
        ].filter((value, index, self) => value && self.indexOf(value) === index);

        if (!recipients.length) {
            console.warn('[PackingEmail] Skipped shipment status email: no recipient email found', {
                shipmentId: shipment?.shipmentId,
                statusLabel
            });
            return;
        }

        const html = generateShipmentStatusUpdateEmail({ shipment, statusLabel, actionLabel });
        await sendEmail({
            email: recipients.join(','),
            subject: `${statusLabel}: Shipment ${shipment?.shipmentId || 'Update'}`,
            html,
        });
        console.log('[PackingEmail] Shipment status email sent', {
            shipmentId: shipment?.shipmentId,
            statusLabel,
            recipients
        });

        // Trigger WhatsApp status notification
        try {
            await sendShipmentStatusNotification({
                shipment,
                newStatus: statusLabel,
            });
        } catch (whatsappError) {
            console.error('[PackingEmail] Failed to send WhatsApp status notification:', whatsappError.message);
        }
    } catch (error) {
        console.error('[PackingEmail] Failed to send shipment status email:', error.message);
    }
};

const CSV_IV_EXCEL_HEADERS = [
    'Shipment ID',
    'BOX ID',
    'RSA number',
    'LastMile number',
    'MAWB_Number',
    'No_of_Bags_Pkgs',
    'Numbers_of_HAW',
    'HAWB_Number',
    'Description_of_Goods',
    'Value',
    'Consignor_Name',
    'Address_1',
    'Address_2',
    'City',
    'State',
    'Postal_Code',
    'Country',
    'Consignee_Name',
    'Address_1',
    'Address_2',
    'City',
    'State',
    'Postal_Code',
    'Country',
    'Weight',
    'Total_IGST_Paid',
    'Payment_through',
    'Bond_or_UT',
    'Date_of_EXPORT',
    'Export_Invoice_n',
    'Date_of_GST_Inv',
    'Gst_Invoice_no',
    'Gstin_id',
    'Gstin_type',
    'MHBS_NO',
    'HAWB_CRN',
    'CRN_No/CRN_MH',
    'Invoice_Value',
    'Invoice_Currency',
    'FOB_Value',
    'ADCode',
];

const CSV_V_EXCEL_HEADERS = [
    'Shipment_ID',
    'HAWB_Number',
    'No_of_Bags_Pkgs_Pieces_ULD',
    'Declared_Weight',
    'Import_Export_Code',
    'Terms_of_Invoice',
    'MHBS_NO',
    'Export_Using_ECOM',
    'MEIS_Scheme',
    'AD_Code',
    'CRN_NO',
    'CRN_MHBS_NO',
    'Consignor Name',
    'Consignor Address 1',
    'ConsigConsignor',
    'Consignor State',
    'Consignor City',
    'Consignor Postal Code',
    'Consignor Country',
    'Consignee Name',
    'Consignee Address 1',
    'Consignee Address 2',
    'Consignee City',
    'Consignee State',
    'Consignee Postal Code',
    'Consignee_Country',
    'Inv_No',
    'Inv_Dt',
    'CTSH',
    'Description_of_Goods',
    'Quantity',
    'UOM',
    'Unit_Price',
    'Total_Item_value',
    'Item_Cur',
    'Total_Taxable_Value',
    'Taxable_Value_Cur',
    'Total_IGST_Paid',
    'Total_CESS_Paid',
    'Bond_or_UT',
    'Gstin_type',
    'Gstin_id',
    'State_Code',
    'ACCOUNT_NO',
    'GOV_NONGOV_TYPE',
    'NFEI_FLAG',
    'BOX ID',
];

const buildCsvIvRow = (s, packingBox) => {
    const boxes = s?.shipmentDetails?.boxes || [];
    const details = s?.shipmentDetails || {};
    const sWeight = boxes.reduce((sum, b) => sum + (Number(b.weight) || 0), 0) || parseFloat(details?.chargeableWeight || s?.serviceDetails?.chargeableWeight || details?.actualWeight || s?.actualWeight || 0);
    const shipper = s?.shipperDetails || {};
    const consignee = s?.consigneeDetails || {};
    const kyc = s?.user?.kycData || {};

    const firstBoxItem = boxes?.[0]?.items?.[0] || {};
    const firstCsbVItem = details?.csbVItems?.[0] || {};
    const description = firstBoxItem.productName || firstCsbVItem.productName || details.descriptionOfGoods || details.contentDescription || details.itemDescription || details.purposeOfShipment || 'Goods';

    const calculatedItemsTotal = boxes.reduce((acc, b) => {
        return acc + ((b.items || []).reduce((sum, item) => sum + ((parseFloat(item.unitPrice) || 0) * (parseFloat(item.quantity) || 0)), 0));
    }, 0) || (details.csbVItems || []).reduce((acc, item) => acc + ((parseFloat(item.unitPrice) || 0) * (parseFloat(item.quantity) || 0)), 0);

    const totalVal = Number(details.totalItemValue || details.totalDeclaredValue || details.declaredValue || details.invoiceValue || calculatedItemsTotal || 0);

    const invNo = details.invoiceNumber || s?.exportInvoiceNumber || s?.invoiceNumber || '';
    const invDateRaw = details.invoiceDate || s?.dateOfExport || s?.exportInvoiceDate || s?.createdAt;
    const invDateStr = invDateRaw ? new Date(invDateRaw).toLocaleDateString('en-GB') : '';

    const gstinId = details.gstinId || kyc.gstin || kyc.gstNumber || s?.gstinId || '';
    const gstinType = details.gstinType || kyc.gstinType || (gstinId ? 'GSTIN (Normal)' : '');

    const totalIgstPaid = details.totalIgstPaid !== undefined && details.totalIgstPaid !== null && details.totalIgstPaid !== ''
        ? details.totalIgstPaid
        : (s?.totalIgstPaid || 0);

    const bondOrUt = details.bondOrUt || (details.gstPaymentType === 'lut' ? 'UT' : (s?.bondOrUt || ''));
    const adCode = details.adCode || kyc.adCode || s?.adCode || shipper.adCode || '';

    return [
        s?.shipmentId || '',                                         // A: Shipment ID
        packingBox?.boxId || '',                                     // B: BOX ID
        s?.trackingId || s?.shipmentId || '',                        // C: RSA number
        s?.lastMileAWB || '',                                        // D: LastMile number
        s?.mawbNumber || s?.mawb || s?.serviceDetails?.mawbNumber || '', // E: MAWB_Number
        boxes.length || s?.shipmentDetails?.noOfBoxes || 1,          // F: No_of_Bags_Pkgs
        s?.numbersOfHAW || '',                                       // G: Numbers_of_HAW
        s?.hawbNumber || s?.shipmentId || '',                        // H: HAWB_Number
        description,                                                 // I: Description_of_Goods
        totalVal || '',                                              // J: Value
        shipper.shipperName || shipper.name || '',                   // K: Consignor_Name
        shipper.addressLine1 || shipper.address || '',               // L: Address_1 (Consignor)
        shipper.addressLine2 || '',                                  // M: Address_2 (Consignor)
        shipper.city || '',                                          // N: City (Consignor)
        shipper.state || '',                                         // O: State (Consignor)
        shipper.pincode || shipper.postalCode || '',                 // P: Postal_Code (Consignor)
        shipper.country || 'India',                                  // Q: Country (Consignor)
        consignee.consigneeName || consignee.name || '',             // R: Consignee_Name
        consignee.addressLine1 || consignee.address || '',           // S: Address_1 (Consignee)
        consignee.addressLine2 || '',                                // T: Address_2 (Consignee)
        consignee.city || '',                                        // U: City (Consignee)
        consignee.state || '',                                       // V: State (Consignee)
        consignee.pincode || consignee.postalCode || '',             // W: Postal_Code (Consignee)
        consignee.country || '',                                     // X: Country (Consignee)
        Number(sWeight.toFixed(2)),                                  // Y: Weight
        totalIgstPaid || '',                                         // Z: Total_IGST_Paid
        s?.paymentThrough || '',                                     // AA: Payment_through
        bondOrUt,                                                    // AB: Bond_or_UT
        invDateStr,                                                  // AC: Date_of_EXPORT
        invNo,                                                       // AD: Export_Invoice_n
        invDateStr,                                                  // AE: Date_of_GST_Inv
        invNo,                                                       // AF: Gst_Invoice_no
        gstinId,                                                     // AG: Gstin_id
        gstinType,                                                   // AH: Gstin_type
        s?.mhbsNo || '',                                             // AI: MHBS_NO
        s?.hawbCrn || '',                                            // AJ: HAWB_CRN
        s?.crnNo || '',                                              // AK: CRN_No/CRN_MH
        totalVal || '',                                              // AL: Invoice_Value
        details.currency || details.invoiceCurrency || 'INR',        // AM: Invoice_Currency
        details.totalTaxableValue || totalVal || '',                 // AN: FOB_Value
        adCode,                                                      // AO: ADCode
    ];
};

const buildCsvVRow = (s, packingBox) => {
    const boxes = s?.shipmentDetails?.boxes || [];
    const details = s?.shipmentDetails || {};
    const sWeight = boxes.reduce((sum, b) => sum + (Number(b.weight) || 0), 0) || parseFloat(details?.chargeableWeight || s?.serviceDetails?.chargeableWeight || details?.actualWeight || s?.actualWeight || 0);
    const shipper = s?.shipperDetails || {};
    const consignee = s?.consigneeDetails || {};
    const kyc = s?.user?.kycData || {};

    const firstBoxItem = boxes?.[0]?.items?.[0] || {};
    const firstCsbVItem = details?.csbVItems?.[0] || {};
    const description = firstBoxItem.productName || firstCsbVItem.productName || details.descriptionOfGoods || details.contentDescription || details.itemDescription || details.purposeOfShipment || 'Goods';

    const hsnCode = details.ctshCode || boxes?.[0]?.hsnCode || firstBoxItem.hsnCode || firstCsbVItem.hsnCode || details.hsnCode || s?.ctsh || '';

    const calculatedItemsTotal = boxes.reduce((acc, b) => {
        return acc + ((b.items || []).reduce((sum, item) => sum + ((parseFloat(item.unitPrice) || 0) * (parseFloat(item.quantity) || 0)), 0));
    }, 0) || (details.csbVItems || []).reduce((acc, item) => acc + ((parseFloat(item.unitPrice) || 0) * (parseFloat(item.quantity) || 0)), 0);

    const totalVal = Number(details.totalItemValue || details.totalDeclaredValue || details.declaredValue || details.invoiceValue || calculatedItemsTotal || 0);
    const pcsCount = boxes.length || s?.shipmentDetails?.noOfBoxes || 1;

    const unitPrice = firstBoxItem.unitPrice || firstCsbVItem.unitPrice || (pcsCount > 0 && totalVal ? (totalVal / pcsCount).toFixed(2) : (totalVal || ''));

    const iecNumber = details.iecNumber || kyc.iecNumber || s?.importExportCode || shipper.iecCode || '';
    const adCode = details.adCode || kyc.adCode || s?.adCode || shipper.adCode || '';

    const invNo = details.invoiceNumber || s?.exportInvoiceNumber || s?.invoiceNumber || '';
    const invDateRaw = details.invoiceDate || s?.dateOfExport || s?.exportInvoiceDate || s?.createdAt;
    const invDateStr = invDateRaw ? new Date(invDateRaw).toLocaleDateString('en-GB') : '';

    const totalIgstPaid = details.totalIgstPaid !== undefined && details.totalIgstPaid !== null && details.totalIgstPaid !== ''
        ? details.totalIgstPaid
        : (s?.totalIgstPaid !== undefined ? s.totalIgstPaid : totalVal || 0);

    const bondOrUt = details.bondOrUt || (details.gstPaymentType === 'lut' ? 'LUT/Bond' : (s?.bondOrUt || 'LUT/Bond'));
    const gstinId = details.gstinId || kyc.gstin || kyc.gstNumber || s?.gstinId || '';
    const gstinType = details.gstinType || kyc.gstinType || (gstinId ? 'GSTIN (Normal)' : 'GSTIN (Normal)');

    const stateCode = details.stateCode || shipper.stateCode || kyc.stateCode || '09';
    const accountNo = details.accountNo || kyc.bankAccountNumber || s?.accountNo || shipper.accountNo || '';
    const govType = details.govNonGovType || s?.govNongovType || 'P';
    const nfeiFlag = details.nfetFlag || details.nfeiFlag || s?.nfeiFlag || 'N';

    const itemCurrency = details.currency || details.invoiceCurrency || 'GBP';
    const hawbNo = s?.lastMileAWB || s?.trackingId || s?.shipmentId || '';

    return [
        s?.shipmentId || '',                                         // A: Shipment_ID
        hawbNo,                                                      // B: HAWB_Number
        pcsCount,                                                    // C: No_of_Bags_Pkgs_Pieces_ULD
        Number(sWeight.toFixed(2)),                                  // D: Declared_Weight
        iecNumber,                                                   // E: Import_Export_Code
        s?.termsOfInvoice || 'FOB',                                  // F: Terms_of_Invoice
        s?.mhbsNo || '',                                             // G: MHBS_NO
        s?.exportIndicator || 'Y',                                   // H: Export_Using_ECOM
        s?.meisScheme || 'NO',                                       // I: MEIS_Scheme
        adCode,                                                      // J: AD_Code
        s?.crnNo || hawbNo,                                          // K: CRN_NO
        s?.crnMhbsNo || '',                                          // L: CRN_MHBS_NO
        shipper.shipperName || shipper.name || '',                   // M: Consignor Name
        shipper.addressLine1 || shipper.address || '',               // N: Consignor Address 1
        shipper.addressLine2 || '',                                  // O: ConsigConsignor
        shipper.state || '',                                         // P: Consignor State
        shipper.city || '',                                          // Q: Consignor City
        shipper.pincode || shipper.postalCode || '',                 // R: Consignor Postal Code
        shipper.country || 'INDIA',                                  // S: Consignor Country
        consignee.consigneeName || consignee.name || '',             // T: Consignee Name
        consignee.addressLine1 || consignee.address || '',           // U: Consignee Address 1
        consignee.addressLine2 || '',                                // V: Consignee Address 2
        consignee.city || '',                                        // W: Consignee City
        consignee.state || '',                                       // X: Consignee State
        consignee.pincode || consignee.postalCode || '',             // Y: Consignee Postal Code
        consignee.country || getCountryDisplayName(packingBox?.destinationCountry) || '', // Z: Consignee_Country
        invNo,                                                       // AA: Inv_No
        invDateStr,                                                  // AB: Inv_Dt
        hsnCode,                                                     // AC: CTSH
        description,                                                 // AD: Description_of_Goods
        pcsCount,                                                    // AE: Quantity
        details.uom || 'PCS',                                        // AF: UOM
        unitPrice,                                                   // AG: Unit_Price
        totalVal || '',                                              // AH: Total_Item_value
        itemCurrency,                                                // AI: Item_Cur
        details.totalTaxableValue || totalVal || '',                 // AJ: Total_Taxable_Value
        itemCurrency,                                                // AK: Taxable_Value_Cur
        totalIgstPaid,                                               // AL: Total_IGST_Paid
        0,                                                           // AM: Total_CESS_Paid
        bondOrUt,                                                    // AN: Bond_or_UT
        gstinType,                                                   // AO: Gstin_type
        gstinId,                                                     // AP: Gstin_id
        stateCode,                                                   // AQ: State_Code
        accountNo,                                                   // AR: ACCOUNT_NO
        govType,                                                     // AS: GOV_NONGOV_TYPE
        nfeiFlag,                                                    // AT: NFEI_FLAG
        packingBox?.boxId || '',                                     // AU: BOX ID
    ];
};

const generateDispatchExcelAttachment = (packingBox, shipments) => {
    const isCsvV = packingBox?.category === 'CSV V';
    const headers = isCsvV ? CSV_V_EXCEL_HEADERS : CSV_IV_EXCEL_HEADERS;

    const dataRows = (shipments || []).map((s) => {
        return isCsvV ? buildCsvVRow(s, packingBox) : buildCsvIvRow(s, packingBox);
    });

    const sheetData = [headers, ...dataRows];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);

    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

    const sheetName = isCsvV ? 'CSB-V Report' : 'CSV IV Manifest';
    const filenamePrefix = isCsvV ? 'CSB_V_Manifest' : 'CSV_IV_Manifest';

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return {
        filename: `${filenamePrefix}_${packingBox?.boxId || 'Box'}.xlsx`,
        content: buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
};

const getUniqueCustomerKycAttachments = (shipments) => {
    const customerMap = new Map();

    for (const s of shipments || []) {
        if (!s) continue;
        const userDoc = s.user && typeof s.user === 'object' ? s.user : null;

        const customerId = userDoc?._id?.toString() || s.shipperDetails?.shipperName?.trim()?.toLowerCase() || 'default';
        const rawCustomerName = userDoc?.name || s.shipperDetails?.shipperName || 'Customer';
        const customerName = rawCustomerName.replace(/[^a-zA-Z0-9_-]/g, '_');

        if (customerMap.has(customerId)) {
            // Already collected KYC documents for this customer; skip duplicate.
            continue;
        }

        const kycDocs = [];
        const kycData = userDoc?.kycData || {};

        const potentialDocFields = [
            { field: 'aadharFrontImage', name: 'Aadhaar_Front' },
            { field: 'aadharBackImage', name: 'Aadhaar_Back' },
            { field: 'panCardImage', name: 'PAN_Card' },
            { field: 'certificateImage', name: 'Certificate' },
            { field: 'companyAadhaarFrontImage', name: 'Company_Aadhaar_Front' },
            { field: 'companyAadhaarBackImage', name: 'Company_Aadhaar_Back' },
            { field: 'gstFile', name: 'GST_Certificate' },
            { field: 'iecFile', name: 'IEC_Certificate' },
            { field: 'adCodeFile', name: 'AD_Code' },
            { field: 'lutFile', name: 'LUT_File' },
        ];

        for (const item of potentialDocFields) {
            const docUrl = kycData[item.field];
            if (docUrl && typeof docUrl === 'string' && docUrl.trim().length > 5) {
                const cleanUrl = docUrl.trim();
                let ext = 'jpg';
                if (cleanUrl.toLowerCase().endsWith('.pdf')) ext = 'pdf';
                else if (cleanUrl.toLowerCase().endsWith('.png')) ext = 'png';
                else if (cleanUrl.toLowerCase().endsWith('.jpeg')) ext = 'jpeg';

                kycDocs.push({
                    filename: `KYC_${customerName}_${item.name}.${ext}`,
                    path: cleanUrl,
                });
            }
        }

        if (s.shipperDetails?.idProofUrl && typeof s.shipperDetails.idProofUrl === 'string' && s.shipperDetails.idProofUrl.trim().length > 5) {
            const cleanUrl = s.shipperDetails.idProofUrl.trim();
            let ext = cleanUrl.toLowerCase().endsWith('.pdf') ? 'pdf' : 'jpg';
            kycDocs.push({
                filename: `KYC_${customerName}_IDProof.${ext}`,
                path: cleanUrl,
            });
        }

        customerMap.set(customerId, kycDocs);
    }

    const allKycAttachments = [];
    for (const docs of customerMap.values()) {
        allKycAttachments.push(...docs);
    }
    return allKycAttachments;
};

const sendCarrierDispatchNotification = async (packingBox, shipments) => {
    try {
        const carrierDoc = packingBox?.carrier;
        const carrierEmailsList = [];
        if (carrierDoc?.email && String(carrierDoc.email).trim()) {
            carrierEmailsList.push(String(carrierDoc.email).trim());
        }
        if (Array.isArray(carrierDoc?.emails)) {
            carrierDoc.emails.forEach((em) => {
                if (em && String(em).trim()) carrierEmailsList.push(String(em).trim());
            });
        }
        carrierEmailsList.push('tushargupta8859@gmail.com');

        const recipientsList = carrierEmailsList.filter((v, i, a) => v && a.indexOf(v) === i);

        const totalWeight = (shipments || []).reduce((sum, s) => {
            const boxes = s?.shipmentDetails?.boxes || [];
            const w = boxes.reduce((bSum, b) => bSum + (Number(b.weight) || 0), 0);
            return sum + w;
        }, 0);

        const excelAttachment = generateDispatchExcelAttachment(packingBox, shipments);
        const kycAttachments = getUniqueCustomerKycAttachments(shipments);
        const allAttachments = [excelAttachment, ...kycAttachments];

        const html = `
            <div style="font-family: Arial, sans-serif; color: #334155; max-width: 700px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
                <h2 style="color: #059669; margin-top: 0;">Box Dispatch Manifest Notification</h2>
                <p style="font-size: 14px;">Hello <strong>${carrierDoc?.name || 'Carrier Partner'}</strong>,</p>
                <p style="font-size: 14px;">Box <strong>${packingBox?.boxId || ''}</strong> has been successfully <strong>DISPATCHED</strong> containing <strong>${(shipments || []).length} shipment(s)</strong>.</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 15px 0; background: #f8fafc; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 8px;">
                    <tr><td style="padding: 8px; font-weight: bold; width: 35%;">Box ID:</td><td style="padding: 8px;">${packingBox?.boxId || ''}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">Carrier:</td><td style="padding: 8px;">${carrierDoc?.code || ''} (${carrierDoc?.name || ''})</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">Category:</td><td style="padding: 8px;">${packingBox?.category || 'CSV IV'}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">Destination Country:</td><td style="padding: 8px;">${getCountryDisplayName(packingBox?.destinationCountry)}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">Total Shipments:</td><td style="padding: 8px;">${(shipments || []).length}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">Total Weight:</td><td style="padding: 8px;">${totalWeight.toFixed(2)} KG</td></tr>
                </table>

                <div style="padding: 12px 16px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; font-size: 13px; color: #065f46; margin-top: 15px;">
                    📊 <strong>Excel Manifest & Customer KYC Attachments Included:</strong><br/>
                    • Excel Manifest: <code>${excelAttachment.filename}</code><br/>
                    • Unique Customer KYC Documents: <strong>${kycAttachments.length} file(s)</strong> (deduplicated 1 per customer).
                </div>

                <p style="margin-top: 25px; font-size: 12px; color: #64748b;">This is an automated dispatch manifest notification from DFL Group Operations Team.</p>
            </div>
        `;

        for (const targetEmail of recipientsList) {
            await sendEmail({
                email: targetEmail,
                subject: `[Dispatch Manifest] Box ${packingBox?.boxId || ''} Dispatched (${packingBox?.category || 'CSV IV'}) - ${carrierDoc?.name || 'Carrier'}`,
                html,
                attachments: allAttachments,
            });
        }
        console.log('[CarrierDispatchEmail] Dispatch manifest email sent to carrier with Excel & KYC attachments', {
            boxId: packingBox?.boxId,
            recipients: recipientsList,
            shipmentCount: (shipments || []).length,
            excelAttachment: excelAttachment.filename,
            kycAttachmentsCount: kycAttachments.length,
        });
    } catch (error) {
        console.error('[CarrierDispatchEmail] Failed to send carrier dispatch email:', error?.message || error);
    }
};

const computePackingSummary = async (packingBoxId) => {
    const boxDoc = await PackingBox.findById(packingBoxId).populate('boxConfig').lean();
    if (!boxDoc) return null;

    const assignments = await PackingBoxShipment.find({ packingBox: packingBoxId })
        .populate('shipment', 'shipmentId consigneeDetails shipmentDetails status trackingId lastMileAWB')
        .lean();

    const shipments = assignments
        .filter((row) => row?.shipment)
        .map((row) => {
            const shipment = row.shipment;
            return {
                shipmentId: shipment.shipmentId,
                consigneeName: shipment.consigneeDetails?.consigneeName || '',
                destinationCountry: getShipmentDestinationCountry(shipment),
                actualWeight: getShipmentWeight(shipment),
                dimensions: getShipmentDimensions(shipment),
                status: shipment.status,
                packedAt: row.scannedAt || row.createdAt || null,
            };
        });

    const totalShipmentWeight = shipments.reduce((sum, item) => sum + (item.actualWeight || 0), 0);
    const tareWeight = boxDoc.boxConfig?.tareWeight || 0;
    const maxGrossWeight = boxDoc.boxConfig?.maxGrossWeight || DEFAULT_MAX_GROSS_WEIGHT;
    const grossWeight = tareWeight + totalShipmentWeight;
    const remainingWeight = maxGrossWeight - grossWeight;

    return {
        ...boxDoc,
        shipments,
        shipmentCount: shipments.length,
        totalShipmentWeight,
        grossWeight,
        remainingWeight,
    };
};

const createBoxConfig = async (payload) => {
    const carrier = await Carrier.findById(payload.carrierId);
    if (!carrier) throw new Error('Carrier not found.');
    const generatedCode = payload.code && String(payload.code).trim()
        ? String(payload.code).trim().toUpperCase()
        : `${makeCode(carrier.code)}-${makeCode(payload.name || 'CONFIG')}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const doc = await BoxConfig.create({
        ...payload,
        code: generatedCode,
        carrier: carrier._id,
        maxGrossWeight: payload.maxGrossWeight || DEFAULT_MAX_GROSS_WEIGHT,
    });
    return doc.toObject();
};

const createPackingBox = async ({ boxId, boxConfigId, destinationCountry, category = 'CSV IV', openedBy = null }) => {
    const boxConfig = await BoxConfig.findById(boxConfigId);
    if (!boxConfig) throw new Error('Box configuration not found.');
    const carrierDoc = await Carrier.findById(boxConfig.carrier);
    if (!carrierDoc) throw new Error('Carrier not found.');
    const boxConfigData = typeof boxConfig.toObject === 'function' ? boxConfig.toObject() : boxConfig;
    const generatedBoxId = boxId && String(boxId).trim()
        ? String(boxId).trim().toUpperCase()
        : await generateBoxId({ ...boxConfigData, carrier: carrierDoc }, destinationCountry);
    const doc = await PackingBox.create({
        boxId: generatedBoxId,
        boxConfig: boxConfig._id,
        carrier: carrierDoc._id,
        destinationCountry,
        category: category || 'CSV IV',
        openedBy,
    });
    return doc.toObject();
};

const resolveShipmentByRef = async (shipmentRef, session) => {
    const normalizedRef = String(shipmentRef || '').trim();
    const orConditions = [
        { shipmentId: normalizedRef },
        { trackingId: normalizedRef },
        { lastMileAWB: normalizedRef },
    ];

    if (isObjectIdLike(normalizedRef)) {
        orConditions.push({ _id: normalizedRef });
    }

    return Shipment.findOne({ $or: orConditions }).session(session);
};

const addShipmentToBox = async ({ packingBoxId, shipmentRef, scannedBy = null, session = null }) => {
    const txnSession = session || await mongoose.startSession();
    const ownSession = !session;
    try {
        if (ownSession) txnSession.startTransaction();

        const packingBox = await PackingBox.findById(packingBoxId).session(txnSession);
        if (!packingBox) throw new Error('Packing box not found.');
        if (packingBox.status === 'SEALED' || packingBox.status === 'DISPATCHED') {
            throw new Error('Cannot add shipments to a sealed or dispatched box.');
        }
        if (packingBox.isFull || packingBox.status === 'FULL') throw new Error('Box is full.');

        const shipment = await resolveShipmentByRef(shipmentRef, txnSession);
        if (!shipment) throw new Error('Shipment not found.');

        const isCancelled = shipment.status === 'Cancelled' ||
            String(shipment.status || '').trim().toLowerCase() === 'cancelled' ||
            shipment.cancellationStatus === 'CANCELLED' ||
            shipment.processingStatus === 'CANCELLED';

        if (isCancelled) {
            throw new Error(`This shipment (${shipment.shipmentId || shipmentRef}) is already cancelled.`);
        }

        const destinationCountry = getShipmentDestinationCountry(shipment);
        const boxCountryCode = resolveCountryCode(packingBox.destinationCountry);
        if (!destinationCountry) throw new Error('Shipment destination country is unavailable.');
        if (!boxCountryCode) throw new Error('Selected box destination country is unavailable.');
        if (destinationCountry !== boxCountryCode) {
            throw new Error(`This shipment belongs to ${String(shipment?.consigneeDetails?.country || destinationCountry)}. The selected box is for ${String(packingBox.destinationCountry || boxCountryCode)}. Normalized: ${getCountryDisplayName(destinationCountry)} (${destinationCountry}) vs ${getCountryDisplayName(boxCountryCode)} (${boxCountryCode}).`);
        }

        // CSV IV vs CSV V category validation
        const shipCat = String(shipment.shipmentDetails?.shipmentCategory || '').trim().toLowerCase();
        const isShipmentCSBV = shipCat.includes('csb5') || shipCat.includes('csb-v') || shipCat.includes('csbv') || shipCat.includes('csb 5') || shipCat.includes('csv v') || shipCat.includes('csv5');
        const boxCategory = packingBox.category || 'CSV IV';

        if (isShipmentCSBV) {
            if (boxCategory !== 'CSV V') {
                throw new Error(`CSV V shipment (${shipment.shipmentId || shipmentRef}) cannot be packed into a ${boxCategory} box. It must be packed into a CSV V box.`);
            }
        } else {
            if (boxCategory === 'CSV V') {
                throw new Error(`CSV IV / Personal shipment (${shipment.shipmentId || shipmentRef}) cannot be packed into a CSV V box. It must be packed into a CSV IV box.`);
            }
        }

        const existingAssignment = await PackingBoxShipment.findOne({ shipment: shipment._id }).session(txnSession);
        if (existingAssignment) {
            if (existingAssignment.packingBox && existingAssignment.packingBox.toString() === packingBox._id.toString()) {
                throw new Error(`Shipment (${shipment.shipmentId || shipmentRef}) is already packed in this box.`);
            }
            throw new Error(`Shipment (${shipment.shipmentId || shipmentRef}) is already packed in another box.`);
        }

        const shipmentWeight = getShipmentWeight(shipment);
        if (shipmentWeight === null) throw new Error('Shipment weight is unavailable or invalid.');

        const boxConfig = await BoxConfig.findById(packingBox.boxConfig).session(txnSession);
        const current = await PackingBoxShipment.find({ packingBox: packingBox._id }).populate('shipment', 'shipmentDetails').session(txnSession);
        const currentShipments = Array.isArray(current) ? current : [];
        const totalShipmentWeight = currentShipments.reduce((sum, row) => sum + (getShipmentWeight(row.shipment) || 0), 0);
        const tareWeight = boxConfig?.tareWeight || 0;
        const maxGrossWeight = boxConfig?.maxGrossWeight || DEFAULT_MAX_GROSS_WEIGHT;
        const currentGrossWeight = tareWeight + totalShipmentWeight;
        const projectedGrossWeight = currentGrossWeight + shipmentWeight;

        if (projectedGrossWeight > maxGrossWeight) {
            throw new Error(`Weight limit exceeded. Current: ${currentGrossWeight} KG, Shipment: ${shipmentWeight} KG, Projected: ${projectedGrossWeight} KG, Max: ${maxGrossWeight} KG.`);
        }

        await PackingBoxShipment.create([{
            packingBox: packingBox._id,
            shipment: shipment._id,
            scannedBy,
        }], { session: txnSession });

        const receivedStatus = 'Shipment Received at Our Hub';
        shipment.status = receivedStatus;
        shipment.trackingHistory = Array.isArray(shipment.trackingHistory) ? shipment.trackingHistory : [];
        shipment.trackingHistory.push({
            status: receivedStatus,
            location: packingBox.destinationCountry || shipment.consigneeDetails?.country || 'Hub',
            timestamp: new Date(),
            description: `Shipment received and packed into box ${packingBox.boxId}.`,
        });
        if (typeof shipment.save === 'function') {
            await shipment.save({ session: txnSession });
        } else if (typeof Shipment.updateOne === 'function') {
            await Shipment.updateOne(
                { _id: shipment._id },
                {
                    $set: {
                        status: shipment.status,
                        trackingHistory: shipment.trackingHistory,
                    },
                },
                { session: txnSession }
            );
        }
        const emailPayload = {
            shipment: { ...shipment.toObject?.() ?? shipment, user: shipment.user },
            statusLabel: receivedStatus,
            actionLabel: 'Your shipment has been received at our operations hub',
        };

        if (projectedGrossWeight === maxGrossWeight) {
            packingBox.isFull = true;
            packingBox.status = 'FULL';
            packingBox.fullReason = 'WEIGHT_LIMIT';
        }
        await packingBox.save({ session: txnSession });

        if (ownSession) await txnSession.commitTransaction();
        sendShipmentStatusEmail(emailPayload).catch((err) => {
            console.error('[PackingEmail] Background status notification failed:', err.message);
        });
        return computePackingSummary(packingBox._id);
    } catch (error) {
        if (ownSession && txnSession?.abortTransaction) {
            try {
                await txnSession.abortTransaction();
            } catch (abortError) {
                void abortError;
            }
        }
        throw error;
    } finally {
        if (ownSession) txnSession.endSession();
    }
};

const removeShipmentFromBox = async ({ packingBoxId, shipmentRef, session = null }) => {
    const txnSession = session || await mongoose.startSession();
    const ownSession = !session;
    try {
        if (ownSession) txnSession.startTransaction();
        const packingBox = await PackingBox.findById(packingBoxId).session(txnSession);
        if (!packingBox) throw new Error('Packing box not found.');
        if (packingBox.status === 'SEALED' || packingBox.status === 'DISPATCHED') {
            throw new Error('Cannot remove shipments from a sealed or dispatched box.');
        }

        const shipment = await resolveShipmentByRef(shipmentRef, txnSession);
        if (!shipment) throw new Error('Shipment not found.');

        const deleted = await PackingBoxShipment.deleteOne({ packingBox: packingBox._id, shipment: shipment._id }).session(txnSession);
        if (!deleted.deletedCount) throw new Error('Shipment is not assigned to this box.');

        packingBox.isFull = false;
        if (packingBox.status === 'FULL') packingBox.status = 'OPEN';
        packingBox.fullReason = null;
        await packingBox.save({ session: txnSession });

        if (ownSession) await txnSession.commitTransaction();
        return computePackingSummary(packingBox._id);
    } catch (error) {
        if (ownSession && txnSession?.abortTransaction) {
            try {
                await txnSession.abortTransaction();
            } catch (abortError) {
                void abortError;
            }
        }
        throw error;
    } finally {
        if (ownSession) txnSession.endSession();
    }
};

const markBoxFull = async ({ packingBoxId, fullReason = 'MANUAL', sealedBy = null }) => {
    const packingBox = await PackingBox.findById(packingBoxId);
    if (!packingBox) throw new Error('Packing box not found.');
    if (packingBox.status === 'SEALED' || packingBox.status === 'DISPATCHED') {
        throw new Error('Sealed or dispatched boxes cannot be marked full.');
    }
    packingBox.isFull = true;
    packingBox.status = 'FULL';
    packingBox.fullReason = fullReason;
    packingBox.closedBy = sealedBy;
    packingBox.closedAt = new Date();
    await packingBox.save();
    return computePackingSummary(packingBox._id);
};

const reopenBox = async ({ packingBoxId, reopenedBy = null }) => {
    const packingBox = await PackingBox.findById(packingBoxId);
    if (!packingBox) throw new Error('Packing box not found.');
    if (packingBox.status === 'SEALED' || packingBox.status === 'DISPATCHED') {
        throw new Error('Sealed or dispatched boxes cannot be reopened.');
    }
    packingBox.status = 'OPEN';
    packingBox.isFull = false;
    packingBox.fullReason = null;
    packingBox.reopenedBy = reopenedBy;
    packingBox.reopenedAt = new Date();
    await packingBox.save();
    return computePackingSummary(packingBox._id);
};

const sealBox = async ({ packingBoxId, sealedBy = null }) => {
    const packingBox = await PackingBox.findById(packingBoxId);
    if (!packingBox) throw new Error('Packing box not found.');
    packingBox.status = 'SEALED';
    packingBox.sealedBy = sealedBy;
    packingBox.sealedAt = new Date();
    await packingBox.save();
    return computePackingSummary(packingBox._id);
};

const dispatchBox = async ({ packingBoxId, dispatchedBy = null }) => {
    const txnSession = await mongoose.startSession();
    try {
        txnSession.startTransaction();

        const packingBox = await PackingBox.findById(packingBoxId).populate('carrier').session(txnSession);
        if (!packingBox) throw new Error('Packing box not found.');
        if (packingBox.status !== 'SEALED' && packingBox.status !== 'FULL') {
            throw new Error('Only sealed or full boxes can be dispatched.');
        }

        const emailPayloads = [];
        const assignments = await PackingBoxShipment.find({ packingBox: packingBox._id })
            .populate({
                path: 'shipment',
                populate: { path: 'user' }
            })
            .session(txnSession);

        for (const assignment of assignments) {
            const shipment = assignment.shipment;
            if (!shipment) continue;

            const dispatchedStatus = 'Shipment Dispatched';
            shipment.status = dispatchedStatus;
            shipment.trackingHistory = Array.isArray(shipment.trackingHistory) ? shipment.trackingHistory : [];
            shipment.trackingHistory.push({
                status: dispatchedStatus,
                location: packingBox.destinationCountry || shipment.consigneeDetails?.country || 'Hub',
                timestamp: new Date(),
                description: `Shipment dispatched from box ${packingBox.boxId}.`,
            });
            await shipment.save({ session: txnSession });
            emailPayloads.push({
                shipment: { ...shipment.toObject?.() ?? shipment, user: shipment.user },
                statusLabel: dispatchedStatus,
                actionLabel: 'Your shipment has been dispatched',
            });
        }

        packingBox.status = 'DISPATCHED';
        packingBox.dispatchedBy = dispatchedBy;
        packingBox.dispatchedAt = new Date();
        await packingBox.save({ session: txnSession });

        await txnSession.commitTransaction();

        // Async non-blocking background emails for instant API response (<50ms)
        setImmediate(async () => {
            try {
                for (const payload of emailPayloads) {
                    await sendShipmentStatusEmail(payload).catch((err) =>
                        console.error('[PackingEmail] Background status email error:', err?.message)
                    );
                }
                const dispatchedShipments = assignments.map((a) => a.shipment).filter(Boolean);
                await sendCarrierDispatchNotification(packingBox, dispatchedShipments).catch((err) =>
                    console.error('[CarrierDispatchEmail] Background dispatch email error:', err?.message)
                );
            } catch (bgErr) {
                console.error('[DispatchBackgroundEmails] Async email process error:', bgErr?.message);
            }
        });

        return computePackingSummary(packingBox._id);
    } catch (error) {
        try { await txnSession.abortTransaction(); } catch (abortError) { void abortError; }
        throw error;
    } finally {
        txnSession.endSession();
    }
};

module.exports = {
    createBoxConfig,
    createPackingBox,
    addShipmentToBox,
    removeShipmentFromBox,
    markBoxFull,
    reopenBox,
    sealBox,
    dispatchBox,
    computePackingSummary,
    getShipmentWeight,
    getShipmentDestinationCountry,
    getShipmentDimensions,
    resolveCountryCode,
    getCountryDisplayName,
    CSV_V_EXCEL_HEADERS,
    buildCsvVRow,
    CSV_IV_EXCEL_HEADERS,
    buildCsvIvRow,
};
