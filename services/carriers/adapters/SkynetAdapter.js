const { BaseCarrierAdapter, CarrierAPIError } = require('./BaseCarrierAdapter');
const carrierConfig = require('../../../config/carrierConfig');
const CarrierBookingLog = require('../../../models/CarrierBookingLog');
const { uploadPDFToCloudinary } = require('../../../utils/cloudinaryUploader');
const { generateShippingLabel } = require('../../../utils/labelGenerator');
const serviceConfig = require('../../../config/service_config.json');

// Dynamically generate Country code to ISO mapping from service config
const COUNTRY_CODES = {
    'United States': 'US', 'USA': 'US', 'United States of America': 'US',
    'United Kingdom': 'GB', 'UK': 'GB', 'Great Britain': 'GB',
    'UAE': 'AE', 'United Arab Emirates': 'AE'
};

for (const carrier in serviceConfig) {
    if (serviceConfig[carrier].services) {
        serviceConfig[carrier].services.forEach(svc => {
            if (svc.country && svc.countryCode) {
                COUNTRY_CODES[svc.country] = svc.countryCode;
                COUNTRY_CODES[svc.country.toUpperCase()] = svc.countryCode;
            }
        });
    }
}


class SkynetAdapter extends BaseCarrierAdapter {
    constructor(configKey = 'SKYNET') {
        super(carrierConfig[configKey]);
        this.carrierName = configKey;
    }

    _getCleanHsn(hsnCode, destCountryCode = '', weightKg = 1) {
        if (!hsnCode) return '99999999';
        let rawHsn = hsnCode.toString().trim();

        const isUnder1Kg = parseFloat(weightKg || 0) < 1;
        const isEcommerce = this.carrierName === 'SKYNET-ECOMMERCE';

        if (isEcommerce && isUnder1Kg) {
            // Pad to 10 digits for Skynet Ecommerce under 1 KG (any country)
            return rawHsn.padStart(10, '0');
        } else {
            // For all other cases, strip leading '00' if it is 10 digits
            if (rawHsn.length === 10 && rawHsn.startsWith('00')) {
                return rawHsn.substring(2);
            }
            return rawHsn;
        }
    }

    /**
     * Retrieve dynamic token from Skynet token API
     */
    async updateToken() {
        if (this.carrierName !== 'SKYNET') {
            return; // E-commerce uses a static token
        }

        try {
            const email = (this.config.credentials.email || process.env.SKYNET_EMAIL || '').trim();
            const password = (this.config.credentials.password || process.env.SKYNET_PASSWORD || '').trim();

            console.log(`[SKYNET] Fetching dynamic token for ${email}...`);
            const axios = require('axios');
            const response = await axios.post('https://skylink.skynetww.com/docket_api/get_token', {
                email,
                password
            }, {
                timeout: 10000
            });

            if (response.data && response.data.success && response.data.data && response.data.data.token) {
                const newToken = response.data.data.token;
                this.config.credentials.token = newToken;
                console.log('[SKYNET] Dynamic token updated successfully.');
            } else {
                const errMsg = response.data?.errors?.join(', ') || response.data?.Message || 'Invalid response format';
                throw new Error(errMsg);
            }
        } catch (error) {
            console.error('[SKYNET] Failed to fetch dynamic token:', error.message);
            if (!this.config.credentials.token) {
                throw new Error(`[SKYNET] Token generation failed: ${error.message}`);
            }
            console.warn('[SKYNET] Falling back to existing/static token.');
        }
    }

