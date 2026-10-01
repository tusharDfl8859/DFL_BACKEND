const SystemConfig = require('../models/SystemConfig');
const Otp = require('../models/Otp');
const sendEmail = require('../utils/emailService');

const DEFAULT_CARRIER_CONFIG = {
    'SKYNET': true,
    'SKYNET-ECOMMERCE': true,
    'TPL': true,
    'UNITED': true,
    'ENVIA': true,
    'WILLOW': true
};

/**
 * @desc Get all configuration keys
 * @route GET /api/config
 * @access Private (Admin)
 */
const getConfigs = async (req, res) => {
    try {
        const configs = await SystemConfig.find();

        // Convert to a simple object for easier frontend use
        const configMap = configs.reduce((acc, curr) => {
            acc[curr.key] = curr.value;
            return acc;
        }, {});

        res.json(configMap);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch configuration' });
    }
};

/**
 * @desc Update a configuration key
 * @route PUT /api/config/:key
 * @access Private (Admin Only)
 */
const updateConfig = async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        if (typeof value === 'undefined') {
            return res.status(400).json({ message: 'Missing configuration value' });
        }

        let config = await SystemConfig.findOne({ key });

        if (config) {
            config.value = value;
            config.updatedBy = req.user._id;
            await config.save();
        } else {
            config = await SystemConfig.create({
                key,
                value,
                updatedBy: req.user._id
            });
        }

        res.json({ message: `Configuration '${key}' updated`, value: config.value });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update configuration' });
    }
};

/**
 * @desc Get Carrier API Integrations Configuration
 * @route GET /api/config/carrier-apis
 * @access Private (Admin)
 */
const getCarrierApiConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'carrierApiToggles' });

        if (!config) {
            config = await SystemConfig.create({
                key: 'carrierApiToggles',
                value: DEFAULT_CARRIER_CONFIG,
                description: 'Configuration for individual carrier API integrations'
            });
        }

        // Merge with defaults to ensure newly added keys (like ENVIA and WILLOW) default to true if missing in existing DB record
        const mergedConfig = { ...DEFAULT_CARRIER_CONFIG, ...(config.value || {}) };
        res.json(mergedConfig);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch carrier API configuration' });
    }
};

/**
 * @desc Toggle specific carrier API
 * @route POST /api/config/carrier-apis/toggle
 * @access Private (Admin Only)
 */
const toggleCarrierApi = async (req, res) => {
    try {
        const { carrier, enabled } = req.body;

        if (!carrier || typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Carrier and enabled status are required and must be valid'
            });
        }

        const userId = req.user?._id || req.admin?._id;
        let config = await SystemConfig.findOne({ key: 'carrierApiToggles' });

        let currentToggles = config?.value ? config.value : DEFAULT_CARRIER_CONFIG;

        currentToggles = { ...currentToggles, [carrier]: enabled };

        config = await SystemConfig.findOneAndUpdate(
            { key: 'carrierApiToggles' },
            {
                value: currentToggles,
                updatedBy: userId
            },
            { upsert: true, returnDocument: 'after' }
        );

        // Keep willowCommerceConfig.willowApiEnabled in sync if WILLOW toggle is updated
        if (['WILLOW', 'WILLOW-COMMERCE', 'WILLOW COMMERCE'].includes(String(carrier).toUpperCase())) {
            try {
                let willowDoc = await SystemConfig.findOne({ key: 'willowCommerceConfig' });
                if (willowDoc?.value) {
                    willowDoc.value.willowApiEnabled = enabled;
                    willowDoc.markModified('value');
                    await willowDoc.save();
                } else {
                    await SystemConfig.create({
                        key: 'willowCommerceConfig',
                        value: { willowApiEnabled: enabled },
                        updatedBy: userId
                    });
                }
            } catch (wErr) {
                return res.status(500).json({
                    success: false,
                    message: 'Carrier toggle updated, but failed to synchronize secondary Willow configuration'
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: `${carrier} API Integration ${enabled ? 'ENABLED' : 'DISABLED'}`,
            config: config?.value
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to toggle carrier API'
        });
    }
};

/**
 * @desc Get Surcharge Configuration
 * @route GET /api/config/surcharges
 * @access Private (Admin)
 */
const getSurchargeConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'surchargeConfig' });

        if (!config) {
            // Default Config
            const defaultConfig = {
                toggles: {
                    'GB': true,
                    'EU': true,
                    'US': true,
                    'AU': true,
                    'CA': true,
                    'AE': true
                },
                showPopup: true
            };

            config = await SystemConfig.create({
                key: 'surchargeConfig',
                value: defaultConfig,
                description: 'Configuration for country-wise surcharges and popup visibility'
            });
        }

        res.json(config.value);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch surcharge configuration' });
    }
};

/**
 * @desc Update Surcharge Configuration
 * @route POST /api/config/surcharges
 * @access Private (Admin Only)
 */
