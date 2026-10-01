const axios = require('axios');
const { isValidPhoneNumber } = require('libphonenumber-js');
const carrierConfig = require('../config/carrierConfig');

class RSAService {
    constructor() {
        this.config = carrierConfig.RSA;
        // Append correct base path from documentation
        this.baseUrl = (process.env.RSAXB_BASE_URL || 'https://api-dev.rsaxb.com').replace(/\/$/, '') + '/lastmiledelivery/api';

        // Cache JWT token in memory
        this.jwtToken = null;
        this.tokenExpiry = null;
    }
    /**
     * Determine Last Mile Partner based on weight
     */
    getLastMilePartner(weightKg, serviceName = '') {
        const isPriority = serviceName.toUpperCase().includes('PRIORITY');

        const isProd = process.env.RSA_ENV === 'production';
        const codes = {
            royalMail: isProd ? "55" : "97",
            yodel: isProd ? "52" : "104",
            dpd: isProd ? "79" : "137"
        };

        if (isPriority) {
            if (weightKg <= 20) return codes.royalMail; // Royal Mail for Priority <= 20kg
            if (weightKg <= 30) return codes.dpd;       // DPD for Priority 20kg to 30kg
            throw new Error(`Weight ${weightKg}kg exceeds maximum allowed weight (30kg) for UK Priority`);
        }

        if (weightKg <= 3.00) return codes.yodel; // Yodel
        if (weightKg <= 20) return codes.royalMail; // Royal Mail
        if (weightKg <= 30) return codes.dpd; // DPD
        throw new Error(`Weight ${weightKg}kg exceeds maximum allowed weight (30kg) for UK Standard`);
    }

    /**
     * Authenticate and get Bearer Token
     */
    async authenticate() {
        // Reuse valid token if we have one
        if (this.jwtToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.jwtToken;
        }

        // Fix: Implement Promise Lock to prevent Race Conditions
        // If an authentication request is already in-flight, return the same promise
        // instead of firing a duplicate request that invalidates the first token!
        if (this._authPromise) {
            return this._authPromise;
        }

        this._authPromise = (async () => {
            try {
                const response = await axios.post(`${this.baseUrl}/client-authenticate`, {
                    "client-key": this.config.credentials.clientKey
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Ocp-Apim-Subscription-Key': this.config.credentials.subscriptionKey
                    }
                });

                if (response.data?.result === 'success') {
                    this.jwtToken = response.data.data.token;
                   
                    // Safely set expiry to 23 hours from now to be safe (API says 24h)
                    this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
                    return this.jwtToken;
                } else {
                    throw new Error("RSA Auth Failed: " + JSON.stringify(response.data));
                }
            } catch (error) {
                throw new Error(`RSA Authentication Failed: ${error.response?.data?.errors?.[0]?.message || error.message}`);
            } finally {
                // Clear the lock whether successful or failed
                this._authPromise = null;
            }
        })();

