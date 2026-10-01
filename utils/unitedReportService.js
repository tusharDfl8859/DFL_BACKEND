const xlsx = require('xlsx');
const Shipment = require('../models/Shipment');

const getCountryCodeUnited = (country) => {
    if (!country) return 'USA';
    const c = country.trim().toUpperCase();
    if (c === 'UNITED STATES' || c === 'USA' || c === 'US') return 'USA';
    if (c === 'CANADA' || c === 'CA') return 'CA';
    if (c === 'UNITED KINGDOM' || c === 'UK' || c === 'GB') return 'GB';
    if (c === 'AUSTRALIA' || c === 'AU') return 'AU';
    if (c.length === 2 || c.length === 3) return c;
    return c.substring(0, 3);
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

    if (countryCode === 'US' || countryCode === 'USA') {
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

    return state.substring(0, 2);
};

const getUnitedServiceType = (s) => {
    // 1. Direct short service code saved on shipment (e.g. PM, EX, PX, DX, EC)
    const rawCode = (s.serviceDetails?.serviceCode || s.serviceDetails?.code || s.serviceDetails?.skynetBillingCode || '').trim().toUpperCase();
    if (rawCode && rawCode.length <= 5 && !rawCode.startsWith('DFL')) {
        return rawCode;
    }

    // 2. Dynamic lookup based on service display name / provider code
    const serviceName = (s.serviceDetails?.serviceName || s.serviceDetails?.displayName || s.serviceDetails?.code || '').toUpperCase();
    if (serviceName.includes('PRIORITY') || serviceName.includes('SWIFT') || serviceName.includes('USPS') || serviceName.includes('PM')) {
        return 'PM';
    }
    if (serviceName.includes('SAVER') || serviceName.includes('ECONOMY') || serviceName.includes('STANDARD') || serviceName.includes('EX')) {
        return 'EX';
    }

    // 3. Fallback based on destination country
    const destCountry = (s.consigneeDetails?.countryCode || s.consigneeDetails?.country || '').toUpperCase();
    if (destCountry.includes('US') || destCountry === 'USA') return 'PM';

    return 'EX';
};

const generateUnitedExcel = (shipments) => {
    const headers = [
        'AwbNo',
        'ReferenceNo',
        'Origin',
        'Destination',
        'CustomerCode',
        'CustomerName',
        'ConsignorName',
        'ConsignorContactPerson',
        'ConsignorAddressLine1',
        'ConsignorAddressLine2',
        'ConsignorAddressLine3',
        'ConsignorCity',
        'ConsignorState',
        'ConsignorPincode',
        'ConsignorTelephone',
        'GSTType',
        'GSTIDNo',
        'ConsigneeName',
        'ConsigneeContactPerson',
        'ConsigneeAddressLine1',
        'ConsigneeAddressLine2',
        'ConsigneeAddressLine3',
        'ConsigneeCity',
        'ConsigneeState',
        'ConsigneeZipCode',
        'ConsigneeTelephone',
        'GoodsType',
        'ServiceType',
        'Pcs',
        'ActWeight',
        'VolWeight',
        'ChgWeight',
        'Dimention',
        'InvoiceNo',
        'InvoiceValue',
        'Currency',
        'PaymentType',
        'COD/FreightAmount',
        'Currency',
        'Description',
        'Remark',
        'CoLoader',
        'CoLoaderNo',
        'Network',
        'NetworkNo',
        'Sector',
        'RunNo'
    ];

    const rows = shipments.map(s => {
        const firstBox = s.shipmentDetails?.boxes?.[0] || {};
        const firstItem = firstBox.items?.[0] || s.shipmentDetails?.csbVItems?.[0] || {};

        const description = firstItem.productName || s.shipmentDetails?.purposeOfShipment || s.shipmentDetails?.description || 'COMMERCIAL GOODS';

        const totalWeightKg = s.serviceDetails?.chargeableWeight || s.shipmentDetails?.boxes?.reduce((acc, box) => acc + (parseFloat(box.weight) || 0), 0) || 0.5;

        const customerCode = process.env.UNITED_COURIER_ACCOUNT_CODE || s.user?.clientCode || 'DEM01';

        const destCountry = getCountryCodeUnited(s.consigneeDetails?.countryCode || s.shipmentDetails?.consigneeCountryCode || s.consigneeDetails?.country);

        const consignorState = getStateCode(s.shipperDetails?.stateCode || s.shipperDetails?.state || s.user?.kycData?.state, 'IN');
        const consigneeState = getStateCode(s.consigneeDetails?.stateCode || s.consigneeDetails?.state || s.shipmentDetails?.consigneeState, destCountry);

        const isLut = (s.shipmentDetails?.gstinType || s.user?.kycData?.gstinType || '').toLowerCase().includes('lut');
        const gstType = isLut ? 'LUT' : 'GSTIN (Normal)';

        const isParcel = s.shipmentType === 'parcel' || !s.document;
        const goodsType = isParcel ? 'NDox' : 'Dox';

        const serviceType = getUnitedServiceType(s);

        const awbNumber = s.trackingId || s.awbNumber || s.shipmentDetails?.trackingNo || s.shipmentId || '';
        const referenceNumber = s.shipmentId || s.referenceNumber || '';

        const dimensions = (firstBox.length && firstBox.width && firstBox.height)
            ? `${firstBox.length}x${firstBox.width}x${firstBox.height}`
            : (s.shipmentDetails?.dimensions || '');

        return [
            awbNumber, // 1. AwbNo (Carrier Tracking ID / AWB Number)
            referenceNumber, // 2. ReferenceNo (DFL Panel Order ID)
            'DEL', // 3. Origin
            destCountry, // 4. Destination
            customerCode, // 5. CustomerCode (DEM01)
            'DEMIRA FREIGHT LINKERS INDIA PVT.LTD.', // 6. CustomerName
            s.shipperDetails?.shipperName || s.shipperDetails?.companyName || s.user?.name || '', // 7. ConsignorName
            s.shipperDetails?.shipperName || s.shipperDetails?.companyName || s.user?.name || '', // 8. ConsignorContactPerson
            s.shipperDetails?.addressLine1 || s.shipperDetails?.address || s.user?.kycData?.address || '', // 9. ConsignorAddressLine1
            s.shipperDetails?.addressLine2 || '', // 10. ConsignorAddressLine2
            '', // 11. ConsignorAddressLine3
            s.shipperDetails?.city || s.user?.kycData?.city || 'DELHI', // 12. ConsignorCity
            consignorState, // 13. ConsignorState (e.g. MP, DL, UP)
            s.shipperDetails?.pincode || s.shipperDetails?.postalCode || s.user?.kycData?.pincode || '', // 14. ConsignorPincode
            s.shipperDetails?.mobileNo || s.shipperDetails?.phone || s.user?.mobileNo || '', // 15. ConsignorTelephone
            gstType, // 16. GSTType
            s.shipmentDetails?.gstinId || s.user?.kycData?.gstin || s.user?.kycData?.gstNumber || '', // 17. GSTIDNo
            s.consigneeDetails?.companyName || s.consigneeDetails?.consigneeName || '', // 18. ConsigneeName
            s.consigneeDetails?.consigneeName || s.consigneeDetails?.companyName || '', // 19. ConsigneeContactPerson
            s.consigneeDetails?.addressLine1 || s.consigneeDetails?.address || '', // 20. ConsigneeAddressLine1
            s.consigneeDetails?.addressLine2 || '', // 21. ConsigneeAddressLine2
            '', // 22. ConsigneeAddressLine3
            s.consigneeDetails?.city || s.shipmentDetails?.consigneeCity || '', // 23. ConsigneeCity
            consigneeState, // 24. ConsigneeState (e.g. UT, ON, NY)
            s.consigneeDetails?.pincode || s.consigneeDetails?.postalCode || '', // 25. ConsigneeZipCode
            s.consigneeDetails?.mobileNo || s.consigneeDetails?.phone || '', // 26. ConsigneeTelephone
            goodsType, // 27. GoodsType (NDox / Dox)
            serviceType, // 28. ServiceType (PM / EX dynamically resolved)
            s.shipmentDetails?.boxes?.length || 1, // 29. Pcs
            totalWeightKg, // 30. ActWeight
            totalWeightKg, // 31. VolWeight
            totalWeightKg, // 32. ChgWeight
            dimensions, // 33. Dimention (e.g. 1x1x1)
            s.shipmentDetails?.invoiceNumber || s.shipmentId || '', // 34. InvoiceNo
            s.shipmentDetails?.totalItemValue || 10, // 35. InvoiceValue
            s.shipmentDetails?.currency || 'USD', // 36. Currency
            'CREDIT', // 37. PaymentType
            0, // 38. COD/FreightAmount
            s.shipmentDetails?.currency || 'USD', // 39. Currency
            description, // 40. Description
            '', // 41. Remark
            '', // 42. CoLoader
            '', // 43. CoLoaderNo
            '', // 44. Network
            '', // 45. NetworkNo
            '', // 46. Sector
            '' // 47. RunNo
        ];
    });

    const sheetData = [headers, ...rows];
    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xls' });
};

const generateUnitedReportBuffer = async (shipmentIds) => {
    const shipments = await Shipment.find({ _id: { $in: shipmentIds } }).populate('user', 'kycData name email mobileNo clientCode');
    if (!shipments || shipments.length === 0) {
        throw new Error('No shipments found for the provided IDs.');
    }
    return generateUnitedExcel(shipments);
};

module.exports = { generateUnitedReportBuffer };
