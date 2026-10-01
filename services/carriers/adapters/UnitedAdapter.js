/**
 * UnitedAdapter - United Courier API Integration
 * 
 * Implements booking, tracking, and manifest operations for United Courier.
 * Based on the provided API documentation using IP 202.66.174.36.
 */

const { BaseCarrierAdapter, CarrierAPIError } = require('./BaseCarrierAdapter');
const carrierConfig = require('../../../config/carrierConfig');
const CarrierBookingLog = require('../../../models/CarrierBookingLog');
// Optional: Use cloudinary uploader if they return base64 labels
const { uploadPDFToCloudinary } = require('../../../utils/cloudinaryUploader');

class UnitedAdapter extends BaseCarrierAdapter {
    constructor() {
        super(carrierConfig.UNITED);
        this.carrierName = 'UNITED';
    }

    /**
     * Helper to inject the persistent ValidateAccount block required for all United requests.
     */
    _getAuthPayload() {
        return {
            "ValidateAccount": [
                {
                    "AccountCode": this.config.credentials.accountCode || 'DEM01',
                    "Username": this.config.credentials.username || 'DEM01',
                    "Password": this.config.credentials.password || '2025',
                    "AccessKey": this.config.credentials.accessKey || '9F3377D6'
                }
            ]
        };
    }

    /**
     * Track a shipment with United Courier
     * @param {string} awb - AWB number
     * @returns {Promise<Object>} - Tracking details
     */
    async track(awb) {
        const payload = {
            ...this._getAuthPayload(),
            "Awbno": awb
        };

        try {
            const { data } = await this.callAPI(this.config.trackingUrl, payload);

            // Normalize United Courier data to DFL standard format
            if (data && data.length > 0) {
                const events = data[0].Event || [];
                return {
                    awb_no: awb,
                    status: data[0].StatusText || 'unknown',
                    tracking_details: events.map(event => ({
                        message: event.EventDescription,
                        location: event.Location,
                        timestamp: `${event.EventDate.split('T')[0]}T${event.EventTime}`,
                        status: event.EventCode
                    }))
                };
            }
            return { awb_no: awb, status: 'unknown', tracking_details: [] };
        } catch (error) {
            console.error('[UNITED] Tracking failed:', error.message);
            throw error;
        }
    }

    /**
     * Book a shipment with United Courier
     * @param {Object} shipment - Shipment document from MongoDB
     * @param {Object} user - User document
     * @returns {Promise<{awbNo: string, label: string, carrierRef: string}>}
     */
    async book(shipment, user) {
        const startTime = Date.now();
        let payload = null;

        try {
            // Map the shipment to United's AddShipment request structure
            // NOTE: Fields inferred from standard courier mapping. Exact names may need adjustment from PDF p1/2.
            const mappingData = this._mapToUnitedPayload(shipment, user);

            payload = {
                ...this._getAuthPayload(),
                "Shipment": [mappingData]
            };
            console.log(
    "[UNITED REQUEST PAYLOAD]",
    JSON.stringify(payload, null, 2)
);



            const { data, durationMs, attempt, httpStatus } = await this.callAPI(
                this.config.bookingUrl,
                payload
            );
console.log(
    "[UNITED RESPONSE]",
    JSON.stringify(data, null, 2)
);


            // United responses: [{ ShipmentResponses: [...], shipmentDetails: [{ AwbNo: "...", PDF: "..." }] }]
            const responseData = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0][0] : data[0]) : data;
            const shipmentResponses = responseData?.ShipmentResponses || [];
            const shipmentDetailsArr = responseData?.shipmentDetails || [];

            const shipmentResponse = shipmentResponses[0] || {};
            const detailedInfo = shipmentDetailsArr[0] || {};

            // Log detailed response if success status is not found
            const status = (shipmentResponse.Status || "").toLowerCase();
            if (status !== 'success' && status !== 'true' && shipmentResponse.Code !== '100' && shipmentResponse.Code !== '200') {
                throw new CarrierAPIError(
                    this.carrierName,
                    shipmentResponse.Description || 'Booking failed - could not find success status in response',
                    httpStatus || 200,
                    data
                );
            }

