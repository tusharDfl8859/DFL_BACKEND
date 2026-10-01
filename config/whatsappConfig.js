const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_API_VERSION = 'v23.0';
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';

const parseBoolean = (value) => String(value || '').trim().toLowerCase() === 'true';
const parseOptionalBoolean = (value, fallback) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    return parseBoolean(value);
};

const parseRequestTimeout = (value) => {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return DEFAULT_REQUEST_TIMEOUT_MS;
    }

    return Math.min(Math.max(parsed, 1000), 30000);
};

const isPlaceholderSecret = (value) => /placeholder|your[_-]|<.*>|meta_test_access_token/i.test(String(value || ''));

const getWhatsappConfig = () => ({
    enabled: parseBoolean(process.env.WHATSAPP_ENABLED),
    signupEnabled: parseOptionalBoolean(process.env.WHATSAPP_SIGNUP_ENABLED, parseBoolean(process.env.WHATSAPP_ENABLED)),
    signupTestMode: parseBoolean(process.env.WHATSAPP_SIGNUP_TEST_MODE),
    firstBookingEnabled: parseOptionalBoolean(process.env.WHATSAPP_FIRST_BOOKING_ENABLED, parseBoolean(process.env.WHATSAPP_ENABLED)),
    debugLogs: parseBoolean(process.env.WHATSAPP_DEBUG_LOGS),
    apiVersion: String(process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION).trim(),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    businessAccountId: String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim(),
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    defaultCountryCode: String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, ''),
    signupTemplate: String(process.env.WHATSAPP_SIGNUP_TEMPLATE || '').trim(),
    signupTemplateLanguage: String(process.env.WHATSAPP_SIGNUP_TEMPLATE_LANGUAGE || '').trim(),
    signupTemplateParameters: String(process.env.WHATSAPP_SIGNUP_TEMPLATE_PARAMETERS || 'name').trim(),
    pickupReportTemplate: String(process.env.WHATSAPP_PICKUP_REPORT_TEMPLATE || '').trim(),
    pickupReportTemplateLanguage: String(process.env.WHATSAPP_PICKUP_REPORT_TEMPLATE_LANGUAGE || 'hi').trim(),
    firstBookingTemplate: String(process.env.WHATSAPP_FIRST_BOOKING_TEMPLATE || process.env.WHATSAPP_SIGNUP_TEMPLATE || 'signup_confirmation').trim(),
    firstBookingTemplateLanguage: String(process.env.WHATSAPP_FIRST_BOOKING_TEMPLATE_LANGUAGE || process.env.WHATSAPP_SIGNUP_TEMPLATE_LANGUAGE || 'en').trim(),
    firstBookingTemplateParameters: String(process.env.WHATSAPP_FIRST_BOOKING_TEMPLATE_PARAMETERS || 'name').trim(),
    dailyBookingSummaryEnabled: parseOptionalBoolean(process.env.WHATSAPP_DAILY_BOOKING_SUMMARY_ENABLED, true),
    dailyBookingSummaryTime: String(process.env.WHATSAPP_DAILY_BOOKING_SUMMARY_TIME || '57 11 * * *').trim(),
    dailyBookingSummaryTimezone: String(process.env.WHATSAPP_DAILY_BOOKING_SUMMARY_TIMEZONE || 'Asia/Kolkata').trim(),
    dailyBookingSummaryTemplate: String(process.env.WHATSAPP_DAILY_BOOKING_SUMMARY_TEMPLATE || 'daily_report_summary').trim(),
    dailyBookingSummaryTemplateLanguage: String(process.env.WHATSAPP_DAILY_BOOKING_SUMMARY_TEMPLATE_LANGUAGE || '').trim(),
    statusUpdateEnabled: parseOptionalBoolean(process.env.WHATSAPP_STATUS_UPDATE_ENABLED, true),
    statusUpdateTemplate: String(process.env.WHATSAPP_STATUS_UPDATE_TEMPLATE || 'daily_report_summary').trim(),
    statusUpdateTemplateLanguage: String(process.env.WHATSAPP_STATUS_UPDATE_TEMPLATE_LANGUAGE || 'en').trim(),
    statusUpdateTemplateParameters: String(process.env.WHATSAPP_STATUS_UPDATE_TEMPLATE_PARAMETERS || 'name,shipmentId,status,trackingNumber').trim(),
    bulkEnabled: parseOptionalBoolean(process.env.WHATSAPP_BULK_ENABLED, true),
    bulkTemplate: String(process.env.WHATSAPP_BULK_TEMPLATE || 'dfl_customer_announcement').trim(),
    bulkTemplateLanguage: String(process.env.WHATSAPP_BULK_TEMPLATE_LANGUAGE || process.env.WHATSAPP_BULK_TEMPLATE_LANG || 'en').trim(),
    bulkConcurrency: Math.min(Math.max(parseInt(process.env.WHATSAPP_BULK_CONCURRENCY, 10) || 5, 1), 50),
    templateLanguage: String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE).trim(),
    requestTimeoutMs: parseRequestTimeout(process.env.WHATSAPP_REQUEST_TIMEOUT_MS),
});

