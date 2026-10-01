
const axios = require('axios');
const WhatsappNotificationLog = require('../models/WhatsappNotificationLog');
const { getWhatsappConfig, getWhatsappConfigErrors } = require('../config/whatsappConfig');
const { formatPhoneNumber, maskPhoneNumber } = require('../utils/phoneNumberFormatter');

const SIGNUP_EVENT = 'SIGNUP_SUCCESS';
let configurationWarningLogged = false;

const logWhatsappStatus = (stage, details = {}) => {
    void stage;
    void details;
};

const logWhatsappStage = (config, stage, details = {}) => {
    void config;
    void stage;
    void details;
};

const sanitizeTemplateParameter = (value) => {
    const sanitized = String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1024);

    return sanitized || '-';
};

const buildSafeMetaPayloadLog = (payload) => ({
    messaging_product: payload?.messaging_product || null,
    to: payload?.to || null,
    type: payload?.type || null,
    template: payload?.template
        ? {
            name: payload.template.name || null,
            language: payload.template.language || null,
            components: Array.isArray(payload.template.components)
                ? payload.template.components.map((component) => ({
                    type: component?.type || null,
                    parameterCount: Array.isArray(component?.parameters) ? component.parameters.length : 0,
                }))
                : [],
        }
        : null,
});

const normalizeApiVersion = (apiVersion) => {
    const trimmed = String(apiVersion || '').trim();
    return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
};

const normalizePhoneNumberId = (phoneNumberId) => String(phoneNumberId || '').trim();

const buildSafeMetaEndpointLog = (apiVersion, phoneNumberId) => {
    const last4 = phoneNumberId.slice(-4);

    return {
        apiVersion,
        phoneNumberIdLast4: last4 || null,
        endpointHost: 'graph.facebook.com',
        endpointPath: `/${apiVersion}/***${last4}/messages`,
    };
};

const maskAccessToken = (token) => {
    const value = String(token || '').trim();
    if (!value) {
        return null;
    }

    if (value.length <= 8) {
        return `${value.slice(0, 2)}***${value.slice(-2)}`;
    }

    return `${value.slice(0, 4)}***${value.slice(-4)}`;
};

const buildSignupTemplateParameters = (config, values) => {
    const availableValues = {
        name: values.name,
        customerId: values.customerId,
        customer_id: values.customerId,
    };

    return String(config.signupTemplateParameters || 'name')
        .split(',')
        .map((key) => availableValues[key.trim()])
        .filter((value) => value !== undefined && value !== null);
};

const buildFirstBookingTemplateParameters = (config, values) => {
    const availableValues = {
        name: values.name,
        customer_name: values.name,
        shipmentId: values.shipmentId,
        shipment_id: values.shipmentId,
        bookingId: values.shipmentId,
        booking_id: values.shipmentId,
        trackingNumber: values.shipmentId,
        tracking_number: values.shipmentId,
    };

    return String(config.firstBookingTemplateParameters || 'name,shipmentId,trackingNumber')
        .split(',')
        .map((key) => availableValues[key.trim()])
        .filter((value) => value !== undefined && value !== null);
};

const buildFirstBookingTemplateParameterNames = (config) =>
    String(config.firstBookingTemplateParameters || 'name,shipmentId,trackingNumber')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);