            // Extract AWB number (Now correctly looking in shipmentDetails first)
            const awbNo = detailedInfo.AwbNo ||
                detailedInfo.TrackingNo ||
                shipmentResponse.AWBNo ||
                shipmentResponse.ShipmentID ||
                responseData.AWBNo;

            if (!awbNo) {
                console.warn('[UNITED] Success status received but AWB number field is missing in shipmentDetails:', JSON.stringify(data));
            }

            // Extract PDF Label data
            let labelUrl = shipmentResponse.LabelUrl || '';
            const labelData = detailedInfo.PDF || shipmentResponse.Label || responseData.Label;

            if (labelData && !labelUrl) {
                try {
                    let pdfDataToUpload = labelData;
                    // If the labelData is actually a URL, fetch it first
                    if (typeof labelData === 'string' && labelData.startsWith('http')) {
                        const axios = require('axios');
                        const response = await axios.get(labelData, { responseType: 'arraybuffer' });
                        pdfDataToUpload = Buffer.from(response.data);
                    }

                    labelUrl = await uploadPDFToCloudinary(
                        pdfDataToUpload,
                        'united-labels',
                        `united-label-${awbNo || shipment.shipmentId}`
                    );
                    console.log(`[UNITED] Label uploaded to Cloudinary: ${labelUrl}`);
                } catch (uploadErr) {
                    console.warn(`[UNITED] Label upload failed: ${uploadErr.message}`);
                }
            }

            // Log successful booking
            await this._logBooking(shipment._id, 'BOOK', payload, data, true, null, awbNo, durationMs, attempt, httpStatus);

