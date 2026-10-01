const xlsx = require('xlsx');
const Shipment = require('../models/Shipment');

const formatSkynetDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
};

const getCountryISO2 = (country) => {
    if (!country) return 'US';
    const c = country.trim().toUpperCase();
    if (c.length === 2) return c;
    const countryMap = {
        'UNITED STATES': 'US',
        'USA': 'US',
        'UNITED KINGDOM': 'GB',
        'UK': 'GB',
        'GREAT BRITAIN': 'GB',
        'ITALY': 'IT',
        'GERMANY': 'DE',
        'FRANCE': 'FR',
        'CANADA': 'CA',
        'AUSTRALIA': 'AU',
        'NEW ZEALAND': 'NZ',
        'INDIA': 'IN',
        'UNITED ARAB EMIRATES': 'AE',
        'UAE': 'AE',
        'SINGAPORE': 'SG',
        'JAPAN': 'JP',
        'SPAIN': 'ES',
        'NETHERLANDS': 'NL'
    };
    return countryMap[c] || 'US';
};

const getStateCode = (stateName, countryCode = 'IN') => {
    if (!stateName) return 'DL';
    const state = stateName.trim().toUpperCase();
    if (state.length <= 3) return state;

    if (countryCode === 'IN') {
        const indianStates = {
            'ANDHRA PRADESH': 'AP', 'ARUNACHAL PRADESH': 'AR', 'ASSAM': 'AS', 'BIHAR': 'BR',
            'CHHATTISGARH': 'CG', 'GOA': 'GA', 'GUJARAT': 'GJ', 'HARYANA': 'HR',
            'HIMACHAL PRADESH': 'HP', 'JHARKHAND': 'JH', 'KARNATAKA': 'KA', 'KERALA': 'KL',
            'MADHYA PRADESH': 'MP', 'MAHARASHTRA': 'MH', 'MANIPUR': 'MN', 'MEGHALAYA': 'ML',
            'MIZORAM': 'MZ', 'NAGALAND': 'NL', 'ODISHA': 'OR', 'PUNJAB': 'PB',
            'RAJASTHAN': 'RJ', 'SIKKIM': 'SK', 'TAMIL NADU': 'TN', 'TELANGANA': 'TG',
            'TRIPURA': 'TR', 'UTTAR PRADESH': 'UP', 'UTTARAKHAND': 'UT', 'WEST BENGAL': 'WB',
            'ANDAMAN AND NICOBAR ISLANDS': 'AN', 'CHANDIGARH': 'CH',
            'DADRA AND NAGAR HAVELI': 'DN', 'DAMAN AND DIU': 'DD',
            'DELHI': 'DL', 'NEW DELHI': 'DL', 'JAMMU AND KASHMIR': 'JK', 'LADAKH': 'LA',
            'LAKSHADWEEP': 'LD', 'PUDUCHERRY': 'PY'
        };
        if (indianStates[state]) return indianStates[state];
    }

    if (countryCode === 'US') {
        const usStates = {
            'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR',
            'CALIFORNIA': 'CA', 'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE',
            'FLORIDA': 'FL', 'GEORGIA': 'GA', 'HAWAII': 'HI', 'IDAHO': 'ID',
            'ILLINOIS': 'IL', 'INDIANA': 'IN', 'IOWA': 'IA', 'KANSAS': 'KS',
            'KENTUCKY': 'KY', 'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD',
            'MASSACHUSETTS': 'MA', 'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS',
            'MISSOURI': 'MO', 'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV',
            'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
            'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH', 'OKLAHOMA': 'OK',
            'OREGON': 'OR', 'PENNSYLVANIA': 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
            'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT',
            'VERMONT': 'VT', 'VIRGINIA': 'VA', 'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV',
            'WISCONSIN': 'WI', 'WYOMING': 'WY', 'DISTRICT OF COLUMBIA': 'DC'
        };
        if (usStates[state]) return usStates[state];
    }

    if (countryCode === 'CA') {
        const caProvinces = {
            'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'MANITOBA': 'MB', 'NEW BRUNSWICK': 'NB',
            'NEWFOUNDLAND AND LABRADOR': 'NL', 'NOVA SCOTIA': 'NS', 'ONTARIO': 'ON', 'PRINCE EDWARD ISLAND': 'PE',
            'QUEBEC': 'QC', 'SASKATCHEWAN': 'SK', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU', 'YUKON': 'YT'
        };
        if (caProvinces[state]) return caProvinces[state];
    }

    if (countryCode === 'AU') {
        const auStates = {
            'NEW SOUTH WALES': 'NSW', 'VICTORIA': 'VIC', 'QUEENSLAND': 'QLD', 'WESTERN AUSTRALIA': 'WA',
            'SOUTH AUSTRALIA': 'SA', 'TASMANIA': 'TAS', 'NORTHERN TERRITORY': 'NT', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT'
        };
        if (auStates[state]) return auStates[state];
    }

    return state.substring(0, 2);
};