const createPendingProviderMessageId = (eventType) => {
    const safeEventType = String(eventType || 'GENERIC_NOTIFICATION')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_');

    return `PENDING_${safeEventType}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
};

const getSafeProviderError = (error) => {
    const httpStatus = error?.response?.status;
    const providerError = error?.response?.data?.error || {};
    const providerCode = providerError?.code;
    const providerSubcode = providerError?.error_subcode;
    const providerMessage = String(providerError?.message || error?.message || 'WhatsApp provider request failed.')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const fbtraceId = error?.response?.data?.error?.fbtrace_id || error?.response?.headers?.['fbtrace_id'] || null;

    if (error?.code === 'ECONNABORTED') {
        return {
            errorCode: 'TIMEOUT',
            errorMessage: 'WhatsApp provider request timed out.',
            providerMessage: null,
            errorSubcode: null,
            httpStatus: null,
            fbtraceId: null,
        };
    }

    if (httpStatus) {
        return {
            errorCode: providerCode ? String(providerCode) : `HTTP_${httpStatus}`,
            errorSubcode: providerSubcode ? String(providerSubcode) : null,
            errorMessage: `WhatsApp provider request failed with HTTP ${httpStatus}.`,
            providerMessage,
            httpStatus,
            fbtraceId,
        };
    }

    return {




        errorCode: error?.code ? String(error.code) : 'PROVIDER_REQUEST_FAILED',
        errorMessage: 'WhatsApp provider request failed.',
        errorSubcode: null,
        providerMessage,
        httpStatus: null,
        fbtraceId,
    };
};

const sendTemplateMessage = async ({
    phone,
    templateName,
    languageCode,
    bodyParameters = [],
    parameterNames = [],
    parameters,
    headerDocument = null,
    headerMediaId = null,
    headerFilename = null,
    eventType,
    userId = null,
    idempotencyKey = null,
    metadata = {},
}) => {
    const config = getWhatsappConfig();
    const normalizedApiVersion = normalizeApiVersion(config.apiVersion);
    const normalizedPhoneNumberId = normalizePhoneNumberId(config.phoneNumberId);
    const normalizedConfig = {
        ...config,
        apiVersion: normalizedApiVersion,
        phoneNumberId: normalizedPhoneNumberId,
    };
    const suppliedParameters = parameters === undefined ? bodyParameters : parameters;
    const normalizedEventType = String(eventType || 'GENERIC_NOTIFICATION').trim().toUpperCase();
    const normalizedTemplateName = String(templateName || '').trim();
    const formattedPhone = formatPhoneNumber(phone, config.defaultCountryCode);
    const suppliedParameterNames = Array.isArray(parameterNames) ? parameterNames : [];

    logWhatsappStage(config, 'REQUEST_RECEIVED', {
        eventType: normalizedEventType,
        templateName: normalizedTemplateName || null,
        parameterCount: Array.isArray(suppliedParameters) ? suppliedParameters.length : null,
        parameterNameCount: suppliedParameterNames.length,
        hasUserId: Boolean(userId),
        hasIdempotencyKey: Boolean(idempotencyKey),
    });

    if (!config.enabled) {
        logWhatsappStatus('SKIPPED_DISABLED', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_DISABLED');
        return {
            success: false,
            skipped: true,
            reason: 'WhatsApp notifications are disabled.',
        };
    }

    const configErrors = getWhatsappConfigErrors(normalizedConfig);
    if (configErrors.length > 0) {
        logWhatsappStatus('SKIPPED_INVALID_CONFIG', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
            reason: configErrors.join(', '),
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_CONFIG', {
            missingOrInvalidKeys: configErrors,
        });

        configurationWarningLogged = true;

        return {
            success: false,
            skipped: true,
            reason: 'WhatsApp configuration is incomplete.',
        };
    }

    if (!formattedPhone) {
        logWhatsappStatus('SKIPPED_INVALID_PHONE', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_PHONE');
        return {
            success: false,
            skipped: true,
            reason: 'A valid WhatsApp phone number is unavailable.',
        };
    }

    logWhatsappStage(config, 'PHONE_FORMATTED', {
        phone: maskPhoneNumber(formattedPhone),
    });

    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(normalizedEventType)) {
        logWhatsappStatus('SKIPPED_INVALID_EVENT_TYPE', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_EVENT_TYPE');
        return {
            success: false,
            skipped: true,
            reason: 'A valid WhatsApp event type is required.',
        };
    }

    if (!/^[a-z0-9_]+$/.test(normalizedTemplateName)) {
        logWhatsappStatus('SKIPPED_INVALID_TEMPLATE', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_TEMPLATE');
        return {
            success: false,
            skipped: true,
            reason: 'A valid WhatsApp template name is unavailable.',
        };
    }

    const normalizedLanguageCode = String(languageCode || config.templateLanguage || '').trim();
    if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(normalizedLanguageCode)) {
        logWhatsappStatus('SKIPPED_INVALID_LANGUAGE', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_LANGUAGE');
        return {
            success: false,
            skipped: true,
            reason: 'A valid WhatsApp template language is required.',
        };
    }

    if (!Array.isArray(suppliedParameters)) {
        logWhatsappStatus('SKIPPED_INVALID_PARAMETERS', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName || null,
            userId,
        });
        logWhatsappStage(config, 'SKIPPED_INVALID_PARAMETERS');
        return {
            success: false,
            skipped: true,
            reason: 'WhatsApp template parameters must be an array.',
        };
    }

    const templateVariables = suppliedParameters.map(sanitizeTemplateParameter);
    const normalizedIdempotencyKey = String(idempotencyKey || '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, 200) || null;
    let logId = null;

    try {
        const duplicateFilter = normalizedIdempotencyKey
            ? { idempotencyKey: normalizedIdempotencyKey }
            : normalizedEventType === SIGNUP_EVENT && userId
                ? { eventType: SIGNUP_EVENT, userId }
                : null;

        if (duplicateFilter) {
            logWhatsappStage(config, 'DUPLICATE_CHECK_STARTED', {
                eventType: normalizedEventType,
                usesIdempotencyKey: Boolean(normalizedIdempotencyKey),
            });

            const existingLog = await WhatsappNotificationLog.findOne(duplicateFilter);
            if (existingLog) {
                logWhatsappStage(config, 'SKIPPED_DUPLICATE', {
                    logId: String(existingLog._id),
                });

                return {
                    success: false,
                    skipped: true,
                    reason: 'A notification already exists for this event.',
                    logId: String(existingLog._id),
                };
            }
        }

        const pendingLog = await WhatsappNotificationLog.create({
            eventType: normalizedEventType,
            userId,
            idempotencyKey: normalizedIdempotencyKey,
            phone: formattedPhone,
            templateName: normalizedTemplateName,
            templateVariables,
            providerMessageId: createPendingProviderMessageId(normalizedEventType),
            status: 'PENDING',
            metadata,
        });

        logId = String(pendingLog._id);
        logWhatsappStatus('PENDING', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName,
            phone: maskPhoneNumber(formattedPhone),
            userId,
            logId,
        });
        logWhatsappStage(config, 'PENDING_LOG_CREATED', {
            logId,
            eventType: normalizedEventType,
            phone: maskPhoneNumber(formattedPhone),
        });
    } catch (error) {
        if (error?.code === 11000) {
            logWhatsappStage(config, 'SKIPPED_DUPLICATE_INDEX', {
                keyPattern: error?.keyPattern || null,
                keyValue: error?.keyValue || null,
                index: error?.index || error?.errmsg || null,
            });
            return {
                success: false,
                skipped: true,
                reason: 'A notification already exists for this event.',
            };
        }

        logWhatsappStage(config, 'LOG_CREATION_FAILED');
        return {
            success: false,
            skipped: false,
            error: 'Unable to prepare WhatsApp notification.',
        };
    }

    const templatePayload = {
        name: normalizedTemplateName,
        language: {
            code: normalizedLanguageCode,
        },
    };

    const components = [];

    let effectiveHeaderDocument = headerDocument;
    if (!effectiveHeaderDocument && headerMediaId) {
        effectiveHeaderDocument = {
            id: String(headerMediaId),
            filename: headerFilename || 'document.pdf'
        };
    }

    if (effectiveHeaderDocument && (effectiveHeaderDocument.id || effectiveHeaderDocument.link)) {
        const headerParam = { type: 'document' };
        if (effectiveHeaderDocument.id) {
            headerParam.document = {
                id: String(effectiveHeaderDocument.id),
                filename: effectiveHeaderDocument.filename || 'document.pdf'
            };
        } else if (effectiveHeaderDocument.link) {
            headerParam.document = {
                link: String(effectiveHeaderDocument.link),
                filename: effectiveHeaderDocument.filename || 'document.pdf'
            };
        }
        components.push({
            type: 'header',
            parameters: [headerParam]
        });
    }

    if (templateVariables.length > 0) {
        components.push({
            type: 'body',
            parameters: templateVariables.map((text, index) => {
                const parameterName = suppliedParameterNames[index];

                return parameterName
                    ? {
                        type: 'text',
                        parameter_name: parameterName,
                        text,
                    }
                    : {
                        type: 'text',
                        text,
                    };
            }),
        });
    }

    if (components.length > 0) {
        templatePayload.components = components;
    }

    const payload = {
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: 'template',
        template: templatePayload,
    };

    try {
        logWhatsappStage(config, 'META_REQUEST_STARTED', {
            apiVersion: normalizedApiVersion,
            eventType: normalizedEventType,
            templateName: normalizedTemplateName,
            phone: maskPhoneNumber(formattedPhone),
            parameterCount: templateVariables.length,
            payload: buildSafeMetaPayloadLog(payload),
        });

        const response = await axios.post(
            `https://graph.facebook.com/${normalizedApiVersion}/${normalizedPhoneNumberId}/messages`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: config.requestTimeoutMs,
            }
        );

        const providerMessageId = response?.data?.messages?.[0]?.id;
        if (!providerMessageId) {
            const missingIdError = new Error('Provider response did not include a message ID.');
            missingIdError.code = 'MISSING_PROVIDER_MESSAGE_ID';
            throw missingIdError;
        }

        logWhatsappStage(config, 'META_REQUEST_ACCEPTED', {
            httpStatus: response.status || 200,
            providerMessageId,
            logId,
        });
        logWhatsappStatus('SENT', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName,
            phone: maskPhoneNumber(formattedPhone),
            userId,
            logId,
            messageId: providerMessageId,
        });

        try {
            await WhatsappNotificationLog.updateOne(
                { _id: logId },
                {
                    $set: {
                        providerMessageId,
                        status: 'SENT',
                        sentAt: new Date(),
                        errorCode: null,
                        errorMessage: null,
                    },
                }
            );
            logWhatsappStage(config, 'LOG_MARKED_SENT', {
                logId,
                providerMessageId,
            });
        } catch (logUpdateError) {
            void logUpdateError;
        }

        return {
            success: true,
            skipped: false,
            messageId: providerMessageId,
            logId,
            errorDetails: null,
        };
    } catch (error) {
        const safeError = getSafeProviderError(error);

        logWhatsappStage(config, 'META_REQUEST_FAILED', {
            logId,
            errorCode: safeError.errorCode,
            errorMessage: safeError.errorMessage,
        });
        logWhatsappStatus('FAILED', {
            eventType: normalizedEventType,
            templateName: normalizedTemplateName,
            phone: maskPhoneNumber(formattedPhone),
            userId,
            logId,
            errorCode: safeError.errorCode,
            reason: safeError.errorMessage,
        });

        try {
            await WhatsappNotificationLog.updateOne(
                { _id: logId },
                {
                    $set: {
                        status: 'FAILED',
                        failedAt: new Date(),
                        errorCode: safeError.errorCode,
                        errorMessage: safeError.providerMessage || safeError.errorMessage,
                    },
                }
            );
            logWhatsappStage(config, 'LOG_MARKED_FAILED', {
                logId,
                errorCode: safeError.errorCode,
            });
        } catch (logUpdateError) {
            void logUpdateError;
        }

        return {
            success: false,
            skipped: false,
            error: safeError.errorMessage,
            providerMessage: safeError.providerMessage || null,
            errorDetails: safeError,
            logId,
        };
    }
};

