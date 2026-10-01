const { BaseCarrierAdapter, CarrierAPIError } = require('./BaseCarrierAdapter');
const carrierConfig = require('../../../config/carrierConfig');
const { uploadPDFToCloudinary } = require('../../../utils/cloudinaryUploader');

class TPLAdapter extends BaseCarrierAdapter {
    constructor() {
        super(carrierConfig.TPL);
        this.carrierName = 'TPL';
    }

    /**
     * Override callAPI to automatically inject Basic Auth header if credentials exist
     */
    async callAPI(url, payload, options = {}) {
        const { username, password } = this.config.credentials;
        if (username && password) {
            const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
            options.headers = {
                ...options.headers,
                'Authorization': authHeader
            };
        }
        return super.callAPI(url, payload, options);
    }

    /**
     * Track a TPL shipment using the live carrier API
     * @param {string} awbNo - The AWB / tracking number
     * @returns {Promise<Object>} - Normalized tracking data
     */
    async track(awbNo) {
        const trackUrl = 'https://transitpl.com/api/track';
        const { username, password, apiKey } = this.config.credentials;

        const authHeader = username && password
            ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
            : null;

        try {
            const result = await this.callAPI(trackUrl, {
                api_key: apiKey,
                awb_no: awbNo
            }, authHeader ? { headers: { 'Authorization': authHeader } } : {});

            const raw = result.data;

            // Handle both direct data and nested data.data shapes
            const payload = raw?.data || raw;

            const trackingDetails = Array.isArray(payload?.tracking_details)
                ? payload.tracking_details
                : [];

            return {
                awb_no: awbNo,
                status: payload?.status || 'unknown',
                destination: payload?.destination || '',
                est_delivery_date: payload?.est_delivery_date || null,
                signed_by: payload?.signed_by || null,
                tracking_details: trackingDetails.map(evt => ({
                    message: evt.message || evt.status || 'Update',
                    location: evt.location || '',
                    timestamp: evt.timestamp || evt.date || new Date().toISOString()
                }))
            };
        } catch (err) {
            console.warn(`[TPL] Tracking call failed for AWB ${awbNo}: ${err.message}`);
            // Return empty but valid shape so the controller doesn't crash
            return {
                awb_no: awbNo,
                status: 'unknown',
                tracking_details: []
            };
        }
    }

    /**
     * Look up the TPL internal zipcode ID
     */
    async _getZipcodeId(countryCode, postalCode) {
        if (!countryCode || !postalCode) return '';

        try {
            const payload = {
                api_key: this.config.credentials.apiKey,
                country: countryCode,
                search: postalCode
            };
            const result = await this.callAPI(this.config.zipcodeUrl, payload);

            // Assuming response contains a list or a matched zipcode object with 'id'
            // We'll need to fetch the first matched item
            if (result.data && result.data.status && result.data.data && result.data.data.length > 0) {
                return result.data.data[0].id || result.data.data[0].zipcode_id;
            }
            // If data structure is different, we fallback to finding 'id'
            const matched = result.data?.data?.find(z => z.zipcode === postalCode);
            return matched ? (matched.id || matched.zipcode_id) : '';
        } catch (err) {
            console.warn(`[TPL] Warning: Failed to fetch zipcode ID: ${err.message}`);
            return '';
        }
    }

    /**
     * Check rates to get service_code and branch_name
     */
    async _getRateDetails(shipment, zipcodeId) {
        try {
            const { consigneeDetails, shipmentDetails, boxes } = shipment;

            let totalWeight = 0;
            let totalValue = shipment.shipmentDetails?.totalItemValue || shipment.shipmentDetails?.totalTaxableValue;

            if (!totalValue) {
                totalValue = boxes.reduce((sum, box) => {
                    return sum + (box.items || []).reduce((itemSum, item) => itemSum + (parseFloat(item.unitPrice) || 0) * (parseFloat(item.quantity) || 1), 0);
                }, 0) || 100; // Final fallback to 100
            }

            const dimensions = boxes.map(box => {
                let rawWeight = parseFloat(box.billingWeight) || parseFloat(box.actualWeight) || parseFloat(box.weight) || 0.5;
                let weightKg = rawWeight > 100 ? rawWeight / 1000 : rawWeight; // Heuristic: >100 is likely grams
                totalWeight += weightKg;
                return {
                    units: "cm",
                    length: box.length || 10,
                    width: box.width || 10,
                    height: box.height || 10,
                    weightb: weightKg
                };
            });

            if (totalWeight <= 0) totalWeight = 0.5;

            const payload = {
                api_key: this.config.credentials.apiKey,
                rate_request: {
                    ship_date: this._formatDate(new Date()),
                    package_code: "NDX",
                    to_country: consigneeDetails.country, // Should be ISO code ideally
                    zipcode_id: zipcodeId,
                    weight: {
                        value: totalWeight,
                        units: "kg"
                    },
                    value: totalValue,
                    dimensions: dimensions
                }
            };

            const result = await this.callAPI(this.config.rateUrl, payload);

            // Extract the first available service code and branch
            if (result.data && result.data.status && result.data.data && result.data.data.length > 0) {
                const rate = result.data.data[0];
                const companyData = rate.company || rate;
                return {
                    serviceCode: companyData.service_code || rate.code || "TP05", // fallback
                    branchName: companyData.branch_name || "DELHI" // fallback
                };
            }
            return { serviceCode: "TP05", branchName: "DELHI" };
        } catch (err) {
            console.warn(`[TPL] Warning: Failed to fetch rate details: ${err.message}`);
            return { serviceCode: "TP05", branchName: "DELHI" }; // Fallback
        }
    }