    /**
     * Book a shipment with Skynet
     * @param {Object} shipment - Shipment document from MongoDB
     * @param {Object} user - User document (for KYC data)
     * @returns {Promise<{awbNo: string, label: string, carrierRef: string}>}
     */
    async book(shipment, user) {
        const startTime = Date.now();
        let payload = null;

        try {
            // Fetch token dynamically if standard Skynet
            if (this.carrierName === 'SKYNET') {
                await this.updateToken();
            }

            // Map shipment to Skynet payload
            payload = this._mapToSkynetPayload(shipment, user);

            // Make API call
            const options = {};
            if (this.config.credentials.token) {
                options.headers = {
                    'Authorization': `Bearer ${this.config.credentials.token}`
                };
            }

            const { data: rawData, durationMs, attempt, httpStatus } = await this.callAPI(
                this.config.bookingUrl,
                payload,
                options
            );

            const data = (rawData && rawData.data && rawData.success !== false) ? rawData.data : rawData;

            // Determine if the response is a success based on various Skynet formats
            const isSuccess = data.Status === 'SUCCESS' || !!data.awb_no || !!data.AWBNo || !!data.SkynetAWBNo;

            // Check for logical success
            if (!isSuccess) {
                const errorMessage = data.Message || (rawData.errors && rawData.errors[0]) || 'Booking failed';
                console.error(`[SKYNET] API Error: ${errorMessage}`);
                throw new CarrierAPIError(
                    this.carrierName,
                    `[SKYNET API ERROR] ${errorMessage}`,
                    httpStatus || 200,
                    data
                );
            }

            // Extract AWB across different formats
            const resolvedAwb = data.AWBNo || data.awb_no || data.SkynetAWBNo || data.ShipmentOrderID;

            // Log successful booking
            await this._logBooking(shipment._id, 'BOOK', payload, data, true, null, resolvedAwb, durationMs, attempt, httpStatus);

            let labelUrl = null;
            // If Skynet returned a base64-encoded PDF label, upload it to Cloudinary
            if (data.Label) {
                try {
                    let pdfDataToUpload = data?.Label;
                    if (typeof data?.Label === 'string' && data?.Label.startsWith('http')) {
                        const axios = require('axios');
                        const response = await axios.get(data?.Label, { responseType: 'arraybuffer' });
                        pdfDataToUpload = Buffer.from(response.data);
                    }
                    labelUrl = await uploadPDFToCloudinary(pdfDataToUpload, 'skynet-labels', `skynet-label-${resolvedAwb || shipment.shipmentId}`);
                } catch (uploadErr) {
                    console.error(`[SKYNET] Label upload to Cloudinary failed: ${uploadErr.message}. Storing raw label reference.`);
                    labelUrl = null;
                }
            } else {
                // Skynet didn't return a label. Generate DFL label on the fly and upload it to Cloudinary!
                try {
                    const pdfBuffer = await generateShippingLabel(shipment);
                    const base64Label = pdfBuffer.toString('base64');
                    labelUrl = await uploadPDFToCloudinary(base64Label, 'skynet-labels', `dfl-skynet-label-${resolvedAwb || shipment.shipmentId}`);
                } catch (genErr) {
                    console.error(`[SKYNET] Failed to generate/upload DFL fallback label: ${genErr.message}`);
                }
            }

            return {
                awbNo: resolvedAwb,
                forwardingNo: data.ForwardingNo || data.forwarding_no || null,
                label: data.Label || null,
                encodedLabel: data.Label || null,
                labelUrl: labelUrl,
                carrierRef: resolvedAwb,
                message: data.Message || 'Booking successful'
            };

        } catch (error) {
            // Log failed booking WITH the request payload for debugging
            const durationMs = Date.now() - startTime;
            const httpStatus = error.httpStatus || error.statusCode || null;
            const isCarrierError = error instanceof CarrierAPIError;
            const errorResponse = isCarrierError ? error.responseData : (error.responseData || { message: error.message });

            let failedAwb = null;
            if (errorResponse) {
                failedAwb = errorResponse.AWBNo || errorResponse.awb_no || errorResponse.SkynetAWBNo || errorResponse.ShipmentOrderID || null;
            }

            await this._logBooking(
                shipment._id,
                'BOOK',
                payload,  // Now properly captures the payload even on error
                errorResponse,
                false,
                `[SKYNET] ${error.message}`,
                failedAwb,
                durationMs,
                error.attempts || 1,
                httpStatus
            );

            throw error;
        }
    }

    /**
     * Track a shipment with Skynet
     * @param {string} awbNo - AWB number
     * @returns {Promise<Object>} - Tracking details
     */
    async track(awbNo) {
        if (this.carrierName === 'SKYNET') {
            await this.updateToken();
        }

        const payload = {
            Token: this.config.credentials.token,
            ClientToken: this.config.credentials.token,
            ClientCode: this.config.credentials.clientCode,
            ShipmentOrderID: awbNo
        };

        const { data } = await this.callAPI(this.config.trackingUrl, payload);

        if (data.Status === 'ERROR') {
            throw new CarrierAPIError(this.carrierName, data.Message, 200, data);
        }

        return data;
    }

    /**
     * Generate manifest for shipments
     * @param {Array} shipmentOrderIds - Array of Skynet order IDs
     * @param {string} manifestDate - Date in DD-MMM-YYYY format
     * @param {string} cdAwbNumber - Local courier AWB
     * @param {string} courierName - Local courier name
     * @returns {Promise<{manifestId: string, manifestPdf: string}>}
     */
    async manifest(shipmentOrderIds, manifestDate, cdAwbNumber, courierName) {
        if (this.carrierName === 'SKYNET') {
            await this.updateToken();
        }

        const payload = {
            Token: this.config.credentials.token,
            UserID: this.config.credentials.userId,
            Password: this.config.credentials.password,
            Client: this.config.credentials.clientCode,
            ManifestDate: manifestDate,
            CD_AWBNumber: cdAwbNumber,
            CourierName: courierName,
            ShipmentOrderIDLists: shipmentOrderIds.map(id => ({ ShipmentOrderID: id }))
        };

        const { data } = await this.callAPI(this.config.manifestUrl, payload);

        if (data.Status !== 'SUCCESS') {
            throw new CarrierAPIError(this.carrierName, data.Message, 200, data);
        }

        return {
            manifestId: data.ManifestID,
            manifestPdf: data.ManifestPrint
        };
    }