const sendWhatsappNotification = ({
    phone,
    templateName,
    parameters = [],
    parameterNames = [],
    eventType = 'GENERIC_NOTIFICATION',
    userId = null,
    idempotencyKey = null,
    metadata = {},
    languageCode,
}) => {
    const config = getWhatsappConfig();
    const normalizedEventType = String(eventType || 'GENERIC_NOTIFICATION').trim().toUpperCase();
    const normalizedTemplateName = String(templateName || '').trim();
    const formattedPhone = formatPhoneNumber(phone, config.defaultCountryCode);

    logWhatsappStage(config, 'FINAL_FUNCTION_CALLED', {
        functionName: 'sendWhatsappNotification',
        eventType: normalizedEventType,
        templateName: normalizedTemplateName || null,
        parameterCount: Array.isArray(parameters) ? parameters.length : null,
        parameterNameCount: Array.isArray(parameterNames) ? parameterNames.length : null,
    });
    logWhatsappStatus('CALL', {
        eventType: normalizedEventType,
        templateName: normalizedTemplateName || null,
        phone: maskPhoneNumber(formattedPhone) || null,
        userId,
    });

    return sendTemplateMessage({
        phone,
        templateName,
        languageCode,
        bodyParameters: parameters,
        parameterNames,
        eventType,
        userId,
        idempotencyKey,
        metadata,
    }).then((result) => {
        logWhatsappStage(config, 'FINAL_FUNCTION_RESULT', {
            functionName: 'sendWhatsappNotification',
            success: Boolean(result?.success),
            skipped: Boolean(result?.skipped),
            logId: result?.logId || null,
            messageId: result?.messageId || null,
            reason: result?.reason || null,
            error: result?.error || null,
        });

        return result;
    });
};