    /**
     * Book a shipment with TPL
     */
    /**
     * Normalize full country names to ISO-2 codes for TPL API
     */
    _toISO2(country) {
        if (!country) return country;
        const map = {
            'united states': 'US', 'usa': 'US', 'united states of america': 'US',
            'india': 'IN', 'united kingdom': 'GB', 'uk': 'GB',
            'canada': 'CA', 'australia': 'AU', 'germany': 'DE',
            'france': 'FR', 'china': 'CN', 'japan': 'JP',
            'singapore': 'SG', 'uae': 'AE', 'united arab emirates': 'AE'
        };
        return map[country.toLowerCase()] || country;
    }

    /**
     * Normalize US State names to 2-letter postal codes for TPL API
     */
    _toUSStateCode(state) {
        if (!state) return state;
        const normalized = state.trim().toLowerCase();
        if (normalized.length === 2) return state.toUpperCase();

        const map = {
            'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
            'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
            'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
            'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
            'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
            'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
            'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
            'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
            'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
            'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
            'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
            'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
            'wisconsin': 'WI', 'wyoming': 'WY',
            'district of columbia': 'DC', 'puerto rico': 'PR'
        };
        return map[normalized] || state;
    }

    async book(shipment, user) {
        let payload = null;
        try {
            const { consigneeDetails, shipmentDetails } = shipment;

            // Normalize country codes (handle full names like "United States" -> "US")
            if (consigneeDetails) {
                consigneeDetails.country = this._toISO2(consigneeDetails.country);
                if (consigneeDetails.country === 'US') {
                    consigneeDetails.state = this._toUSStateCode(consigneeDetails.state);
                }
            }
            const shipperDetails = shipment.shipperDetails || {};
            if (shipperDetails) {
                shipperDetails.country = this._toISO2(shipperDetails.country);
            }

            // Fallback: boxes may be nested inside shipmentDetails
            if (!shipment.boxes || shipment.boxes.length === 0) {
                shipment.boxes = shipmentDetails?.boxes || [];
            }

            // Step 1: Get Zipcode ID
            const searchStr = consigneeDetails.country === 'US' ? consigneeDetails.state : consigneeDetails.pincode;
            const zipcodeId = await this._getZipcodeId(consigneeDetails.country, searchStr);

            // Step 2: Get Service Code & Branch Name
            const { serviceCode, branchName } = await this._getRateDetails(shipment, zipcodeId);

            // Step 3: Map to booking payload
            payload = this._mapToTPLPayload(shipment, user, zipcodeId, serviceCode, branchName);

            // Step 4: Call booking API
            const { data, durationMs, attempt, httpStatus } = await this.callAPI(this.config.bookingUrl, payload);

            // TPL API Success Check (assumes standard JSON status fields)
            const responseData = data.data || {};
            const awbNo = data.awb_no || responseData.awb_no;

            if (!data || data.status === false || data.status === 'error' || !awbNo) {
                const errorMsg = data.message || data.error || 'Unknown booking error';

                await this._logCarrierAction(shipment._id, 'BOOK', payload, data, false, durationMs, attempt, httpStatus, errorMsg);

                throw new CarrierAPIError(this.carrierName, `Booking failed: ${errorMsg}`, httpStatus, data);
            }


            // TPL might return the label URL or direct base64
            let label = data.data?.label || responseData.label || data.label || data.label_url || null;
            let carrierRef = awbNo; // Use safely resolved awbNo
            let labelUrl = null;

            // If TPL returned a base64-encoded PDF label, upload it to Cloudinary
            if (label) {
                try {
                    labelUrl = await uploadPDFToCloudinary(label, 'tpl-labels', `tpl-label-${carrierRef || shipment.shipmentId}`);
                    console.log(`[TPL] Label uploaded to Cloudinary: ${labelUrl}`);
                } catch (uploadErr) {
                    console.warn(`[TPL] Label upload to Cloudinary failed: ${uploadErr.message}. Storing raw label reference.`);
                    labelUrl = null;
                }
            }

            await this._logCarrierAction(shipment._id, 'BOOK', payload, data, true, durationMs, attempt, httpStatus, null, carrierRef);

            return {
                awbNo: carrierRef,
                label: labelUrl || label,   // prefer Cloudinary URL, fallback to raw
                labelUrl: labelUrl,          // explicit Cloudinary URL for controller
                carrierRef: carrierRef,
                message: data.message || 'Successfully booked with TPL'
            };
        } catch (err) {
            // Log final failure to MongoDB if we have a shipment ID
            if (shipment && shipment._id) {
                await this._logCarrierAction(
                    shipment._id,
                    'BOOK',
                    payload || { info: 'Payload mapping failed' },
                    err.responseData || null,
                    false,
                    0, 1,
                    err.statusCode || 500,
                    err.message
                );
            }
            throw err;
        }
    }