        return this._authPromise;
    }

    /**
     * Create Shipment
     */
    async createShipment(shipmentData) {
        let requestPayload = null;
        try {
            const token = await this.authenticate();

            // Extract Weight - fallback to 1 if missing
            let extractedWeight = shipmentData.serviceDetails?.chargeableWeight
                || shipmentData.shipmentDetails?.boxes?.[0]?.weight
                || shipmentData.chargeableWeight
                || 1;
            let weightKg = parseFloat(extractedWeight);
            const originalWeight = weightKg;

            const lastMileCode = this.getLastMilePartner(originalWeight, shipmentData.serviceDetails?.serviceName);

            // Carrier API Bypass: If weight is exactly 3.00 (or between 2.99 and 3), force it to 2.99
            if (weightKg > 2.99 && weightKg <= 3.00) {
                weightKg = 2.99;
            }

            const shipmentDetails = shipmentData.shipmentDetails || {};
            const firstBox = shipmentDetails.boxes?.[0] || shipmentData.packageDetails?.[0] || {};
            const items = Array.isArray(firstBox.items) ? firstBox.items : [];
            const invoiceNumber = shipmentDetails.invoiceNumber ? String(shipmentDetails.invoiceNumber).trim() : '';
            const referenceNumber = shipmentDetails.referenceNumber ? String(shipmentDetails.referenceNumber).trim() : '';
            let baseRef = String(referenceNumber || invoiceNumber || shipmentData.shipmentId || `DFL-${Date.now()}`);
            let rawOrderRef = baseRef;
            if (shipmentData.shipmentId && !baseRef.includes(shipmentData.shipmentId)) {
                rawOrderRef = `${baseRef}-${shipmentData.shipmentId}`;
            }
            
            const orderReference = rawOrderRef
                .replace(/\s+/g, '-')
                .replace(/[^A-Za-z0-9_-]/g, '-')
                .substring(0, 60);

            const totalQuantity = items.reduce((sum, item) => {
                const qty = parseInt(item.quantity, 10);
                return sum + (Number.isFinite(qty) && qty > 0 ? qty : 1);
            }, 0) || parseInt(shipmentData.packageDetails?.[0]?.pieces || shipmentDetails.boxes?.length || 1, 10) || 1;

            const itemValue = items.reduce((sum, item) => {
                const qty = parseInt(item.quantity, 10);
                const unitPrice = parseFloat(item.unitPrice);
                return sum + ((Number.isFinite(qty) && qty > 0 ? qty : 1) * (Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : 0));
            }, 0);
            let totalValue = parseFloat(shipmentData.totalPrice || shipmentData.packageDetails?.[0]?.declaredValue || itemValue || 10);

            const commodities = items.length > 0
                ? items.map((item) => {
                    const qty = parseInt(item.quantity, 10);
                    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
                    const unitPrice = parseFloat(item.unitPrice);
                    const descriptionParts = [
                        item.productName || 'General Cargo',
                        invoiceNumber ? `INV ${invoiceNumber}` : orderReference
                    ];

                    return {
                        description: descriptionParts.filter(Boolean).join(' - ').substring(0, 150),
                        hs_code: item.hsnCode || shipmentDetails.hsCode || '39269099',
                        quantity: safeQty,
                        weight_per_unit: parseFloat((weightKg / totalQuantity).toFixed(3)),
                        value_per_unit: parseFloat((Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : totalValue / totalQuantity).toFixed(2)),
                        country_of_origin_code: 'IN'
                    };
                })
                : [{
                    description: (`General Cargo - ${invoiceNumber ? `INV ${invoiceNumber}` : orderReference}`).substring(0, 150),
                    hs_code: shipmentDetails.hsCode || '39269099',
                    quantity: totalQuantity,
                    weight_per_unit: parseFloat((weightKg / totalQuantity).toFixed(3)),
                    value_per_unit: parseFloat((totalValue / totalQuantity).toFixed(2)),
                    country_of_origin_code: 'IN'
                }];

            // Calculate the exact sum of commodities as formatted for the payload to prevent mismatch API error
            let payloadCommodityValue = commodities.reduce((sum, item) => sum + (item.quantity * item.value_per_unit), 0);
            
            // Ensure order_value is at least the sum of the commodities and correctly rounded
            if (payloadCommodityValue > totalValue) {
                totalValue = payloadCommodityValue;
            }
            
            // Apply 135 GBP cap for UK DDP shipments
            if ((shipmentDetails.currency || 'INR').toUpperCase() === 'GBP' && totalValue > 135) {
                const ratio = 135 / totalValue;
                totalValue = 135;
                
                // Scale down all commodities using floor to ensure the sum never exceeds 135
                commodities.forEach(item => {
                    item.value_per_unit = Math.floor(item.value_per_unit * ratio * 100) / 100;
                });
            }

            // Format order_value strictly to 2 decimals to prevent trailing floating point rejections
            totalValue = parseFloat(totalValue.toFixed(2));

            // Construct exactly as OpenAPI spec requires
            const payload = {
                client_key: this.config.credentials.clientKey,
                order_reference: orderReference,
                order_value: totalValue,
                order_currency_code: shipmentDetails.currency || 'INR', // Pass actual user currency
                payment_type: 'Prepaid',    // DFL shipments are prepaid by the customer on the portal
                order_weight: weightKg,
                service_type: 'CCLMHD-STA',
                duty_handling: 'ddp',       // Required for crossborder
                lastmile_code: lastMileCode,

                consignee: {
                    name: (shipmentData.consigneeDetails?.consigneeName || shipmentData.receiverDetails?.name || '').substring(0, 150),
                    phone_number: (shipmentData.consigneeDetails?.mobileNo || shipmentData.receiverDetails?.phone || '').replace(/[^0-9]/g, '').replace(/^44/, ''),
                    email: (shipmentData.consigneeDetails?.email || shipmentData.receiverDetails?.email || 'no-email@dflexpress.com').substring(0, 100),
                    address_line1: (shipmentData.consigneeDetails?.addressLine1 || shipmentData.receiverDetails?.addressLine1 || '').substring(0, 150),
                    city_name: shipmentData.consigneeDetails?.city || shipmentData.receiverDetails?.city || '',
                    zip_code: shipmentData.consigneeDetails?.pincode || shipmentData.receiverDetails?.pincode || '',
                    country_code: 'GB'
                },

                consignor: {
                    name: (shipmentData.shipperDetails?.shipperName || shipmentData.senderDetails?.name || '').substring(0, 150),
                    phone_number: (shipmentData.shipperDetails?.mobileNo || shipmentData.senderDetails?.phone || '').replace(/[^0-9]/g, '').replace(/^91/, ''),
                    email: shipmentData.shipperDetails?.email || shipmentData.senderDetails?.email || 'info@dflexpress.com',
                    address_line1: (shipmentData.shipperDetails?.addressLine1 || shipmentData.senderDetails?.addressLine1 || '').substring(0, 150),
                    city_name: shipmentData.shipperDetails?.city || shipmentData.senderDetails?.city || '',
                    zip_code: shipmentData.shipperDetails?.pincode || shipmentData.senderDetails?.pincode || '110001',
                    country_code: 'IN'
                },

                packages: [
                    {
                        package_type: 'Box',
                        height: parseFloat(firstBox.height || 10),
                        length: parseFloat(firstBox.length || 10),
                        width: parseFloat(firstBox.width || firstBox.breadth || 10),
                        commodities
                    }
                ]
            };
            requestPayload = payload;

            const response = await axios.post(`${this.baseUrl}/client/create-package`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Ocp-Apim-Subscription-Key': this.config.credentials.subscriptionKey
                },
                timeout: this.config.timeout
            });

            const responseData = response.data;
            if (responseData.result !== 'success') {
                if (responseData.status_code === '401' || (responseData.errors && responseData.errors[0]?.message === 'Token is invalidated.')) {
                    this.jwtToken = null;
                    this.tokenExpiry = null;
                    return this.createShipment(shipmentData); // Retry once with fresh token
                }
                throw new Error("RSA Create Failed: " + JSON.stringify(responseData));
            }

            // Immediately fetch the label as well using the tracking number
            const rsaTrackingNumber = responseData.data.rsa_tracking_number;
            const labelData = await this.generateLabel(rsaTrackingNumber, token);

            return {
                success: true,
                awbNumber: rsaTrackingNumber,
                partnerCode: lastMileCode,
                carrierName: responseData.data.carrier_name,
                barcode: responseData.data.carrier_tracking_number || responseData.data.barcode_number || responseData.data.rsa_barcode_string,
                bagKey: responseData.data.bag_key,
                encodedLabel: labelData.encoded_string,
                requestPayload: payload,
                responsePayload: responseData
            };

        } catch (error) {
            // Fix: Axios throws errors on 400+ status codes, so the 401 retry must happen here!
            if (error.response?.status === 401 || (error.response?.data?.errors && error.response.data.errors[0]?.message === 'Token is invalidated.')) {
                if (!shipmentData._isRetry) {
                    this.jwtToken = null;
                    this.tokenExpiry = null;
                    shipmentData._isRetry = true; // prevent infinite loops
                    return this.createShipment(shipmentData); // Retry once with fresh token
                }
            }

            const rsaError = new Error(`RSA Shipment Error: ${JSON.stringify(error.response?.data?.errors || error.message)}`);
            rsaError.responsePayload = error.response?.data;
            rsaError.requestPayload = requestPayload || {};

            // Try to extract request payload safely from axios config if available and if we didn't already capture it
            try {
                if (error.config && error.config.data && !requestPayload) {
                    rsaError.requestPayload = typeof error.config.data === 'string' ? JSON.parse(error.config.data) : error.config.data;
                }
            } catch (e) {
                console.warn('Failed to parse RSA request payload from error config:', e);
            }

            rsaError.status = error.response?.status;
            throw rsaError;
        }
    }

    /**
     * Generate Label (Returns Base64 PDF string)
     */
    async generateLabel(trackingNo, tokenOverride = null) {
        try {
            const token = tokenOverride || await this.authenticate();

            const response = await axios.get(`${this.baseUrl}/client/generate-label/${trackingNo}?type=rsa`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Ocp-Apim-Subscription-Key': this.config.credentials.subscriptionKey
                }
            });

            if (response.data?.result === 'success') {
                return response.data.data; // contains encoded_string
            } else {
                throw new Error("Label generation failed");
            }
        } catch (error) {
            throw new Error(`RSA Label Error: ${error.response?.data?.errors?.[0]?.message || error.message}`);
        }
    }

    /**
     * Get Tracking Details
     * @param {string} trackingNo - RSA tracking number or Carrier tracking number
     */
    async trackShipment(trackingNo) {
        try {
            const token = await this.authenticate();

            const response = await axios.get(`${this.baseUrl}/client/tracking-details/${trackingNo}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Ocp-Apim-Subscription-Key': this.config.credentials.subscriptionKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data?.result === 'success') {
                return response.data.data;
            } else {
                throw new Error("RSA Tracking failed: " + JSON.stringify(response.data));
            }
        } catch (error) {
            if (error.response?.status === 401 || (error.response?.data?.errors && error.response.data.errors[0]?.message === 'Token is invalidated.')) {
                if (!this._isTrackingRetry) {
                    this.jwtToken = null;
                    this.tokenExpiry = null;
                    this._isTrackingRetry = true;
                    try {
                        const result = await this.trackShipment(trackingNo);
                        return result;
                    } finally {
                        this._isTrackingRetry = false;
                    }
                }
            }
            throw new Error(`RSA Tracking Error: ${error.response?.data?.errors?.[0]?.message || error.message}`);
        }
    }
}

module.exports = new RSAService();