const sendSignupNotification = ({ userId, name, phone, customerId }) => {
    const config = getWhatsappConfig();
    const signupParameters = buildSignupTemplateParameters(config, { name, customerId });

    logWhatsappStage(config, 'SIGNUP_NOTIFICATION_START', {
        hasUserId: Boolean(userId),
        hasName: Boolean(name),
        hasPhone: Boolean(phone),
        hasCustomerId: Boolean(customerId),
    });
    logWhatsappStatus('SIGNUP_START', {
        eventType: SIGNUP_EVENT,
        templateName: config.signupTemplate,
        phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
        userId,
    });

    if (!config.signupEnabled) {
        logWhatsappStatus('SIGNUP_SKIPPED_DISABLED', {
            eventType: SIGNUP_EVENT,
            templateName: config.signupTemplate,
            phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
            userId,
        });

        return Promise.resolve({
            success: false,
            skipped: true,
            reason: 'WhatsApp signup notifications are disabled.',
        });
    }

    return sendWhatsappNotification({
        phone,
        templateName: config.signupTemplate,
        languageCode: config.signupTemplateLanguage || config.templateLanguage,
        parameters: signupParameters,
        eventType: SIGNUP_EVENT,
        userId,
        idempotencyKey: userId ? `signup:${userId}` : null,
        metadata: {
            source: 'USER_SIGNUP',
            signupUserId: userId ? String(userId) : null,
        },
    }).then((result) => {
        logWhatsappStatus(result?.success ? 'SIGNUP_SENT' : result?.skipped ? 'SIGNUP_SKIPPED' : 'SIGNUP_FAILED', {
            eventType: SIGNUP_EVENT,
            templateName: config.signupTemplate,
            phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
            userId,
            logId: result?.logId || null,
            messageId: result?.messageId || null,
            reason: result?.reason || result?.error || null,
            errorCode: result?.errorDetails?.errorCode || null,
        });
        logWhatsappStage(config, 'SIGNUP_NOTIFICATION_RESULT', {
            success: Boolean(result?.success),
            skipped: Boolean(result?.skipped),
            reason: result?.reason || null,
            error: result?.error || null,
            logId: result?.logId || null,
        });

        return result;
    });
};