    /**
     * Map internal DFL shipment to TPL expected payload
     */
    _mapToTPLPayload(shipment, user, zipcodeId, serviceCode, branchName) {
        const shipmentObj = typeof shipment.toObject === 'function' ? shipment.toObject() : shipment;
        const { shipperDetails, consigneeDetails, shipmentDetails, kycData } = shipmentObj;
        const boxes = shipmentObj.boxes || shipmentDetails?.boxes || [];

        // Is it Commercial? Let's use CSB-V structure if CSB-5
        const isCommercial = shipmentDetails.shipmentCategory === 'csb5';

        // Trim phone numbers - strip symbols, spaces, dashes
        const trim = (rawPhone, fallback = '') => {
            if (!rawPhone) return fallback;
            const digits = String(rawPhone).replace(/[^\d]/g, '');
            return digits ? digits : fallback;
        };

        const formatPhone = (rawPhone, countryIso, fallback = '') => {
            let digits = trim(rawPhone, fallback);
            if (!digits) return fallback;
            // Prepend country code if it's missing (assuming 10 digit local numbers)
            if (digits.length === 10) {
                if (countryIso === 'IN') digits = '91' + digits;
                else if (countryIso === 'US') digits = '1' + digits;
                else if (countryIso === 'GB') digits = '44' + digits;
                else if (countryIso === 'AU') digits = '61' + digits;
                else if (countryIso === 'CA') digits = '1' + digits;
            }
            return digits;
        };

        // 1. Calculate weight & map boxes
        let totalWeight = 0;
        const dimensions = boxes.map((box, index) => {
            let rawWeight = parseFloat(box.billingWeight) || parseFloat(box.actualWeight) || parseFloat(box.weight) || 0.5;
            let weightKg = rawWeight > 100 ? rawWeight / 1000 : rawWeight; // Heuristic: >100 is likely grams
            totalWeight += weightKg;
            return {
                units: "cm",
                length: box.length ? box.length.toString() : "10",
                width: box.width ? box.width.toString() : "10",
                height: box.height ? box.height.toString() : "10",
                weightb: weightKg.toString()
            };
        });

        if (totalWeight <= 0) totalWeight = 0;

        // 2. Map Items / Custom Invoice
        // Normalise HSN codes — US requires exactly 10 digits
        const isUS = (consigneeDetails.country === 'US');
        const padHsn = (code) => {
            if (!code) return '87450000';
            const str = code.toString().replace(/\D/g, '');
            if (isUS) return str.padEnd(10, '0').substring(0, 10);
            return str.padEnd(8, '0').substring(0, 8);
        };

        // Items may live at top-level, inside shipmentDetails.csbVItems (only for csb5), or inside boxes[].items
        let flatItems = [];
        
        if (shipmentObj.items && shipmentObj.items.length > 0) {
            flatItems = shipmentObj.items;
        }
        
        // Only check csbVItems if it is a Commercial CSB-V shipment
        if (flatItems.length === 0 && isCommercial && shipmentDetails?.csbVItems && shipmentDetails.csbVItems.length > 0) {
            const validCsbVItems = shipmentDetails.csbVItems.filter(item => item.productName || item.hsnCode);
            if (validCsbVItems.length > 0) {
                flatItems = validCsbVItems;
            }
        }
        
        // Fallback/Standard boxes items
        if (flatItems.length === 0 && boxes && boxes.length > 0) {
            boxes.forEach((box, boxIdx) => {
                const boxItems = box.items || [];
                boxItems.forEach(item => {
                    flatItems.push({
                        ...item,
                        hsnCode: item.hsnCode || item.hsn_code || box.hsnCode,
                        _boxNo: boxIdx + 1
                    });
                });
            });
        }

        let currentBoxNo = 1;
        const items = flatItems.map(item => {
            const rawPrice = parseFloat(item.unitPrice || item.price || item.unit_price || 0);
            const finalPrice = rawPrice > 0 ? rawPrice : 1.0;
            return {
                box_no: (item._boxNo || currentBoxNo).toString(),
                nondg: "0",
                product_name: item.productName || item.product_name || item.name || "Item",
                quantity: (item.quantity || item.qty || 1).toString(),
                price: finalPrice.toFixed(3),
                hsn_code: padHsn(item.hsnCode || item.hsn_code || item.hsn),
                units: shipmentDetails.currency || "INR",
                p_weight: "0.000",
                currency: shipmentDetails.currency || "INR",
                uom: "PCS"
            };
        });

        if (items.length === 0) {
            let fallbackHsn = null;
            if (boxes && boxes.length > 0) {
                fallbackHsn = boxes[0].hsnCode;
            }
            if (!fallbackHsn && shipmentDetails?.csbVItems && shipmentDetails.csbVItems.length > 0) {
                fallbackHsn = shipmentDetails.csbVItems[0].hsnCode;
            }

            items.push({
                box_no: "1",
                nondg: "0",
                product_name: shipmentDetails.contentDescription || "Document",
                quantity: "1",
                price: "1.000",
                hsn_code: padHsn(fallbackHsn),
                units: shipmentDetails.currency || "INR",
                p_weight: "0.000",
                currency: shipmentDetails.currency || "INR",
                uom: "PCS"
            });
        }

        // 3. Map KYC Data
        let documentType = ""; 
        let documentNo = ""; 
        let documentType2 = "";
        let documentNo2 = "";
        
        const kyc = user?.kycData || kycData || shipmentObj.kycData || {};
        
        // Aadhar could be in documentNumber (if documentType is Aadhar), or companyAadhaarNumber
        let aadharVal = "";
        if (kyc.companyAadhaarNumber) {
            aadharVal = kyc.companyAadhaarNumber;
        } else if (kyc.documentType && String(kyc.documentType).toLowerCase().includes("aadhar") && kyc.documentNumber) {
            aadharVal = kyc.documentNumber;
        }

        // PRIORITY 1: Force auto-fetch from KYC profile (Aadhar & PAN)
        if (aadharVal) {
            documentType = "aadhar no";
            documentNo = aadharVal;
        }
        
        if (kyc.panNumber) {
            if (!documentNo) {
                documentType = "pan no";
                documentNo = kyc.panNumber;
            } else if (!documentNo2 && documentNo !== kyc.panNumber) {
                documentType2 = "pan no";
                documentNo2 = kyc.panNumber;
            }
        }
        
        if (kyc.gstNumber) {
            if (!documentNo) {
                documentType = "gst no";
                documentNo = kyc.gstNumber;
            } else if (!documentNo2 && documentNo !== kyc.gstNumber) {
                documentType2 = "gst no";
                documentNo2 = kyc.gstNumber;
            }
        }

        // PRIORITY 2: Fallback to user explicitly provided in shipperDetails
        if (!documentNo && shipperDetails?.shipperIdType && shipperDetails?.shipperIdNo) {
            documentType = String(shipperDetails.shipperIdType).toLowerCase();
            documentNo = shipperDetails.shipperIdNo;
        } else if (!documentNo2 && shipperDetails?.shipperIdType && shipperDetails?.shipperIdNo && documentNo !== shipperDetails.shipperIdNo) {
            documentType2 = String(shipperDetails.shipperIdType).toLowerCase();
            documentNo2 = shipperDetails.shipperIdNo;
        }

        // Priority 3: Also check shipmentDetails-level IEC/GSTIN as fallback
        if (!documentNo && shipmentDetails?.gstinId) {
            documentType = "gst no";
            documentNo = shipmentDetails.gstinId;
        } else if (!documentNo2 && shipmentDetails?.gstinId && documentNo !== shipmentDetails.gstinId) {
            documentType2 = "gst no";
            documentNo2 = shipmentDetails.gstinId;
        }
        
        if (!documentNo && shipmentDetails?.iecNumber) {
            documentType = "iec no";
            documentNo = shipmentDetails.iecNumber;
        } else if (!documentNo2 && shipmentDetails?.iecNumber && documentNo !== shipmentDetails.iecNumber) {
            documentType2 = "iec no";
            documentNo2 = shipmentDetails.iecNumber;
        }

        const dateStr = this._formatDate(new Date());

        const requestPayload = {
            awb_no: shipmentObj.shipmentId || `TPL-${Date.now()}`,
            ship_date: dateStr,
            package_code: "NDX",
            to_country: consigneeDetails.country,
            zipcode_id: zipcodeId || "",
            service_code: serviceCode,
            branch_name: branchName,
            invoice_date: shipmentDetails?.invoiceDate ? this._formatDate(new Date(shipmentDetails.invoiceDate)) : dateStr,
            invoice_currency: shipmentDetails.currency || "INR",
            invoice_no: shipmentDetails?.invoiceNumber || shipmentObj.invoiceNumber || shipmentObj.shipmentId || "INV001",



            advanced_options: {
                custom_field1: shipmentObj.shipmentId
            },

            ship_to: {
                company: consigneeDetails.companyName || consigneeDetails.consigneeName || "Consignee",
                company_name: consigneeDetails.companyName || consigneeDetails.consigneeName || "Consignee",
                name: consigneeDetails.consigneeName || "Consignee",
                contact_person: consigneeDetails.consigneeName || "Consignee",
                phone: formatPhone(consigneeDetails.mobileNo, consigneeDetails.country),
                street1: consigneeDetails.addressLine1 ? consigneeDetails.addressLine1.substring(0, 35) : "Address 1",
                address1: consigneeDetails.addressLine1 ? consigneeDetails.addressLine1.substring(0, 35) : "Address 1",
                street2: consigneeDetails.addressLine2 ? consigneeDetails.addressLine2.substring(0, 35) : "Address 2",
                address2: consigneeDetails.addressLine2 ? consigneeDetails.addressLine2.substring(0, 35) : "Address 2",
                street3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                address3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                address_3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                street_3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                add3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                sh_add3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                address_line_3: consigneeDetails.addressLine3 ? consigneeDetails.addressLine3.substring(0, 35) : "",
                city: consigneeDetails.city || "",
                state: consigneeDetails.state || "",
                postal_code: consigneeDetails.pincode || "",
                pincode: consigneeDetails.pincode || "",
                country: consigneeDetails.country || "",
                email: consigneeDetails.email || "",
                co_email: consigneeDetails.email || "",
                email_id: consigneeDetails.email || "",
                email_address: consigneeDetails.email || "",
                consignee_email: consigneeDetails.email || "",
                consigneeEmail: consigneeDetails.email || "",
                emailId: consigneeDetails.email || "",
                mail: consigneeDetails.email || "",
                e_mail: consigneeDetails.email || "",
                contact_email: consigneeDetails.email || "",
                emailAddress: consigneeDetails.email || "",
                eMail: consigneeDetails.email || ""
            },

            ship_from: {
                company: shipperDetails.companyName || shipperDetails.shipperName || "Shipper",
                company_name: shipperDetails.companyName || shipperDetails.shipperName || "Shipper",
                name: shipperDetails.shipperName || "Shipper",
                contact_person: shipperDetails.shipperName || "Shipper",
                phone: formatPhone(shipperDetails.mobileNo, shipperDetails.country),
                mobile: formatPhone(shipperDetails.alternateMobile, shipperDetails.country),
                alt_phone: formatPhone(shipperDetails.alternateMobile, shipperDetails.country),
                street1: shipperDetails.addressLine1 ? shipperDetails.addressLine1.substring(0, 35) : "Address 1",
                address1: shipperDetails.addressLine1 ? shipperDetails.addressLine1.substring(0, 35) : "Address 1",
                street2: shipperDetails.addressLine2 ? shipperDetails.addressLine2.substring(0, 35) : "Address 2",
                address2: shipperDetails.addressLine2 ? shipperDetails.addressLine2.substring(0, 35) : "Address 2",
                street3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                address3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                address_3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                street_3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                add3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                sh_add3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                sh_add_3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                addressLine3: shipperDetails.addressLine3 ? shipperDetails.addressLine3.substring(0, 35) : "",
                city: shipperDetails.city || "",
                state: shipperDetails.state || "",
                postal_code: shipperDetails.pincode || "",
                pincode: shipperDetails.pincode || "",
                country: shipperDetails.country || "",
                email: shipperDetails.email || "info@dfl.com",
                sh_email: shipperDetails.email || "info@dfl.com",
                email_id: shipperDetails.email || "info@dfl.com",
                email_address: shipperDetails.email || "info@dfl.com",
                shipper_email: shipperDetails.email || "info@dfl.com",
                shipperEmail: shipperDetails.email || "info@dfl.com",
                emailId: shipperDetails.email || "info@dfl.com",
                mail: shipperDetails.email || "info@dfl.com",
                e_mail: shipperDetails.email || "info@dfl.com",
                contact_email: shipperDetails.email || "info@dfl.com",
                emailAddress: shipperDetails.email || "info@dfl.com",
                eMail: shipperDetails.email || "info@dfl.com",
                document_type: documentType,
                document_no: documentNo,
                document_type_2: documentType2,
                document_no_2: documentNo2,
                document2_type: documentType2,
                document2_no: documentNo2,
                document_type2: documentType2,
                document_no2: documentNo2,
                kyc_type_2: documentType2,
                kyc_no_2: documentNo2,
                kyc2_type: documentType2,
                kyc2_no: documentNo2,
                id_type_2: documentType2,
                id_no_2: documentNo2
            },

            // Root level email fields just in case TPL pulls from root
            email: shipperDetails.email || "info@dfl.com",
            shipper_email: shipperDetails.email || "info@dfl.com",
            consignee_email: consigneeDetails.email || "",
            
            weight: {
                value: totalWeight.toFixed(2),
                units: "KG"
            },

            dimensions: dimensions,
            custom_invoice: items
        };

        // Export / eCommerce fields — always required by TPL API
        // gift_type: "0" = Sample?, "2" = Gift
        requestPayload.gift_type = totalWeight >= 2.0 ? "2" : "0";
        requestPayload.gst_invoice_no = shipmentDetails?.invoiceNumber || shipmentObj.invoiceNumber || shipmentObj.shipmentId;
        requestPayload.gst_invoice_date = shipmentDetails?.invoiceDate ? this._formatDate(new Date(shipmentDetails.invoiceDate)) : dateStr;
        requestPayload.ad_code = kycData?.adCode || "0000000";
        requestPayload.gov_nongov_type = "P";
        requestPayload.invoice_terms = shipmentDetails.incoterm || "FOB";
        requestPayload.account_number = shipperDetails.accountNumber || "123456";
        requestPayload.export_using_ecom = isCommercial ? 1 : 0;

        return {
            api_key: this.config.credentials.apiKey,
            label_request: requestPayload
        };
    }