    /**
     * Map DFL Shipment model to Skynet API payload
     * @private
     */
    _mapToSkynetPayload(shipment, user) {
        const { shipperDetails, consigneeDetails, shipmentDetails, serviceDetails = {} } = shipment;
        const boxes = shipmentDetails.boxes || [];

        // Determine CSB type
        let csbType = 'CSB-4';
        if (shipmentDetails.shipmentCategory === 'csb5') {
            csbType = 'CSB-5';
        } else if (shipmentDetails.shipmentCategory === 'personal' || shipmentDetails.shipmentCategory === 'gift') {
            csbType = 'CSB-4';
        }

        const billingCode = this._getBillingServiceCode(shipment);
        const shipmentType = (shipment.shipmentType === 'parcel' || !shipment.document) ? 'SPX' : 'DOX';

        console.log(`[SKYNET] Resolved CSBType: ${csbType}, BillingService: ${billingCode}, Type: ${shipmentType}`);

        // Get destination country code
        const destCountry = consigneeDetails.country || '';
        const destCountryCode = COUNTRY_CODES[destCountry] || destCountry.substring(0, 2).toUpperCase();

        const isEcommerce = this.carrierName === 'SKYNET-ECOMMERCE';

        /**
         * Strip a phone number to digits only, removing country code prefix.
         * E.g.  "+1 571-430-9086" -> "5714309086"
         *        "+919694061897"  -> "9694061897" (strips Indian +91)
         * Falls back to '9999999999' if result is < 10 digits.
         */
        // Trim phone numbers - strip symbols, spaces, dashes
        const trim = (rawPhone, fallback = '') => {
            if (!rawPhone) return fallback;
            const digits = String(rawPhone).replace(/[^\d]/g, '');
            return digits ? digits : fallback;
        };

        // Calculate total weight and pieces
        // Calculate total weight and pieces
        const totalWeight = boxes.reduce((sum, box) => {
            return sum + (parseFloat(box.weight) || 0);
        }, 0);
        const totalPieces = boxes.length;

        // ECOMMERCE SPECIFIC PAYLOAD (PascalCase - api.skynetww.com)
        if (isEcommerce) {
            // Map Content Details & Weight Details (Dimensions)
            let contentDetails = [];
            let weightDetails = [];
            boxes.forEach(box => {
                const boxItems = box.items || [];
                const boxLength = parseFloat(box.length) || 0;
                const boxWidth = parseFloat(box.width) || 0;
                const boxHeight = parseFloat(box.height) || 0;

                const currentBoxWeightDetails = {
                    Weight: String(parseFloat(box.weight) || 1),
                    Length: String(boxLength < 2 ? 10 : boxLength),
                    length: String(boxLength < 2 ? 10 : boxLength),
                    Breadth: String(boxWidth < 2 ? 10 : boxWidth),
                    Width: String(boxWidth < 2 ? 10 : boxWidth),
                    width: String(boxWidth < 2 ? 10 : boxWidth),
                    Height: String(boxHeight < 2 ? 10 : boxHeight),
                    height: String(boxHeight < 2 ? 10 : boxHeight),
                    ItemDescriptionDetails: []
                };

                if (boxItems.length > 0) {
                    boxItems.forEach(item => {
                        const itemDetail = {
                            Description: (item.productName || box.productDescription || 'General Goods').substring(0, 255),
                            HSNNo: this._getCleanHsn(item.hsnCode || box.hsnCode, destCountryCode, box.weight).substring(0, 30),
                            UOM: 'PCS',
                            Unit: String(parseFloat(item.quantity) || 1),
                            UnitValue: String(parseFloat(item.unitPrice) || 10)
                        };
                        currentBoxWeightDetails.ItemDescriptionDetails.push(itemDetail);

                        contentDetails.push({
                            ShipmentDescription: itemDetail.Description,
                            ContentCode: item.contentCode || shipmentDetails.contentCode || '10001',
                            HSCode: itemDetail.HSNNo,
                            OriginCountry: item.originCountry || shipperDetails.countryCode || 'IN',
                            UnitPrice: itemDetail.UnitValue,
                            Quantity: itemDetail.Unit,
                            ContentDescription: itemDetail.Description
                        });
                    });
                } else {
                    // Fallback for old box structure
                    const itemDetail = {
                        Description: (box.productDescription || 'General Goods').substring(0, 255),
                        HSNNo: this._getCleanHsn(box.hsnCode, destCountryCode, box.weight).substring(0, 30),
                        UOM: 'PCS',
                        Unit: String(parseFloat(box.productQuantity) || 1),
                        UnitValue: String(parseFloat(box.productUnitValue || box.productValue) || 10)
                    };
                    currentBoxWeightDetails.ItemDescriptionDetails.push(itemDetail);

                    contentDetails.push({
                        ShipmentDescription: itemDetail.Description,
                        ContentCode: box.contentCode || shipmentDetails.contentCode || '10001',
                        HSCode: itemDetail.HSNNo,
                        OriginCountry: box.originCountry || shipperDetails.countryCode || 'IN',
                        UnitPrice: itemDetail.UnitValue,
                        Quantity: itemDetail.Unit,
                        ContentDescription: itemDetail.Description
                    });
                }
                weightDetails.push(currentBoxWeightDetails);
            });


            const kycData = user?.kycData || {};
            const today = new Date();
            const invoiceDate = this._formatDate(today);

            return {
                Token: this.config.credentials.token,
                UserID: this.config.credentials.userId,
                Password: this.config.credentials.password,
                Client: this.config.credentials.clientCode,

                ShipmentOrderID: shipment.shipmentId || `DFL${Date.now()}`,
                BookingDate: invoiceDate,
                ShippingServiceCode: billingCode,
                DestinationCountry: destCountryCode,

                // Consignor Details
                ConsignorCompany: (shipperDetails.companyName || shipperDetails.shipperName || 'DFL Shipper').substring(0, 100),
                ConsignorName: (shipperDetails.shipperName || 'DFL Shipper').substring(0, 50),
                ConsignorAddressLine1: (shipperDetails.address1 || shipperDetails.addressLine1 || 'Default Address').substring(0, 30),
                ConsignorAddressLine2: (shipperDetails.address2 || shipperDetails.addressLine2 || '.').substring(0, 30),
                ConsignorAddressLine3: (shipperDetails.address3 || '').substring(0, 30),
                ConsignorPostalCode: (shipperDetails.pincode || '110016').substring(0, 15),
                ConsignorCity: (shipperDetails.city || 'New Delhi').substring(0, 50),
                ConsignorState: this._getStateCode(shipperDetails.state || 'Delhi', shipperDetails.countryCode || 'IN').substring(0, 10),
                ConsignorCountryCode: shipperDetails.countryCode || 'IN',
                ConsignorCountry: shipperDetails.countryCode || 'IN',
                ConsignorPhoneNo: trim(shipperDetails.mobileNo).substring(0, 15),
                ConsignorEmailID: (shipperDetails.email || user?.email || 'noreply@dfl.com').substring(0, 150),
                ConsignorGSTIN: (shipmentDetails.gstinId || kycData.gstNumber || '07ABCDE1234F1Z5').substring(0, 15),
                ConsignorIEC: (shipmentDetails.iecNumber || kycData.iecNumber || '0123456789').substring(0, 10),
                ConsignorPan: (shipmentDetails.panNumber || kycData.panNumber || 'ABCDE1234F').substring(0, 10),

                // Shipper Details (For Skynet Panel)
                ShipperCompany: (shipperDetails.companyName || shipperDetails.shipperName || 'DFL Shipper').substring(0, 100),
                ShipperCompanyName: (shipperDetails.companyName || shipperDetails.shipperName || 'DFL Shipper').substring(0, 100),
                ShipperName: (shipperDetails.shipperName || 'DFL Shipper').substring(0, 50),
                ShipperAddressLine1: (shipperDetails.address1 || shipperDetails.addressLine1 || 'Default Address').substring(0, 30),
                ShipperAddressLine2: (shipperDetails.address2 || shipperDetails.addressLine2 || '.').substring(0, 30),
                ShipperAddressLine3: (shipperDetails.address3 || '').substring(0, 30),
                ShipperPostalCode: (shipperDetails.pincode || '110016').substring(0, 15),
                ShipperZipCode: (shipperDetails.pincode || '110016').substring(0, 15),
                ShipperCity: (shipperDetails.city || 'New Delhi').substring(0, 50),
                ShipperState: this._getStateCode(shipperDetails.state || 'Delhi', shipperDetails.countryCode || 'IN').substring(0, 10),
                ShipperCountryCode: shipperDetails.countryCode || 'IN',
                ShipperCountry: shipperDetails.countryCode || 'IN',
                ShipperPhoneNo: trim(shipperDetails.mobileNo).substring(0, 15),
                ShipperContactNo: trim(shipperDetails.mobileNo).substring(0, 15),
                ShipperEmailID: (shipperDetails.email || user?.email || 'noreply@dfl.com').substring(0, 150),
                ShipperEmail: (shipperDetails.email || user?.email || 'noreply@dfl.com').substring(0, 150),
                ShipperGSTIN: (shipmentDetails.gstinId || kycData.gstNumber || '07ABCDE1234F1Z5').substring(0, 15),
                ShipperIEC: (shipmentDetails.iecNumber || kycData.iecNumber || '0123456789').substring(0, 10),
                ShipperPan: (shipmentDetails.panNumber || kycData.panNumber || 'ABCDE1234F').substring(0, 10),

                BankADCode: (shipmentDetails.adCode || kycData.adCode || '00000000000000').substring(0, 50),
                BankAccount: (shipmentDetails.accountNo || kycData.bankAccountNumber || '1234567890').substring(0, 100),
                BankIFSC: (shipmentDetails.ifscCode || kycData.ifscCode || 'ICIC0000001').substring(0, 11),

                KycDocumentType: this._getKycDocType(kycData) === 'AADHAAR NUMBER' ? 'AADHAAR' : (this._getKycDocType(kycData) === 'PAN NUMBER' ? 'PAN' : 'PASSPORT'),
                DocumentNo: (shipmentDetails.panNumber || kycData.panNumber || kycData.aadharNumber || 'ABCDE1234F').substring(0, 15),

                ConsignorFiscalIDType: 'PAN NUMBER',
                ConsignorFiscalID: (shipmentDetails.panNumber || kycData.panNumber || 'ABCDE1234F').substring(0, 10),

                // Consignee Details
                ConsigneeCompany: (consigneeDetails.companyName || consigneeDetails.consigneeName || 'Valued Customer').substring(0, 100),
                ConsigneeName: (consigneeDetails.consigneeName || 'Valued Customer').substring(0, 50),
                ConsigneeAddressLine1: (consigneeDetails.addressLine1 || consigneeDetails.address1 || 'Address Line 1').substring(0, 100),
                ConsigneeAddressLine2: (consigneeDetails.addressLine2 || consigneeDetails.address2 || '.').substring(0, 100),
                ConsigneeAddressLine3: (consigneeDetails.addressLine3 || consigneeDetails.address3 || '').substring(0, 100),
                ConsigneePostalCode: (consigneeDetails.pincode || '').substring(0, 15),
                ConsigneeCity: (consigneeDetails.city || 'City').substring(0, 50),
                ConsigneeState: this._getStateCode(consigneeDetails.state || consigneeDetails.city || 'State', destCountryCode).substring(0, 10),
                ConsigneePhoneNo: trim(consigneeDetails.mobileNo).substring(0, 15),
                ConsigneeEmailID: (consigneeDetails.email || 'noreply@dfl.com').substring(0, 150),

                CurrencyCode: (shipmentDetails.currency || (shipment.invoice && shipment.invoice.currency) || (destCountryCode === 'US' ? 'USD' : 'INR')).toUpperCase(),
                CSBSelection: csbType.replace('-', '_'),
                TermofInvoice: shipmentDetails.incoterm || 'DDP',
                WhetherExportUsingEcommerce: (shipmentDetails.shipmentCategory === 'csb4' || shipmentDetails.shipmentCategory === 'csb5') ? 'YES' : 'NO',
                WhetherUnderMEISScheme: shipmentDetails.shipmentCategory === 'csb5' ? 'YES' : 'NO',

                GSTInvoiceNo: shipmentDetails.invoiceNumber || shipment.shipmentId || `INV${Date.now()}`,
                GSTInvoiceDate: invoiceDate,
                NonGSTInvoiceNo: '',
                NonGSTInvoiceDate: '',
                TotalIGSTPaid: '0',
                WhetherAgainstBondorLUT: (shipmentDetails.shipmentCategory === 'csb5' || shipmentDetails.shipmentCategory === 'csb4') ? 'YES' : 'NO',
                CommodityUnder3C: shipmentDetails.shipmentCategory === 'csb5' ? 'YES' : 'NO',
                LUTNumber: kycData.lutNumber || shipmentDetails.lutNumber || '',
                PlIndicate: (shipmentDetails.shipmentCategory === 'csb5' || shipmentDetails.shipmentCategory === 'csb4') ? 'YES' : 'NO',

                ShipmentWeight: String(Math.round(totalWeight * 1000)), // Grams
                Length: String(parseFloat(boxes[0]?.length) < 2 ? 10 : (parseFloat(boxes[0]?.length) || 10)),
                length: String(parseFloat(boxes[0]?.length) < 2 ? 10 : (parseFloat(boxes[0]?.length) || 10)),
                Breadth: String(parseFloat(boxes[0]?.width) < 2 ? 10 : (parseFloat(boxes[0]?.width) || 10)),
                Width: String(parseFloat(boxes[0]?.width) < 2 ? 10 : (parseFloat(boxes[0]?.width) || 10)),
                width: String(parseFloat(boxes[0]?.width) < 2 ? 10 : (parseFloat(boxes[0]?.width) || 10)),
                Height: String(parseFloat(boxes[0]?.height) < 2 ? 10 : (parseFloat(boxes[0]?.height) || 10)),
                height: String(parseFloat(boxes[0]?.height) < 2 ? 10 : (parseFloat(boxes[0]?.height) || 10)),
                Incoterm: shipmentDetails.incoterm || 'DDP',
                ShipmentContentDetails: contentDetails,
                WeightDetails: weightDetails
            };
        }


        // STANDARD SKYNET SPECIFIC PAYLOAD (snake_case)
        let totalInvoiceValue = 0;
        boxes.forEach(box => {
            const boxItems = box.items || [];
            if (boxItems.length > 0) {
                boxItems.forEach(item => {
                    const qty = parseFloat(item.quantity) || 1;
                    const val = parseFloat(item.unitPrice) || 0;
                    totalInvoiceValue += (qty * val);
                });
            } else {
                const qty = parseFloat(box.productQuantity) || 1;
                const val = parseFloat(box.productUnitValue) || 0;
                totalInvoiceValue += (qty * val);
            }
        });

        // Get KYC document info from user
        const kycData = user?.kycData || {};
        const docType = this._getKycDocType(kycData);
        let docNo = '';
        if (docType === 'AADHAAR NUMBER') docNo = kycData.aadharNumber || '';
        else if (docType === 'PAN') docNo = kycData.panNumber || '';
        else if (docType === 'PASSPORT') docNo = kycData.passportNumber || '';
        if (!docNo) docNo = kycData.aadharNumber || kycData.panNumber || '123456781234';

        // Format dates in IST
        const today = new Date();
        const bookingDate = this._formatDateYYYYMMDD(today);

        // Time in IST
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kolkata',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        let bookingTime;
        try {
            const timeParts = timeFormatter.formatToParts(today);
            const h = timeParts.find(p => p.type === 'hour').value;
            const m = timeParts.find(p => p.type === 'minute').value;
            const s = timeParts.find(p => p.type === 'second').value;
            bookingTime = `${h === '24' ? '00' : h}:${m}:${s}`;
        } catch (e) {
            bookingTime = today.toTimeString().split(' ')[0];
        }

        // Construct docket_items array
        const docketItems = boxes.map(box => {
            const boxWeight = parseFloat(box.weight) || 0;
            const boxLength = parseFloat(box.length) || 0;
            const boxWidth = parseFloat(box.width) || 0;
            const boxHeight = parseFloat(box.height) || 0;
            return {
                actual_weight: String(boxWeight),
                length: String(boxLength < 2 ? 10 : boxLength),
                width: String(boxWidth < 2 ? 10 : boxWidth),
                height: String(boxHeight < 2 ? 10 : boxHeight),
                number_of_boxes: "1"
            };
        });

        // Construct free_form_line_items array
        const freeFormLineItems = [];
        boxes.forEach((box, boxIndex) => {
            const boxNo = String(boxIndex + 1);
            const boxItems = box.items || [];
            if (boxItems.length > 0) {
                boxItems.forEach(item => {
                    const qty = parseFloat(item.quantity) || 1;
                    const val = parseFloat(item.unitPrice) || 0;
                    freeFormLineItems.push({
                        total: String(qty * val),
                        no_of_packages: "1",
                        box_no: boxNo,
                        rate: String(val),
                        hscode: this._getCleanHsn(item.hsnCode || box.hsnCode, destCountryCode, box.weight),
                        description: item.productName || box.productDescription || 'General Goods',
                        unit_of_measurement: 'Pc',
                        unit_weight: String((parseFloat(box.weight) || 1) / boxItems.length),
                        igst_amount: item.igst ? parseFloat(item.igst).toFixed(2) : "0.00"
                    });
                });
            } else {
                // Fallback for old box structure
                const qty = parseFloat(box.productQuantity) || 1;
                const val = parseFloat(box.productUnitValue) || 0;
                freeFormLineItems.push({
                    total: String(qty * val),
                    no_of_packages: "1",
                    box_no: boxNo,
                    rate: String(val),
                    hscode: this._getCleanHsn(box.hsnCode, destCountryCode, box.weight),
                    description: box.productDescription || 'General Goods',
                    unit_of_measurement: 'Pc',
                    unit_weight: String(parseFloat(box.weight) || 1),
                    igst_amount: "0.00"
                });
            }
        });

        // Construct multiple_invoice array
        const multipleInvoice = (shipmentDetails.multipleInvoice || shipment.multipleInvoice || shipment.multiple_invoice || []).map(inv => ({
            mul_invoice_date: this._formatDateYYYYMMDD(inv.mul_invoice_date || inv.invoiceDate || today),
            mul_invoice_no: inv.mul_invoice_no || inv.invoiceNo || '',
            mul_order_no: inv.mul_order_no || inv.orderNo || '',
            mul_currecny: inv.mul_currecny || inv.currency || shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
            mul_invoice_amount: String(inv.mul_invoice_amount || inv.invoiceAmount || totalInvoiceValue || 0),
            mul_eway_bill: inv.mul_eway_bill || inv.ewayBill || ''
        }));

        if (multipleInvoice.length === 0) {
            multipleInvoice.push({
                mul_invoice_date: this._formatDateYYYYMMDD(shipmentDetails.invoiceDate || today),
                mul_invoice_no: shipmentDetails.invoiceNumber || shipment.shipmentId || '',
                mul_order_no: shipmentDetails.referenceNumber || shipment.shipmentId || '',
                mul_currecny: shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
                mul_invoice_amount: String(totalInvoiceValue),
                mul_eway_bill: ''
            });
        }

        return {
            // Authentication credentials (supports both structures)
            Token: this.config.credentials.token,
            UserID: this.config.credentials.userId,
            Password: this.config.credentials.password,
            Client: this.config.credentials.clientCode,
            token: this.config.credentials.token,
            user_id: this.config.credentials.userId,
            password: this.config.credentials.password,
            client: this.config.credentials.clientCode,

            // Root level fields
            tracking_no: shipment.carrierBookingId || shipment.trackingNumber || "",
            reference_name: shipmentDetails.referenceNumber || shipment.shipmentId || "TEST NAME",
            origin_code: shipperDetails.countryCode || "IN",
            product_code: shipmentType === 'SPX' ? 'NONDOX' : 'DOX',
            destination_code: destCountryCode,
            booking_date: bookingDate,
            booking_time: bookingTime,
            pcs: String(totalPieces),
            shipment_value: String(totalInvoiceValue),
            shipment_value_currency: shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
            actual_weight: String(totalWeight),
            shipment_invoice_no: shipmentDetails.invoiceNumber || shipment.shipmentId || "",
            shipment_invoice_date: this._formatDateYYYYMMDD(shipmentDetails.invoiceDate || today),
            free_form_invoice_type_id: "1",
            free_form_note_master_code: "COMMERCIAL",
            shipment_content: boxes[0]?.productDescription || (boxes[0]?.items?.[0]?.productName) || 'Books',
            remark: "",
            new_docket_free_form_invoice: "1",
            free_form_currency: shipmentDetails.currency || (destCountryCode === 'US' ? 'USD' : 'INR'),
            terms_of_trade: shipmentDetails.incoterms || 'DDU',
            api_service_code: billingCode,

            // Shipper Details
            shipper_name: shipperDetails.shipperName || 'TEST NAME',
            shipper_company_name: shipperDetails.companyName || shipperDetails.shipperName || 'TEST COMPANY NAME',
            shipper_contact_no: shipperDetails.mobileNo || '0123456789',
            shipper_email: shipperDetails.email || user?.email || 'test@test.com',
            shipper_address_line_1: (shipperDetails.address1 || shipperDetails.addressLine1 || 'Address 1').substring(0, 35),
            shipper_address_line_2: (shipperDetails.address2 || shipperDetails.addressLine2 || '.').substring(0, 35),
            shipper_address_line_3: (shipperDetails.address3 || '.').substring(0, 35),
            shipper_city: shipperDetails.city || 'Mumbai',
            shipper_state: shipperDetails.state || 'Maharashtra',
            shipper_country: shipperDetails.countryCode || 'IN',
            shipper_zip_code: shipperDetails.pincode || '400086',
            shipper_gstin_type: docType,
            shipper_gstin_no: docNo,

            // Consignee Details
            consignee_name: consigneeDetails.consigneeName || 'TEST NAME',
            consignee_company_name: consigneeDetails.companyName || consigneeDetails.consigneeName || 'TEST COMPANY NAME',
            consignee_contact_no: consigneeDetails.mobileNo || '9999999999',
            consignee_email: consigneeDetails.email || 'test@test.com',
            consignee_address_line_1: (consigneeDetails.address1 || consigneeDetails.addressLine1 || 'Address 1').substring(0, 35),
            consignee_address_line_2: (consigneeDetails.address2 || consigneeDetails.addressLine2 || '.').substring(0, 35),
            consignee_address_line_3: (consigneeDetails.address3 || '.').substring(0, 35),
            consignee_city: consigneeDetails.city || 'GREEN FIELDS',
            consignee_state: consigneeDetails.state || '',
            consignee_country: destCountryCode,
            consignee_zip_code: consigneeDetails.pincode || '5107',

            // Arrays
            docket_items: docketItems,
            free_form_line_items: freeFormLineItems,
            multiple_invoice: multipleInvoice
        };
    }