            return {
                awbNo: awbNo,
                label: labelData || null,
                labelUrl: labelUrl || null,
                carrierRef: awbNo
            };

        } catch (error) {
            const durationMs = Date.now() - startTime;
            await this._logBooking(
                shipment._id,
                'BOOK',
                payload,
                error.responseData || { message: error.message },
                false,
                error.message,
                null,
                durationMs,
                error.attempts || 1,
                error.statusCode || null
            );
            throw error;
        }
    }

    /**
     * Generate manifest for shipments
     * @param {Array} shipmentOrderIds - Array of United shipping IDs
     * @returns {Promise<{manifestId: string, manifestPdf: string}>}
     */
    async manifest(shipmentOrderIds, manifestDate, cdAwbNumber, courierName) {
        const payload = {
            ...this._getAuthPayload(),
            "AwbManifest": shipmentOrderIds.map(id => ({ "AwbNo": id }))
        };

        const { data } = await this.callAPI(this.config.manifestUrl, payload);

        // Manifest implementation based on PDF screenshot
        const result = Array.isArray(data) ? data[0] : data;

        if (!result || (result.Status !== 'Success' && result.Success !== true)) {
            throw new CarrierAPIError(this.carrierName, result?.Message || result?.ErrorMessage || 'Manifest failed', 200, data);
        }

        return {
            manifestId: result.ManifestID || result.ManifestId,
            manifestPdf: result.ManifestPrint || result.Label // United often uses Label/ManifestPrint for base64
        };
    }

    /**
     * Internal field mapping logic
     */
    _mapToUnitedPayload(shipment, user) {
        const { shipperDetails, consigneeDetails, shipmentDetails } = shipment;
        const boxes = shipmentDetails.boxes || [];

        // Calculate totals
        const totalWeight = boxes.reduce((sum, box) => sum + (parseFloat(box.weight) || 0), 0);
        const totalValue = parseFloat(shipmentDetails.totalItemValue) || 10;
        const totalItems = (boxes[0]?.items || []).reduce((sum, item) => sum + (parseInt(item.quantity) || 1), 0) || 1;

        const content = (boxes[0]?.items && boxes[0].items[0]?.productName) ||
            shipmentDetails.boxes[0]?.productDescription ||
            "General Goods";

        const shipmentCategory = shipmentDetails.shipmentCategory || 'personal';
        const isDocument = shipment.shipmentType === 'document';
        const isCSB5 = shipmentCategory === 'csb5';
        const isCSB4 = shipmentCategory === 'csb4';

        // Helper to get ISO country code safely
        const getCountryCode = (details) => {
            let code = details.countryCode || '';
            if (code) {
                code = code.toUpperCase();
                if (code === 'US' || code === 'USA') return 'USA';
                return code;
            }
            const country = (details.country || '').toLowerCase();
            if (country.includes('canada')) return 'CA';
            if (country.includes('india')) return 'IN';
            if (country === 'usa' || country.includes('united states')) return 'USA';
            if (country.includes('united kingdom') || country === 'uk') return 'UK';
            if (country.includes('united arab emirates') || country === 'uae') return 'UAE';
            return 'USA'; // Final fallback
        };

        const destCountryCode = getCountryCode(consigneeDetails);

        const consigneeZip = (consigneeDetails.pincode || "").replace(/\s/g, "");
        const consignorZip = (shipperDetails.pincode || "").replace(/\s/g, "");

        // Trim phone numbers - strip symbols, spaces, dashes
        const trim = (rawPhone, fallback = '') => {
            if (!rawPhone) return fallback;
            const digits = String(rawPhone).replace(/[^\d]/g, '');
            return digits ? digits : fallback;
        };

        // Determine fallback GSTIN based on consignor state/pincode to ensure state-prefix compliance
        const shipperState = (shipperDetails.state || '').toLowerCase();
        let fallbackGst = "09AGFPT3528D1ZC"; // Default to DFL UP (Noida) GSTIN
        if (shipperState.includes('delhi') || consignorZip.startsWith('11')) {
            fallbackGst = "07AACCO5243L1ZA"; // Default to Delhi GSTIN if in Delhi
        }
        const gstNumber = (user?.kycData?.gstNumber || shipment.shipmentDetails?.gstin || fallbackGst).trim();

        return {
            "CustomerCode": this.config.credentials.accountCode || 'DEM01',
            "CustomerName": user?.name || 'TEST CUSTOMER',
            "DestinationCode": getCountryCode(consigneeDetails),
            "ThirdPartyLabel": false,

            // Shipper (Consignor)
            "ConsignorName": shipperDetails.companyName || shipperDetails.shipperName,
            "ConsignorContactPerson": shipperDetails.shipperName,
            "ConsignorAddressLine1": shipperDetails.addressLine1 || "",
            "ConsignorAddressLine2": shipperDetails.addressLine2 || "",
            "ConsignorAddressLine3": "",
            "ConsignorCity": shipperDetails.city || "",
            "ConsignorPostCode": consignorZip,
            "ConsignorState": shipperDetails.state || "",
            "ConsignorPhoneNo": trim(shipperDetails.mobileNo),
            "GSTType": "GSTIN (Normal)",
            "GSTIN": gstNumber,
            "IECNumber": shipment.shipmentDetails?.iecNumber || user?.kycData?.iecNumber || "",
            "ADCode": shipment.shipmentDetails?.adCode || user?.kycData?.adCode || "",

            // Receiver (Consignee)
            "ConsigneeName": consigneeDetails.companyName || consigneeDetails.consigneeName,
            "ConsigneeContactPerson": consigneeDetails.consigneeName,
            "ConsigneeAddressLine1": consigneeDetails.addressLine1 || "",
            "ConsigneeAddressLine2": consigneeDetails.addressLine2 || "",
            "ConsigneeAddressLine3": "",
            "ConsigneeCity": consigneeDetails.city || "",
            "ConsigneeZipCode": consigneeZip,
            "ConsigneeState": consigneeDetails.state || "",
            "ConsigneePhoneNo": trim(consigneeDetails.mobileNo),

            // Shipment info
            "ServiceTypeCode": "ST01",
            "ServiceType": "STDNE",
            "NetworkCode": "USPS",
            "GoodsDesc": isDocument ? "DOCUMENTS" : "NDox",
            "NumofItems": boxes.length.toString(),
            "ActWeight": totalWeight.toFixed(3),

            "VolWeights": boxes.map(b => ({
                "ActWeight": (parseFloat(b.weight) || 0).toString(),
                "Length": (parseFloat(b.length) || 0).toString(),
                "Width": (parseFloat(b.width) || 0).toString(),
                "Height": (parseFloat(b.height) || 0).toString(),
                "Pcs": "1"
            })),

            "CustomsValue": totalValue.toFixed(2),
            "CustomsCurrencyCode": shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
            "ShipmentContent": isDocument ? "DOCUMENTS" : "BAG",

            "ItemDetails": (boxes[0]?.items || []).map((item, index) => ({
                "BoxNo": "1",
                "Description": item.productName || item.description || "General Goods",
                "HSNCode": item.hsnCode || "123456",
                "Qty": parseInt(item.quantity || 1),
                "Rate": parseFloat(item.unitPrice || 10),
                "Amount": parseFloat((item.unitPrice || 10) * (item.quantity || 1)),
                "Currency": shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
                "Unit": "PCS",
                "ShipPieceIGST": parseFloat(item.igst || 0),
                "PieceWt": ((parseFloat(boxes[0]?.weight) || totalWeight) / totalItems).toFixed(3),
                "CESS": "0"
            })).length > 0 ? (boxes[0]?.items || []).map((item, index) => ({
                "BoxNo": "1",
                "Description": item.productName || item.description || "General Goods",
                "HSNCode": item.hsnCode || "123456",
                "Qty": parseInt(item.quantity || 1),
                "Rate": parseFloat(item.unitPrice || 10),
                "Amount": parseFloat((item.unitPrice || 10) * (item.quantity || 1)),
                "Currency": shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
                "Unit": "PCS",
                "ShipPieceIGST": parseFloat(item.igst || 0),
                "PieceWt": ((parseFloat(boxes[0]?.weight) || totalWeight) / totalItems).toFixed(3),
                "CESS": "0"
            })) : [
                {
                    "BoxNo": "1",
                    "Description": content || "General Goods",
                    "HSNCode": "123456",
                    "Qty": 1,
                    "Rate": parseFloat(totalValue),
                    "Amount": parseFloat(totalValue),
                    "Currency": shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
                    "Unit": "PCS",
                    "ShipPieceIGST": 0,
                    "PieceWt": totalWeight.toFixed(3),
                    "CESS": "0"
                }
            ],

            "CSB_Type": isCSB5 ? "CSB 5" : "CSB 4",
            "TermsOfSale": isCSB5 ? (shipmentDetails.invoice?.paymentTerms || "CIF") : "CIF",
            "ShipPurpose": "SAMPLE",
            "EComm": "No",
            "ExporterType": "NA",
            "ExporterInvDate": shipmentDetails.invoiceNumber ? new Date().toLocaleDateString('en-GB') : "",
            "ExporterInvNo": shipmentDetails.invoiceNumber && shipmentDetails.invoiceNumber !== 'NOT_PROVIDED' ? shipmentDetails.invoiceNumber : "",
            "IGSTPayment": "NA",
            "IGSTAmount": "0",
            "FreightCharge": "0",
            "InsuranceCharge": "0",
            "ReferenceNumber": shipment.shipmentId || "",
            "PackageType": "OTHER PACKAGING",
            "MEIS": "No",
            "DutyTaxPaid": "",
            "DutiesAccountNo": "",
            "ForwarderService": "ECONOMY-USPS",
            "InsuredValue": "0",
            "ADCode": shipment.shipmentDetails?.adCode || user?.kycData?.adCode || "",
            "IECNumber": shipment.shipmentDetails?.iecNumber || user?.kycData?.iecNumber || "",
            "ACCOUNT_NO": "",
            "GOV_NONGOV_TYPE": "N",
            "NFEI_FLAG": "N"
        };
    }

    /**
     * Log booking to DB
     */
    async _logBooking(shipmentId, action, request, response, success, errorMessage, awbNo, durationMs, attempts, httpStatus) {
        try {
            const log = new CarrierBookingLog({
                shipment: shipmentId,
                carrier: this.carrierName,
                action,
                request,
                response,
                success,
                errorMessage,
                awbNo,
                durationMs,
                attempts,
                httpStatus
            });
            await log.save();
        } catch (err) {
            console.error('Failed to log United booking:', err.message);
        }
    }
}

module.exports = UnitedAdapter;
