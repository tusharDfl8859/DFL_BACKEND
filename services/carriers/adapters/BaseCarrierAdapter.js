/**
 * BaseCarrierAdapter - Abstract base class for all carrier adapters
 * 
 * All carrier-specific adapters (Skynet, TPL, United, Speedbox) extend this class
 * to provide a unified interface for booking, tracking, and manifest operations.
 */

const axios = require('axios');
// Handle axios import for CommonJS/ESM
const httpClient = axios.default || axios;

class BaseCarrierAdapter {
    constructor(config) {
        this.config = config;
        this.carrierName = 'BASE';
        this.timeout = config.timeout || 30000;
        this.retries = config.retries || 2;
    }

    /**
     * Book a shipment with the carrier
     * @param {Object} shipment - Shipment document from MongoDB
     * @param {Object} [user] - The user object (optional, some carriers need it)
     * @returns {Promise<{awbNo: string, label: string, labelUrl?: string, carrierRef: string}>}
     */
    async book(shipment, user) {
        throw new Error(`book() not implemented for ${this.carrierName}`);
    }

    /**
     * Track a shipment
     * @param {string} awb - AWB/Tracking number
     * @returns {Promise<{status: string, events: Array}>}
     */
    async track(awb) {
        throw new Error(`track() not implemented for ${this.carrierName}`);
    }

    /**
     * Generate manifest for multiple shipments
     * @param {Array} shipments - Array of shipment documents or IDs
     * @param {string} [manifestDate] - Date string
     * @param {string} [cdAwbNumber] - CD AWB Number
     * @param {string} [courierName] - Courier name
     * @returns {Promise<{manifestId: string, manifestPdf: string}>}
     */
    async manifest(shipments, manifestDate, cdAwbNumber, courierName) {
        throw new Error(`manifest() not implemented for ${this.carrierName}`);
    }

    /**
     * Unified HTTP call with retry logic, timeout, and logging
     * @param {string} url - API endpoint
     * @param {Object} payload - Request body (for POST/PUT) or query params (for GET)
     * @param {Object} options - Additional axios options (method, headers, etc)
     * @returns {Promise<Object>} - API response data
     */
    async callAPI(url, payload, options = {}) {
        let lastError = null;
        const method = (options.method || 'POST').toUpperCase();
        
        for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
            const startTime = Date.now();
            try {
                console.log(`[DIAGNOSTIC] ${this.carrierName} ${method} to ${url} with params:`, JSON.stringify(payload));

                const config = {
                    method: method,
                    url: url,
                    timeout: this.timeout,
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers
                    },
                    ...options
                };

                if (method === 'GET') {
                    config.params = payload;
                } else {
                    config.data = payload;
                }

                const response = await httpClient.request(config);
                const durationMs = Date.now() - startTime;
                
                console.log(`[${this.carrierName}] ${method} call to ${url} succeeded in ${durationMs}ms`);
                
                return {
                    data: response.data,
                    durationMs,
                    attempt,
                    httpStatus: response.status
                };

            } catch (error) {
                lastError = error;
                const durationMs = Date.now() - startTime;
                const isRetryable = this._isRetryableError(error);
                
                console.warn(`[${this.carrierName}] ${method} call attempt ${attempt} failed: ${error.message}`);
                
                if (!isRetryable || attempt > this.retries) {
                    // Log the final failure to help debugging, but don't break the object return expectations
                    // Actually, the TPLAdapter calls logCarrierAction, but only if it gets a result.
                    // We should probably log here too if we want to catch 401s that throw.
                    break;
                }
                
                await this._sleep(Math.pow(2, attempt - 1) * 1000);
            }
        }

        // All retries exhausted
        const errorMsg = lastError?.response?.data?.message || lastError?.response?.data?.error || lastError?.message || 'Unknown error';
        throw new CarrierAPIError(
            this.carrierName,
            errorMsg,
            lastError?.response?.status,
            lastError?.response?.data
        );
    }

    /**
     * Check if error is retryable (network issues, 5xx errors)
     */
    _isRetryableError(error) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return true; // Timeout
        }
        if (error.response && error.response.status >= 500) {
            return true; // Server errors
        }
        if (!error.response) {
            return true; // Network errors
        }
        return false;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Custom error class for carrier API errors
 */
class CarrierAPIError extends Error {
    constructor(carrier, message, statusCode = null, responseData = null) {
        super(`[${carrier}] ${message}`);
        this.name = 'CarrierAPIError';
        this.carrier = carrier;
        this.statusCode = statusCode;
        this.responseData = responseData;
        this.isCarrierError = true;
    }
}

module.exports = { BaseCarrierAdapter, CarrierAPIError };