    /**
     * Dynamically resolve the Skynet BillingService code from service_config.json
     * Looks up based on the shipment's selected service zone (e.g. 'S USA-GA')
     * Falls back to 'SPX' if not found.
     * @private
     */
    _getBillingServiceCode(shipment) {
        try {
            const serviceZone = shipment.serviceDetails?.zone || shipment.serviceDetails?.code || '';
            const serviceCode = shipment.serviceDetails?.serviceCode;
            const destCountry = shipment.consigneeDetails?.country?.toUpperCase();

            // Prioritize services from the CURRENT carrier account type (SKYNET or SKYNET-ECOMMERCE)
            const currentServices = serviceConfig[this.carrierName]?.services || [];
            const otherCarrier = this.carrierName === 'SKYNET' ? 'SKYNET-ECOMMERCE' : 'SKYNET';
            const otherServices = serviceConfig[otherCarrier]?.services || [];

            const allSkynetServices = [...currentServices, ...otherServices];

            let matched = null;

            // 1. Try matching with COUNTRY + ServiceCode/Code/Name (Strict)
            if (destCountry) {
                matched = allSkynetServices.find(s =>
                    (s.serviceCode === serviceCode || s.code === serviceCode || s.displayName === serviceCode || s.code === serviceZone || s.zone === serviceZone) &&
                    (s.country?.toUpperCase() === destCountry || COUNTRY_CODES[s.country] === COUNTRY_CODES[shipment.consigneeDetails?.country])
                );
            }

            // 2. Fallback to matching by ServiceCode/Code/Name only (Less strict)
            if (!matched && serviceCode) {
                matched = allSkynetServices.find(s =>
                    s.serviceCode === serviceCode ||
                    s.displayName === serviceCode ||
                    s.code === serviceCode
                );
            }

            // 3. Last fallback: match by zone/code field
            if (!matched && serviceZone) {
                matched = allSkynetServices.find(s => s.code === serviceZone || s.zone === serviceZone);
            }

            let billingCode = null;

            if (matched?.skynetBillingCode) {
                billingCode = matched.skynetBillingCode;
            }

            // Fallback for Australia shipments: default to 'AU-SKY-NDOX-DEL' if country is Australia and no specific billing code is found or it returned SPX
            const isDestinationAustralia = destCountry && (destCountry === 'AUSTRALIA' || shipment.consigneeDetails?.countryCode?.toUpperCase() === 'AU');
            if (isDestinationAustralia && (!billingCode || billingCode === 'SPX')) {
                billingCode = 'AU-SKY-NDOX-DEL';
            }

            // DYNAMIC FIX: Convert DOX to NDOX for parcels and vice-versa (Only for long codes)
            if (billingCode) {
                const isParcel = shipment.shipmentType === 'parcel' || !shipment.document;
                if (isParcel && billingCode.length > 5 && billingCode.includes('-DOX-')) {
                    billingCode = billingCode.replace('-DOX-', '-NDOX-');
                    console.log(`[SKYNET] Converting document code to parcel code: ${billingCode}`);
                } else if (!isParcel && billingCode.length > 5 && billingCode.includes('-NDOX-')) {
                    billingCode = billingCode.replace('-NDOX-', '-DOX-');
                    console.log(`[SKYNET] Converting parcel code to document code: ${billingCode}`);
                }
            }

            if (!billingCode) {
                throw new Error(`[SKYNET] No valid BillingService code found for ${destCountry} using serviceCode='${serviceCode}' zone='${serviceZone}'.`);
            }

            console.log(`[SKYNET] Final BillingService for ${destCountry}: ${billingCode}`);
            return billingCode;
        } catch (err) {
            console.error('[SKYNET] Error resolving BillingService code:', err.message);
            throw err;
        }
    }