const sendWhatsappTextMessage = async ({ phone, text }) => {
    const config = getWhatsappConfig();
    const normalizedApiVersion = normalizeApiVersion(config.apiVersion);
    const normalizedPhoneNumberId = normalizePhoneNumberId(config.phoneNumberId);

    if (!config.enabled) {
        return { success: false, skipped: true, reason: 'WhatsApp notifications are disabled.' };
    }

    const configErrors = getWhatsappConfigErrors(config);
    if (configErrors.length > 0) {
        return { success: false, skipped: true, reason: `WhatsApp configuration is incomplete: ${configErrors.join(', ')}` };
    }

    const formattedPhone = formatPhoneNumber(phone, config.defaultCountryCode);
    if (!formattedPhone) {
        return { success: false, skipped: true, reason: 'A valid WhatsApp phone number is unavailable.' };
    }

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formattedPhone,
        type: 'text',
        text: {
            preview_url: false,
            body: text
        }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/${normalizedApiVersion}/${normalizedPhoneNumberId}/messages`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: config.requestTimeoutMs,
            }
        );

        const providerMessageId = response?.data?.messages?.[0]?.id;
        if (!providerMessageId) {
            throw new Error('Provider response did not include a message ID.');
        }

        return { success: true, messageId: providerMessageId };
    } catch (error) {
        const providerError = error?.response?.data?.error || {};
        const errMsg = providerError.message || error.message || 'WhatsApp text message failed.';
        return { success: false, error: errMsg };
    }
};

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB limit

const uploadWhatsappMediaBuffer = async ({ pdfBuffer, filename = 'document.pdf' }) => {
    const config = getWhatsappConfig();
    const normalizedApiVersion = normalizeApiVersion(config.apiVersion);
    const normalizedPhoneNumberId = normalizePhoneNumberId(config.phoneNumberId);

    if (!config.enabled) {
        logWhatsappStatus('SKIPPED_DISABLED', { eventType: 'MEDIA_UPLOAD' });
        return { success: false, skipped: true, reason: 'WhatsApp notifications are disabled.' };
    }

    const configErrors = getWhatsappConfigErrors(config);
    if (configErrors.length > 0) {
        logWhatsappStatus('SKIPPED_INVALID_CONFIG', { eventType: 'MEDIA_UPLOAD', reason: configErrors.join(', ') });
        return { success: false, skipped: true, reason: `WhatsApp configuration is incomplete: ${configErrors.join(', ')}` };
    }

    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        logWhatsappStatus('FAILED_VALIDATION', { eventType: 'MEDIA_UPLOAD', reason: 'Invalid or empty PDF buffer' });
        return { success: false, error: 'Invalid or empty PDF buffer.' };
    }

    if (pdfBuffer.length > MAX_PDF_SIZE_BYTES) {
        logWhatsappStatus('FAILED_OVERSIZED', { eventType: 'MEDIA_UPLOAD', reason: `PDF size exceeds 10MB limit: ${pdfBuffer.length} bytes` });
        return { success: false, error: `PDF buffer exceeds the 10MB limit (${Math.round(pdfBuffer.length / (1024 * 1024))}MB).` };
    }

    const safeFilename = String(filename || 'document.pdf').replace(/[^a-zA-Z0-9._\-\u0900-\u097F]/g, '_');

    logWhatsappStage(config, 'MEDIA_UPLOAD_STARTED', {
        filename: safeFilename,
        sizeBytes: pdfBuffer.length,
        phoneNumberIdLast4: normalizedPhoneNumberId.slice(-4)
    });
    logWhatsappStatus('MEDIA_UPLOAD_STARTED', {
        eventType: 'MEDIA_UPLOAD',
        templateName: safeFilename
    });

    try {
        const formData = new FormData();
        const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
        formData.append('file', blob, safeFilename);
        formData.append('type', 'application/pdf');
        formData.append('messaging_product', 'whatsapp');

        const response = await axios.post(
            `https://graph.facebook.com/${normalizedApiVersion}/${normalizedPhoneNumberId}/media`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`
                },
                timeout: Math.max(config.requestTimeoutMs || 10000, 15000)
            }
        );

        const mediaId = response?.data?.id;
        if (!mediaId) {
            throw new Error('Meta media upload response did not contain an ID.');
        }

        logWhatsappStage(config, 'MEDIA_UPLOAD_SUCCESS', {
            mediaId,
            filename: safeFilename,
            sizeBytes: pdfBuffer.length
        });
        logWhatsappStatus('MEDIA_UPLOAD_SUCCESS', {
            eventType: 'MEDIA_UPLOAD',
            messageId: mediaId
        });

        return { success: true, mediaId };
    } catch (error) {
        const safeError = getSafeProviderError(error);
        logWhatsappStage(config, 'MEDIA_UPLOAD_FAILED', {
            errorCode: safeError.errorCode,
            errorMessage: safeError.errorMessage
        });
        logWhatsappStatus('MEDIA_UPLOAD_FAILED', {
            eventType: 'MEDIA_UPLOAD',
            errorCode: safeError.errorCode,
            reason: safeError.errorMessage
        });

        return {
            success: false,
            error: safeError.errorMessage,
            errorCode: safeError.errorCode
        };
    }
};

