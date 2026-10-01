/**
 * Envia HTTP Client
 * Modular, clean Axios wrapper for Envia Shipping & Queries APIs.
 */

const axios = require('axios');
const config = require('../../config/envia/enviaConfig');

const httpClient = axios.default || axios;

class EnviaClient {
    constructor(customConfig = {}) {
        this.config = { ...config, ...customConfig };
        this.token = this.config.token;
        this.timeout = this.config.timeout || 30000;
        this.retries = this.config.retries || 2;
    }

    /**
     * Internal request dispatcher with Bearer Token and retry logic
     */
    async request(url, method = 'GET', data = null, options = {}) {
        const fullUrl = url.startsWith('http') ? url : `${this.config.apiUrl}${url}`;
        const upperMethod = method.toUpperCase();
        let lastError = null;

        for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
            try {
                const requestConfig = {
                    method: upperMethod,
                    url: fullUrl,
                    timeout: this.timeout,
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                        ...(options.headers || {})
                    },
                    ...(upperMethod === 'GET' ? { params: data } : { data }),
                    ...options
                };

                const response = await httpClient.request(requestConfig);
                if (response.data && (response.data.meta === 'error' || response.data.error)) {
                    const errObj = response.data.error || {};
                    const errMsg = errObj.message || errObj.description || (typeof response.data.error === 'string' ? response.data.error : 'Envia API Error');
                    const customError = new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
                    customError.status = errObj.code && errObj.code >= 400 && errObj.code < 600 ? errObj.code : 400;
                    customError.details = response.data;
                    throw customError;
                }
                return response.data;
            } catch (error) {
                lastError = error;
                const isRetryable = this._isRetryableError(error);
                if (!isRetryable || attempt > this.retries) {
                    break;
                }
                await this._sleep(Math.pow(2, attempt - 1) * 1000);
            }
        }

        const errorMessage = lastError?.response?.data?.message ||
            lastError?.response?.data?.error?.message ||
            lastError?.response?.data?.error?.description ||
            lastError?.response?.data?.error ||
            lastError?.message ||
            'Envia API request failed';

        const errorStatus = lastError?.response?.status || 500;
        const errorDetails = lastError?.response?.data || null;

        const customError = new Error(typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage));
        customError.status = errorStatus;
        customError.details = errorDetails;
        throw customError;
    }

    _isRetryableError(error) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return true;
        }
        if (error.response && error.response.status >= 500) {
            return true;
        }
        if (!error.response) {
            return true;
        }
        return false;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new EnviaClient();