    /**
     * Get KYC document type string for Skynet
     * @private
     */
    _getKycDocType(kycData) {
        if (kycData.aadharNumber) return 'AADHAAR NUMBER';
        if (kycData.panNumber) return 'PAN NUMBER';
        if (kycData.passportNumber) return 'PASSPORT NUMBER';
        return 'AADHAAR NUMBER';
    }

    /**
     * Format date as DD-MMM-YYYY (e.g., "15-Jan-2024") in IST
     * @private
     */
    _formatDate(date) {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
            const parts = formatter.formatToParts(date);
            const d = parts.find(p => p.type === 'day').value;
            const m = parts.find(p => p.type === 'month').value;
            const y = parts.find(p => p.type === 'year').value;
            return `${d}-${m}-${y}`;
        } catch (e) {
            // Fallback
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const d = date.getDate().toString().padStart(2, '0');
            const m = months[date.getMonth()];
            const y = date.getFullYear();
            return `${d}-${m}-${y}`;
        }
    }

    /**
     * Format date as YYYY-MM-DD in IST
     * @private
     */
    _formatDateYYYYMMDD(date) {
        if (!date) return '';
        try {
            const d = new Date(date);
            if (isNaN(d.getTime())) return '';
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });
            const parts = formatter.formatToParts(d);
            const day = parts.find(p => p.type === 'day').value;
            const m = parts.find(p => p.type === 'month').value;
            const y = parts.find(p => p.type === 'year').value;
            return `${y}-${m}-${day}`;
        } catch (e) {
            return '';
        }
    }

    /**
     * Log carrier API call to database
     * @private
     */
    async _logBooking(shipmentId, action, request, response, success, errorMessage, awbNo, durationMs, attempts, httpStatus) {
        try {
            // Sanitize request (remove sensitive fields)
            const sanitizedRequest = request ? { ...request } : null;
            if (sanitizedRequest) {
                delete sanitizedRequest.Token;
                delete sanitizedRequest.Password;
                delete sanitizedRequest.token;
                delete sanitizedRequest.password;
            }

            const log = new CarrierBookingLog({
                shipment: shipmentId,
                carrier: this.carrierName,
                action,
                request: sanitizedRequest,
                response,
                success,
                errorMessage,
                awbNo,
                durationMs,
                attempts,
                httpStatus
            });

            await log.save();
            return log;
        } catch (err) {
            console.error('Failed to log carrier booking:', err.message);
            return null;
        }
    }

    /**
     * Map state name to 2-character code
     * @private
     */
    _getStateCode(stateName, countryCode) {
        if (!stateName) return 'DL';

        const state = stateName.trim().toUpperCase();
        if (state.length === 2) return state;

        // Indian States
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
            return indianStates[state] || state.substring(0, 2);
        }

        // US States
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
            return usStates[state] || state.substring(0, 2);
        }

        // Canadian Provinces
        if (countryCode === 'CA') {
            const caProvinces = {
                'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'MANITOBA': 'MB', 'NEW BRUNSWICK': 'NB',
                'NEWFOUNDLAND AND LABRADOR': 'NL', 'NOVA SCOTIA': 'NS', 'ONTARIO': 'ON', 'PRINCE EDWARD ISLAND': 'PE',
                'QUEBEC': 'QC', 'SASKATCHEWAN': 'SK', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU', 'YUKON': 'YT'
            };
            return caProvinces[state] || state.substring(0, 2);
        }

        // Australian States
        if (countryCode === 'AU') {
            const auStates = {
                'NEW SOUTH WALES': 'NSW', 'VICTORIA': 'VIC', 'QUEENSLAND': 'QLD', 'WESTERN AUSTRALIA': 'WA',
                'SOUTH AUSTRALIA': 'SA', 'TASMANIA': 'TAS', 'NORTHERN TERRITORY': 'NT', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT'
            };
            return auStates[state] || state.substring(0, 2);
        }

        return state.substring(0, 2);
    }
}

module.exports = SkynetAdapter;