const getWhatsappConfigErrors = (config = getWhatsappConfig()) => {
    if (!config.enabled) {
        return [];
    }

    const errors = [];

    if (!/^v\d+\.\d+$/.test(config.apiVersion)) {
        errors.push('WHATSAPP_API_VERSION');
    }

    if (!/^\d+$/.test(config.phoneNumberId)) {
        errors.push('WHATSAPP_PHONE_NUMBER_ID');
    }

    if (!config.accessToken || isPlaceholderSecret(config.accessToken)) {
        errors.push('WHATSAPP_ACCESS_TOKEN');
    }

    if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.templateLanguage)) {
        errors.push('WHATSAPP_TEMPLATE_LANGUAGE');
    }

    if (config.signupTemplateLanguage && !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.signupTemplateLanguage)) {
        errors.push('WHATSAPP_SIGNUP_TEMPLATE_LANGUAGE');
    }

    if (config.signupTemplateParameters && !/^[a-zA-Z0-9_,]+$/.test(config.signupTemplateParameters)) {
        errors.push('WHATSAPP_SIGNUP_TEMPLATE_PARAMETERS');
    }

    if (config.firstBookingTemplate && !/^[a-z0-9_]+$/.test(config.firstBookingTemplate)) {
        errors.push('WHATSAPP_FIRST_BOOKING_TEMPLATE');
    }

    if (config.firstBookingTemplateLanguage && !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.firstBookingTemplateLanguage)) {
        errors.push('WHATSAPP_FIRST_BOOKING_TEMPLATE_LANGUAGE');
    }

    if (config.firstBookingTemplateParameters && !/^[a-zA-Z0-9_,]+$/.test(config.firstBookingTemplateParameters)) {
        errors.push('WHATSAPP_FIRST_BOOKING_TEMPLATE_PARAMETERS');
    }

    if (config.dailyBookingSummaryTemplate && !/^[a-z0-9_]+$/.test(config.dailyBookingSummaryTemplate)) {
        errors.push('WHATSAPP_DAILY_BOOKING_SUMMARY_TEMPLATE');
    }

    if (config.dailyBookingSummaryTemplateLanguage && !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.dailyBookingSummaryTemplateLanguage)) {
        errors.push('WHATSAPP_DAILY_BOOKING_SUMMARY_TEMPLATE_LANGUAGE');
    }

    if (!/^\d{1,3}$/.test(config.defaultCountryCode) || config.defaultCountryCode.startsWith('0')) {
        errors.push('WHATSAPP_DEFAULT_COUNTRY_CODE');
    }

    return errors;
};

module.exports = {
    getWhatsappConfig,
    getWhatsappConfigErrors,
};
