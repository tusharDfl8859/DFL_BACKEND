const express = require('express');
const router = express.Router();
const { protect, admin, superAdmin } = require('../middleware/authMiddleware');
const { 
    getConfigs, 
    updateConfig, 
    getCarrierApiConfig,
    toggleCarrierApi, 
    getSurchargeConfig, 
    updateSurchargeConfig, 
    disableAllSurcharges, 
    requestSystemSettingsOTP, 
    verifySystemSettingsOTP,
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
} = require('../controllers/configController');

// DFL Self Pickup Cities Config
router.get('/dfl-pickup-cities', protect, getDflPickupCitiesConfig);
router.put('/dfl-pickup-cities', protect, superAdmin, updateDflPickupCitiesConfig);

// UK Services Visibility
router.get('/uk-svc-status', protect, getUKSvcStatus);
router.put('/uk-svc-status', protect, superAdmin, toggleUKSvcStatus);



// Public / User level visibility settings
router.get('/bulk-status', protect, getBulkStatus);
router.get('/cashfree-status', protect, getCashfreeStatus);
router.get('/cashfree-fee', protect, getCashfreeProcessingFeeConfig);
router.put('/cashfree-fee', protect, superAdmin, updateCashfreeProcessingFeeConfig);
router.get('/manual-payment-status', protect, getManualPaymentStatus);
router.get('/zoho-status', protect, getZohoStatus);
router.get('/developer-api-status', protect, getDeveloperApiStatus);
router.put('/developer-api-status', protect, superAdmin, toggleDeveloperApiStatus);
router.get('/amazon-status', protect, getAmazonStatus);
router.put('/amazon-status', protect, superAdmin, toggleAmazonStatus);
router.get('/chatbot-status', protect, getChatbotStatus);
router.put('/chatbot-status', protect, superAdmin, toggleChatbotStatus);
router.get('/shopify-status', protect, getShopifyStatus);
router.put('/shopify-status', protect, admin, toggleShopifyStatus);

// Carrier APIs (Super Admin Only)
router.get('/carrier-apis', protect, superAdmin, getCarrierApiConfig);
router.post('/carrier-apis/toggle', protect, superAdmin, toggleCarrierApi);

// Surcharge Config
router.get('/surcharges', getSurchargeConfig);
router.post('/surcharges', protect, superAdmin, updateSurchargeConfig);
router.post('/surcharges/disable-all', protect, superAdmin, disableAllSurcharges);

// General config (Super Admin Only)
router.get('/', protect, superAdmin, getConfigs);
router.put('/:key', protect, superAdmin, updateConfig);

module.exports = router;