const updateSurchargeConfig = async (req, res) => {
    try {
        const { toggles, showPopup } = req.body;

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'surchargeConfig' },
            {
                value: { toggles, showPopup },
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );

        res.json({
            message: 'Surcharge configuration updated successfully',
            config: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update surcharge configuration' });
    }
};

/**
 * @desc Disable all surcharges and hide popup
 * @route POST /api/config/surcharges/disable-all
 * @access Private (Admin Only)
 */
const disableAllSurcharges = async (req, res) => {
    try {
        const disabledToggles = {
            'GB': false,
            'EU': false,
            'US': false,
            'AU': false,
            'CA': false,
            'AE': false
        };

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'surchargeConfig' },
            {
                value: { toggles: disabledToggles, showPopup: false },
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );

        res.json({
            message: 'All surcharges have been disabled and popup hidden',
            config: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to disable all surcharges' });
    }
};

/**
 * @desc Get Bulk Order feature visibility status
 * @route GET /api/config/bulk-status
 * @access Private (Authenticated User/Admin)
 */
const getBulkStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'bulkOrderEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch bulk order status' });
    }
};

/**
 * @desc Get Cashfree feature visibility status
 * @route GET /api/config/cashfree-status
 * @access Private (Authenticated User/Admin)
 */
const getCashfreeStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'cashfreeEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch cashfree status' });
    }
};

/**
 * @desc Get Cashfree Processing Fee %
 * @route GET /api/config/cashfree-fee
 * @access Private
 */
const getCashfreeProcessingFeeConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'cashfreeProcessingFee' });
        if (!config) {
            config = await SystemConfig.create({
                key: 'cashfreeProcessingFee',
                value: 2.39,
                description: 'Processing fee percentage for Cashfree payments'
            });
        }
        res.json({ percentage: config.value });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch cashfree processing fee config' });
    }
};

/**
 * @desc Update Cashfree Processing Fee %
 * @route PUT /api/config/cashfree-fee
 * @access Private (Admin Only)
 */
const updateCashfreeProcessingFeeConfig = async (req, res) => {
    try {
        const { percentage } = req.body;
        if (percentage === undefined || isNaN(percentage) || percentage < 0) {
             return res.status(400).json({ message: 'Invalid percentage value' });
        }

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'cashfreeProcessingFee' },
            {
                value: Number(percentage),
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );
        res.json({ message: 'Cashfree processing fee updated', percentage: config.value });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update cashfree processing fee config' });
    }
};

/**
 * @desc Get Manual Payment feature visibility status
 * @route GET /api/config/manual-payment-status
 * @access Private (Authenticated User/Admin)
 */
const getManualPaymentStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'manualPaymentEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch manual payment status' });
    }
};

/**
 * @desc Get Zoho Integration status
 * @route GET /api/config/zoho-status
 * @access Private (Authenticated User/Admin)
 */
const getZohoStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'zohoEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch zoho status' });
    }
};

const parseUKSvcToggles = (config) => {
    let toggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
    if (config?.value) {
        if (typeof config.value === 'boolean' && config.value === true) {
            toggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
        } else if (typeof config.value === 'object') {
            toggles = { ...toggles, ...config.value };
        }
    }
    return toggles;
};

/**
 * @desc Get UK Services visibility status
 * @route GET /api/config/uk-svc-status
 * @access Private
 */
const getUKSvcStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'ukSvcEnabled' });
        const toggles = parseUKSvcToggles(config);
        res.json({ config: toggles });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch UK service status' });
    }
};

/**
 * @desc Toggle UK Services status
 * @route PUT /api/config/uk-svc-status
 * @access Private (Admin)
 */
const toggleUKSvcStatus = async (req, res) => {
    try {
        const { carrier, enabled } = req.body;

        if (!carrier || typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Carrier and enabled status are required' });
        }

        const config = await SystemConfig.findOne({ key: 'ukSvcEnabled' });
        
        let currentToggles = parseUKSvcToggles(config);

        currentToggles = { ...currentToggles, [carrier]: enabled };

        const updated = await SystemConfig.findOneAndUpdate(
            { key: 'ukSvcEnabled' },
            { 
                value: currentToggles,
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );

        res.json({ 
            message: `Carrier ${carrier} visibility ${enabled ? 'ENABLED' : 'DISABLED'}`,
            config: updated.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to toggle UK service status' });
    }
};

/**
 * @desc Get Developer API feature visibility status
 * @route GET /api/config/developer-api-status
 * @access Private (Authenticated User/Admin)
 */
const getDeveloperApiStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'developerApiEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch Developer API status' });
    }
};

/**
 * @desc Toggle Developer API status
 * @route PUT /api/config/developer-api-status
 * @access Private (Admin)
 */
const toggleDeveloperApiStatus = async (req, res) => {
    try {
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled status is required' });
        }

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'developerApiEnabled' },
            { 
                value: enabled,
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );

        res.json({ 
            message: `Developer API Access ${enabled ? 'ENABLED' : 'DISABLED'}`,
            enabled: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to toggle Developer API status' });
    }
};