const sendWhatsappDocumentByMediaId = async ({ phone, mediaId, filename = 'document.pdf', caption = '' }) => {
    const config = getWhatsappConfig();
    const normalizedApiVersion = normalizeApiVersion(config.apiVersion);
    const normalizedPhoneNumberId = normalizePhoneNumberId(config.phoneNumberId);

    if (!config.enabled) {
        return { success: false, skipped: true, reason: 'WhatsApp notifications are disabled.' };
    }

    const configErrors = getWhatsappConfigErrors(config);
    if (configErrors.length > 0) {
        return { success: false, skipped: true, reason: `WhatsApp configuration is incomplete: ${configErrors.join(', ')}` };
    }

    const formattedPhone = formatPhoneNumber(phone, config.defaultCountryCode);
    if (!formattedPhone) {
        return { success: false, skipped: true, reason: 'A valid WhatsApp phone number is unavailable.' };
    }

    if (!mediaId || typeof mediaId !== 'string') {
        return { success: false, error: 'A valid Meta mediaId string is required.' };
    }

    const safeFilename = String(filename || 'document.pdf').replace(/[^a-zA-Z0-9._\-\u0900-\u097F]/g, '_');
    const safeCaption = String(caption || '').trim().slice(0, 1024);

    logWhatsappStage(config, 'DOCUMENT_SEND_STARTED', {
        phone: maskPhoneNumber(formattedPhone),
        mediaId,
        filename: safeFilename
    });
    logWhatsappStatus('DOCUMENT_SEND_STARTED', {
        eventType: 'DOCUMENT_DISPATCH',
        phone: maskPhoneNumber(formattedPhone),
        messageId: mediaId
    });

    const payload = {
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: 'document',
        document: {
            id: mediaId,
            filename: safeFilename,
            caption: safeCaption
        }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/${normalizedApiVersion}/${normalizedPhoneNumberId}/messages`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: config.requestTimeoutMs
            }
        );

        const providerMessageId = response?.data?.messages?.[0]?.id;
        if (!providerMessageId) {
            throw new Error('Provider response did not include a message ID.');
        }

        logWhatsappStage(config, 'DOCUMENT_SENT', {
            phone: maskPhoneNumber(formattedPhone),
            messageId: providerMessageId,
            mediaId
        });
        logWhatsappStatus('DOCUMENT_SENT', {
            eventType: 'DOCUMENT_DISPATCH',
            phone: maskPhoneNumber(formattedPhone),
            messageId: providerMessageId
        });

        return { success: true, messageId: providerMessageId, mediaId };
    } catch (error) {
        const safeError = getSafeProviderError(error);
        logWhatsappStage(config, 'DOCUMENT_SEND_FAILED', {
            phone: maskPhoneNumber(formattedPhone),
            errorCode: safeError.errorCode,
            errorMessage: safeError.errorMessage
        });
        logWhatsappStatus('DOCUMENT_SEND_FAILED', {
            eventType: 'DOCUMENT_DISPATCH',
            phone: maskPhoneNumber(formattedPhone),
            errorCode: safeError.errorCode,
            reason: safeError.errorMessage
        });

        return {
            success: false,
            error: safeError.errorMessage,
            errorCode: safeError.errorCode
        };
    }
};

const sendWhatsappDocumentBuffer = async ({ phone, pdfBuffer, filename = 'document.pdf', caption = '' }) => {
    const uploadResult = await uploadWhatsappMediaBuffer({ pdfBuffer, filename });
    if (!uploadResult.success) {
        return uploadResult;
    }

    return await sendWhatsappDocumentByMediaId({
        phone,
        mediaId: uploadResult.mediaId,
        filename,
        caption
    });
};

const sendFirstBookingNotification = ({ userId, name, phone, customerId, shipmentId }) => {
    const config = getWhatsappConfig();
    const firstBookingParameters = buildFirstBookingTemplateParameters(config, { name, customerId, shipmentId });
    const firstBookingParameterNames = buildFirstBookingTemplateParameterNames(config);

    logWhatsappStage(config, 'FIRST_BOOKING_NOTIFICATION_START', {
        hasUserId: Boolean(userId),
        hasName: Boolean(name),
        hasPhone: Boolean(phone),
        hasCustomerId: Boolean(customerId),
        hasShipmentId: Boolean(shipmentId),
        whatsappConfig: {
            enabled: config.enabled,
            firstBookingEnabled: config.firstBookingEnabled,
            apiVersion: config.apiVersion,
            phoneNumberIdLast4: normalizePhoneNumberId(config.phoneNumberId).slice(-4) || null,
            businessAccountIdLast4: String(config.businessAccountId || '').trim().slice(-4) || null,
            accessTokenMasked: maskAccessToken(config.accessToken),
            defaultCountryCode: config.defaultCountryCode,
            templateName: config.firstBookingTemplate || null,
            templateLanguage: config.firstBookingTemplateLanguage || config.templateLanguage || null,
            templateParametersEnv: config.firstBookingTemplateParameters || null,
        },
        parameterKeys: firstBookingParameterNames,
        resolvedParameters: {
            name: sanitizeTemplateParameter(name),
            customerId: sanitizeTemplateParameter(customerId),
            shipmentId: sanitizeTemplateParameter(shipmentId),
        },
        resolvedTemplateParameters: firstBookingParameters.map((value) => sanitizeTemplateParameter(value)),
        resolvedTemplateParameterNames: firstBookingParameterNames,
    });
    logWhatsappStatus('FIRST_BOOKING_START', {
        eventType: 'FIRST_BOOKING_SUCCESS',
        templateName: config.firstBookingTemplate,
        phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
        userId,
    });

    if (!config.firstBookingEnabled) {
        logWhatsappStatus('FIRST_BOOKING_SKIPPED_DISABLED', {
            eventType: 'FIRST_BOOKING_SUCCESS',
            templateName: config.firstBookingTemplate,
            phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
            userId,
        });

        return Promise.resolve({
            success: false,
            skipped: true,
            reason: 'WhatsApp first booking notifications are disabled.',
        });
    }

    if (!config.firstBookingTemplate) {
        return Promise.resolve({
            success: false,
            skipped: true,
            reason: 'WhatsApp first booking template is unavailable.',
        });
    }

    return sendWhatsappNotification({
        phone,
        templateName: config.firstBookingTemplate,
        languageCode: config.firstBookingTemplateLanguage || config.templateLanguage,
        parameters: firstBookingParameters,
        parameterNames: firstBookingParameterNames,
        eventType: 'FIRST_BOOKING_SUCCESS',
        userId,
        idempotencyKey: shipmentId ? `first-booking:${userId || 'unknown'}:${shipmentId}` : null,
        metadata: {
            source: 'FIRST_BOOKING',
            firstBookingUserId: userId ? String(userId) : null,
            shipmentId: shipmentId ? String(shipmentId) : null,
        },
    }).then((result) => {
        logWhatsappStatus(result?.success ? 'FIRST_BOOKING_SENT' : result?.skipped ? 'FIRST_BOOKING_SKIPPED' : 'FIRST_BOOKING_FAILED', {
            eventType: 'FIRST_BOOKING_SUCCESS',
            templateName: config.firstBookingTemplate,
            phone: maskPhoneNumber(formatPhoneNumber(phone, config.defaultCountryCode)) || null,
            userId,
            logId: result?.logId || null,
            messageId: result?.messageId || null,
            reason: result?.reason || result?.error || null,
            errorCode: result?.errorDetails?.errorCode || null,
        });
        logWhatsappStage(config, 'FIRST_BOOKING_NOTIFICATION_RESULT', {
            success: Boolean(result?.success),
            skipped: Boolean(result?.skipped),
            reason: result?.reason || null,
            error: result?.error || null,
            logId: result?.logId || null,
        });

        return result;
    });
};

const sendDailyBookingSummaryNotification = ({ userId, name, phone, bookingIdsFormatted, totalCount, businessDate, idempotencyKey = null }) => {
    const config = getWhatsappConfig();
    const eventType = 'DAILY_BOOKING_SUMMARY';
    const templateName = config.dailyBookingSummaryTemplate || 'daily_booking_summary';
    const languageCode = config.dailyBookingSummaryTemplateLanguage || config.templateLanguage;

    if (!config.enabled || !config.dailyBookingSummaryEnabled) {
        return Promise.resolve({
            success: false,
            skipped: true,
            reason: 'WhatsApp daily booking summary notifications are disabled.',
        });
    }

    const safeName = sanitizeTemplateParameter(name || 'Customer');
    const safeCount = sanitizeTemplateParameter(totalCount);
    const safeBookingIds = sanitizeTemplateParameter(bookingIdsFormatted);

    const key = idempotencyKey || `daily-booking-summary:${userId || 'unknown'}:${businessDate || 'today'}`;

    return sendWhatsappNotification({
        phone,
        templateName,
        languageCode,
        parameters: [safeName, safeCount, safeBookingIds],
        parameterNames: ['customer_name', 'total_count', 'booking_ids'],
        eventType,
        userId,
        idempotencyKey: key,
        metadata: {
            source: 'DAILY_BOOKING_SUMMARY_JOB',
            businessDate,
            totalCount,
        },
    });
};

const ALLOWED_WHATSAPP_STATUSES = [
    'shipment received at our hub',
    'received at our hub',
    'in transit',
    'intransit',
    'shipment dispatched',
    'dispatched',
    'out for delivery',
    'delivered',
    'delivery',
];

const normalizeStatusLabel = (status) => {
    const raw = String(status || '').trim().toLowerCase();
    if (raw.includes('received at our hub')) return 'Shipment Received at Our Hub';
    if (raw.includes('in transit') || raw === 'intransit') return 'In Transit';
    if (raw.includes('dispatched')) return 'Shipment Dispatched';
    if (raw.includes('out for delivery')) return 'Out for Delivery';
    if (raw.includes('delivered') || raw === 'delivery') return 'Delivered';
    return null;
};

const sendShipmentStatusNotification = async ({ shipment, newStatus, oldStatus = null }) => {
    const canonicalStatus = normalizeStatusLabel(newStatus);
    if (!canonicalStatus) {
        return {
            success: false,
            skipped: true,
            reason: `Status '${newStatus}' is not in the allowed WhatsApp status update list.`,
        };
    }

    const config = getWhatsappConfig();
    if (!config.enabled || (config.statusUpdateEnabled === false)) {
        return {
            success: false,
            skipped: true,
            reason: 'WhatsApp status update notifications are disabled via configuration.',
        };
    }

    if (!shipment) {
        return {
            success: false,
            skipped: true,
            reason: 'No shipment record provided.',
        };
    }

    const userObj = shipment.user && typeof shipment.user === 'object' ? shipment.user : null;
    const userId = userObj?._id || shipment.user || null;
    const name = userObj?.name || shipment.shipperDetails?.shipperName || 'Customer';
    const phone = userObj?.phone || shipment.shipperDetails?.mobileNo || shipment.shipperDetails?.phone || null;

    if (!phone) {
        return {
            success: false,
            skipped: true,
            reason: 'Recipient phone number is unavailable.',
        };
    }

    const shipmentId = String(shipment.shipmentId || '').trim();
    const trackingNumber = String(shipment.trackingId || shipment.lastMileAWB || shipmentId || '').trim();

    const safeName = sanitizeTemplateParameter(name);
    const safeShipmentId = sanitizeTemplateParameter(shipmentId);
    const safeStatus = sanitizeTemplateParameter(canonicalStatus);
    const safeTracking = sanitizeTemplateParameter(trackingNumber);

    const templateName = config.statusUpdateTemplate || 'daily_report_summary';
    const languageCode = config.statusUpdateTemplateLanguage || config.templateLanguage;
    const normalizedKeyStatus = canonicalStatus.toLowerCase().replace(/\s+/g, '-');
    const idempotencyKey = `status-update:${shipmentId || shipment._id}:${normalizedKeyStatus}`;

    const isDailyReportSummary = templateName === 'daily_report_summary';
    const parameters = isDailyReportSummary
        ? [safeName, safeStatus, safeShipmentId]
        : [safeName, safeShipmentId, safeStatus, safeTracking];
    const parameterNames = isDailyReportSummary
        ? ['customer_name', 'total_count', 'booking_ids']
        : ['customer_name', 'shipment_id', 'status', 'tracking_number'];

    const result = await sendWhatsappNotification({
        phone,
        templateName,
        languageCode,
        parameters,
        parameterNames,
        eventType: 'SHIPMENT_STATUS_UPDATE',
        userId,
        idempotencyKey,
        metadata: {
            shipmentId,
            newStatus: canonicalStatus,
            oldStatus,
        },
    });

    return result;
};

module.exports = {
    sendTemplateMessage,
    sendWhatsappNotification,
    sendSignupNotification,
    sendWhatsappTextMessage,
    uploadWhatsappMediaBuffer,
    sendWhatsappDocumentByMediaId,
    sendWhatsappDocumentBuffer,
    sendFirstBookingNotification,
    sendDailyBookingSummaryNotification,
    sendShipmentStatusNotification,
    normalizeStatusLabel,
    ALLOWED_WHATSAPP_STATUSES,
};