    /**
     * Manifest not supported by TPL API
     */
    async manifest(shipments) {
        console.warn(`[TPL] Warning: Manifest API is not supported by TPL. Manifests must be generated manually or internally.`);
        // throw new CarrierAPIError(this.carrierName, "Manifest generation via API is not supported by TPL.");
        // Returing empty strings per the base adapter interface to avoid runtime crashes
        return { manifestId: '', manifestPdf: '' };
    }

    /**
     * Log API interactions
     */
    async _logCarrierAction(shipmentId, action, request, response, success, durationMs, attempts, httpStatus, errorMessage, awbNo) {
        try {
            const CarrierBookingLog = require('../../../models/CarrierBookingLog');

            // Clean up request string to not dump pure base64 API keys
            const safeRequest = { ...request };
            if (safeRequest.api_key) safeRequest.api_key = '***';

            await CarrierBookingLog.create({
                shipment: shipmentId,
                carrier: this.carrierName,
                action,
                request: safeRequest,
                response,
                success,
                durationMs,
                attempts,
                httpStatus,
                errorMessage,
                awbNo
            });
        } catch (err) {
            console.error(`[${this.carrierName}] Failed to log to CarrierBookingLog:`, err.message);
        }
    }

    /**
     * Format Date to DD-MM-YYYY
     */
    _formatDate(date) {
        const d = new Date(date);
        const day = d.getDate().toString().padStart(2, '0');
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const year = d.getFullYear();
        return `${day}-${month}-${year}`;
    }
}

module.exports = TPLAdapter;