const getShippingServiceCode = (s, destCountryISO2) => {
    // 1. Direct billing code saved on shipment (e.g. SNPD_CA, SNPD_RM, SNPD_EV, SNPD)
    if (s.serviceDetails?.skynetBillingCode) {
        return s.serviceDetails.skynetBillingCode;
    }

    // 2. Short code saved on shipment (e.g. SNPD, PID)
    const rawCode = (s.serviceDetails?.serviceCode || s.serviceDetails?.code || '').trim().toUpperCase();
    if (rawCode && rawCode.length <= 8 && !rawCode.includes('SKYNET') && !rawCode.includes('ECOMMERCE')) {
        return rawCode;
    }

    // 3. Dynamic Country-Wise Resolution from service_config.json
    if (destCountryISO2 === 'CA') return 'SNPD_CA';
    if (destCountryISO2 === 'GB') return 'SNPD_RM';
    if (['US', 'AU', 'MY', 'SG', 'AE', 'DE', 'FR', 'IT', 'ES', 'NL', 'NZ'].includes(destCountryISO2)) return 'SNPD';

    // 4. Default fallback: 'SNPD' or 'PID'
    return 'SNPD';
};

const generateSkynetEcomExcel = (shipments) => {
    const headers = [
        'ShipmentOrderID',
        'BookingDate',
        'ClientCode',
        'ShippingServiceCode',
        'DestinationCountryCode',
        'ConsignorCompany',
        'ConsignorName',
        'ConsignorAddressLine1',
        'ConsignorAddressLine2',
        'ConsignorAddressLine3',
        'ConsignorCountryCode',
        'ConsignorPostalCode',
        'ConsignorCity',
        'ConsignorStateCode',
        'ConsignorPhoneNo',
        'ConsignorEmailID',
        'ConsignorFiscalIDType',
        'ConsignorFiscalID',
        'ConsignorGSTIN',
        'ConsignorIEC',
        'BankADCode',
        'BankAC',
        'BankIFSC',
        'ConsigneeCompany',
        'ConsigneeName',
        'ConsigneeAddressLine1',
        'ConsigneeAddressLine2',
        'ConsigneeAddressLine3',
        'ConsigneePostalCode',
        'ConsigneeCity',
        'ConsigneeStateCode',
        'ConsigneePhoneNo',
        'ConsigneeEmailID',
        'ConsigneeFiscalIDType',
        'ConsigneeFiscalID',
        'ShipmentDescription',
        'ContentCode',
        'HSCode',
        'OriginCountryCode',
        'UnitPrice',
        'Quantity',
        'ContentDescription',
        'CSBSelection',
        'TermofInvoice',
        'EXP_USING_ECOM',
        'MEIS_STATUS',
        'GSTInvoiceNo',
        'GSTInvoiceDate',
        'LUT_or_Export_Under_Bond',
        'LUTNumber',
        'CommodityUnder3C',
        'EXPORT_AGAINST_IGST',
        'IGST_AMOUNT',
        'ShipmentWeight_Gram',
        'Length',
        'Width',
        'Height',
        'CurrencyCode',
        'Incoterm'
    ];

    const rows = shipments.map(s => {
        const bookingDate = formatSkynetDate(s.createdAt || s.shipmentDetails?.invoiceDate);
        const invoiceDate = formatSkynetDate(s.shipmentDetails?.invoiceDate || s.createdAt);

        const firstBox = s.shipmentDetails?.boxes?.[0] || {};
        const firstItem = firstBox.items?.[0] || s.shipmentDetails?.csbVItems?.[0] || {};

        const description = firstItem.productName || s.shipmentDetails?.purposeOfShipment || 'COMMERCIAL GOODS';

        const totalWeightKg = s.shipmentDetails?.boxes?.reduce((acc, box) => acc + (parseFloat(box.weight) || 0), 0) || s.serviceDetails?.chargeableWeight || 0;
        const weightGrams = Math.round((parseFloat(totalWeightKg) || 0) * 1000) || 100;

        const isLut = (s.shipmentDetails?.gstinType || s.user?.kycData?.gstinType || '').toLowerCase().includes('lut');
        const csbType = (s.shipmentCategory === 'csb5' || s.csbType === 'CSB-V') ? 'CSB_5' : 'CSB_4';

        const clientCode = process.env.SKYNET_ECOMMERCE_CLIENT_CODE || s.user?.clientCode || s.user?.kycData?.clientCode || 'D1041';
        const destCountryISO2 = getCountryISO2(s.consigneeDetails?.countryCode || s.shipmentDetails?.consigneeCountryCode || s.consigneeDetails?.country);
        const serviceCode = getShippingServiceCode(s, destCountryISO2);

        const consignorStateCode = getStateCode(s.shipperDetails?.stateCode || s.shipperDetails?.state || s.user?.kycData?.state, 'IN');
        const consigneeStateCode = getStateCode(s.consigneeDetails?.stateCode || s.consigneeDetails?.state || s.shipmentDetails?.consigneeState, destCountryISO2);

        const iecNumber = s.user?.kycData?.iecNumber || s.user?.kycData?.iec || '';

        return [
            s.shipmentId || '', // 1. ShipmentOrderID
            bookingDate, // 2. BookingDate
            clientCode, // 3. ClientCode (.env: SKYNET_ECOMMERCE_CLIENT_CODE D1041)
            serviceCode, // 4. ShippingServiceCode (SNPD_CA / SNPD_RM / SNPD / PID)
            destCountryISO2, // 5. DestinationCountryCode (ISO-2 e.g. US, GB, IT, CA, AU)
            s.shipperDetails?.companyName || s.user?.kycData?.companyName || '', // 6. ConsignorCompany
            s.shipperDetails?.shipperName || s.shipperDetails?.companyName || s.user?.name || s.user?.kycData?.companyName || '', // 7. ConsignorName
            s.shipperDetails?.addressLine1 || s.shipperDetails?.address || s.user?.kycData?.address || '', // 8. ConsignorAddressLine1
            s.shipperDetails?.addressLine2 || '', // 9. ConsignorAddressLine2
            '', // 10. ConsignorAddressLine3
            s.shipperDetails?.countryCode || 'IN', // 11. ConsignorCountryCode
            s.shipperDetails?.pincode || s.shipperDetails?.postalCode || s.shipperDetails?.zipCode || s.user?.kycData?.pincode || '', // 12. ConsignorPostalCode
            s.shipperDetails?.city || s.user?.kycData?.city || '', // 13. ConsignorCity
            consignorStateCode, // 14. ConsignorStateCode (Short Form e.g. DL, UP, MH, HR)
            s.shipperDetails?.mobileNo || s.shipperDetails?.phone || s.user?.mobileNo || '', // 15. ConsignorPhoneNo
            s.shipperDetails?.email || s.user?.email || '', // 16. ConsignorEmailID
            iecNumber, // 17. ConsignorFiscalIDType (IEC Number)
            iecNumber, // 18. ConsignorFiscalID (IEC Number)
            s.shipmentDetails?.gstinId || s.user?.kycData?.gstin || s.user?.kycData?.gstNumber || '', // 19. ConsignorGSTIN
            iecNumber, // 20. ConsignorIEC (IEC Number)
            s.user?.kycData?.adCode || s.user?.kycData?.bankADCode || '', // 21. BankADCode
            s.user?.kycData?.accountNumber || s.user?.kycData?.bankAccountNumber || '', // 22. BankAC
            s.user?.kycData?.ifscCode || s.user?.kycData?.bankIfsc || '', // 23. BankIFSC
            s.consigneeDetails?.companyName || '', // 24. ConsigneeCompany
            s.consigneeDetails?.consigneeName || s.consigneeDetails?.companyName || '', // 25. ConsigneeName
            s.consigneeDetails?.addressLine1 || s.consigneeDetails?.address || '', // 26. ConsigneeAddressLine1
            s.consigneeDetails?.addressLine2 || '.', // 27. ConsigneeAddressLine2
            '', // 28. ConsigneeAddressLine3
            s.consigneeDetails?.pincode || s.consigneeDetails?.postalCode || s.consigneeDetails?.zipCode || '', // 29. ConsigneePostalCode
            s.consigneeDetails?.city || s.shipmentDetails?.consigneeCity || '', // 30. ConsigneeCity
            consigneeStateCode, // 31. ConsigneeStateCode (Short Form e.g. NY, CA, FL, ON, NSW)
            s.consigneeDetails?.mobileNo || s.consigneeDetails?.phone || '', // 32. ConsigneePhoneNo
            s.consigneeDetails?.email || '', // 33. ConsigneeEmailID
            '', // 34. ConsigneeFiscalIDType
            '', // 35. ConsigneeFiscalID
            description, // 36. ShipmentDescription
            firstItem.sku || firstItem.productCode || '', // 37. ContentCode
            firstItem.hsnCode || firstItem.hscode || '', // 38. HSCode
            'IN', // 39. OriginCountryCode
            firstItem.unitPrice || s.shipmentDetails?.totalItemValue || 0, // 40. UnitPrice
            firstItem.quantity || 1, // 41. Quantity
            description, // 42. ContentDescription
            csbType, // 43. CSBSelection (CSB_4 or CSB_5)
            'C&F', // 44. TermofInvoice
            'NO', // 45. EXP_USING_ECOM
            'YES', // 46. MEIS_STATUS
            s.shipmentDetails?.invoiceNumber || '', // 47. GSTInvoiceNo
            invoiceDate, // 48. GSTInvoiceDate
            isLut ? 'YES' : 'NO', // 49. LUT_or_Export_Under_Bond
            isLut ? (s.user?.kycData?.lutNumber || s.shipmentDetails?.lutNumber || '') : '', // 50. LUTNumber
            '', // 51. CommodityUnder3C
            'NO', // 52. EXPORT_AGAINST_IGST
            '', // 53. IGST_AMOUNT
            weightGrams, // 54. ShipmentWeight_Gram
            firstBox.length || '', // 55. Length
            firstBox.width || '', // 56. Width
            firstBox.height || '', // 57. Height
            s.shipmentDetails?.currency || 'USD', // 58. CurrencyCode
            s.shipmentDetails?.incoterms || 'DDP' // 59. Incoterm
        ];
    });

    const sheetData = [headers, ...rows];
    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'FileToImport');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const generateSkynetEcomReportBuffer = async (shipmentIds) => {
    const shipments = await Shipment.find({ _id: { $in: shipmentIds } }).populate('user', 'kycData name email mobileNo clientCode');
    if (!shipments || shipments.length === 0) {
        throw new Error('No shipments found for the provided IDs.');
    }

    const skynetShipments = shipments.filter(s => {
        const carrier = (s.serviceDetails?.carrierName || s.serviceDetails?.provider || s.carrier || '').toUpperCase();
        const service = (s.serviceDetails?.serviceName || s.serviceDetails?.serviceCode || '').toUpperCase();
        return carrier.includes('SKYNET') || service.includes('SKYNET');
    });

    const targetShipments = skynetShipments.length > 0 ? skynetShipments : shipments;

    return generateSkynetEcomExcel(targetShipments);
};

module.exports = { generateSkynetEcomReportBuffer };