/**
 * @desc Get Amazon feature visibility status
 * @route GET /api/config/amazon-status
 * @access Private (Authenticated User/Admin)
 */
const getAmazonStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'amazonEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch Amazon status' });
    }
};

/**
 * @desc Toggle Amazon feature visibility status
 * @route PUT /api/config/amazon-status
 * @access Private (Admin Only)
 */
const toggleAmazonStatus = async (req, res) => {
    try {
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled status is required' });
        }

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'amazonEnabled' },
            { 
                value: enabled,
                updatedBy: req.user._id
            },
            { upsert: true, new: true }
        );

        res.json({ 
            message: `Amazon Integration ${enabled ? 'ENABLED' : 'DISABLED'}`,
            enabled: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to toggle Amazon status' });
    }
};

/**
 * @desc Get Dynamic DFL Self-Pickup Cities Configuration
 * @route GET /api/config/dfl-pickup-cities
 * @access Public / Authenticated
 */
const getDflPickupCitiesConfig = async (req, res) => {
    try {
        const { DEFAULT_DFL_CITIES } = require('../utils/pickupCityHelper');
        let config = await SystemConfig.findOne({ key: 'dfl_pickup_cities' });
        const cities = config && Array.isArray(config.value) ? config.value : DEFAULT_DFL_CITIES;
        res.json({ success: true, cities });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch DFL pickup cities configuration' });
    }
};

/**
 * @desc Update Dynamic DFL Self-Pickup Cities Configuration
 * @route PUT /api/config/dfl-pickup-cities
 * @access Private (Admin Only)
 */
const updateDflPickupCitiesConfig = async (req, res) => {
    try {
        const { cities } = req.body;
        if (!Array.isArray(cities)) {
            return res.status(400).json({ message: 'Cities list must be an array of city names' });
        }

        const cleanedCities = cities.map(c => String(c).trim()).filter(Boolean);

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'dfl_pickup_cities' },
            {
                value: cleanedCities,
                updatedBy: req.user?._id || req.admin?._id
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            message: 'DFL Self-Pickup Cities updated successfully',
            cities: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update DFL pickup cities configuration' });
    }
};

/**
 * @desc Get Chatbot feature visibility status
 * @route GET /api/config/chatbot-status
 * @access Public / Authenticated
 */
const getChatbotStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'chatbotEnabled' });
        res.json({ enabled: config ? !!config.value : true });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch Chatbot status' });
    }
};

/**
 * @desc Toggle Chatbot feature visibility status
 * @route PUT /api/config/chatbot-status
 * @access Private (Admin Only)
 */
const toggleChatbotStatus = async (req, res) => {
    try {
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled status is required' });
        }

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'chatbotEnabled' },
            { 
                value: enabled,
                updatedBy: req.user?._id || req.admin?._id
            },
            { upsert: true, new: true }
        );

        res.json({ 
            message: `AI Chatbot Integration ${enabled ? 'ENABLED' : 'DISABLED'}`,
            enabled: config.value
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to toggle Chatbot status' });
    }
};

/**
 * @desc Get Shopify Marketplace feature visibility status
 * @route GET /api/config/shopify-status
 * @access Private (Authenticated User/Admin)
 */
const getShopifyStatus = async (req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: 'shopifyEnabled' });
        return res.status(200).json({
            success: true,
            enabled: config ? !!config.value : true
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch Shopify status'
        });
    }
};

/**
 * @desc Toggle Shopify Marketplace feature visibility status
 * @route PUT /api/config/shopify-status
 * @access Private (Admin Only)
 */
const toggleShopifyStatus = async (req, res) => {
    try {
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Enabled status is required and must be a boolean'
            });
        }

        const userId = req.user?._id || req.admin?._id;

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'shopifyEnabled' },
            { 
                value: enabled,
                updatedBy: userId
            },
            { upsert: true, returnDocument: 'after' }
        );

        return res.status(200).json({
            success: true,
            message: `Shopify Marketplace Integration ${enabled ? 'ENABLED' : 'DISABLED'}`,
            enabled: config?.value ?? enabled
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to toggle Shopify status'
        });
    }
};

module.exports = {
    getConfigs,
    updateConfig,
    getCarrierApiConfig,
    toggleCarrierApi,
    getSurchargeConfig,
    updateSurchargeConfig,
    disableAllSurcharges,
    getBulkStatus,
    getCashfreeStatus,
    getCashfreeProcessingFeeConfig,
    updateCashfreeProcessingFeeConfig,
    getManualPaymentStatus,
    getZohoStatus,
    getUKSvcStatus,
    toggleUKSvcStatus,
    getDeveloperApiStatus,
    toggleDeveloperApiStatus,
    getAmazonStatus,
    toggleAmazonStatus,
    getDflPickupCitiesConfig,
    updateDflPickupCitiesConfig,
    getChatbotStatus,
    toggleChatbotStatus,
    getShopifyStatus,
    toggleShopifyStatus
};
