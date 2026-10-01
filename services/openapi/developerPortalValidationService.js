const mongoose = require('mongoose');
const {
    APPLICATION_STATUSES,
    APPLICATION_STATUS_VALUES,
    APPLICATION_VOLUME_BUCKETS,
    DEVELOPER_ERROR_CODES,
    SLA_TIER_VALUES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^[0-9+\-\s()]{7,20}$/;
const MAX_API_REQUESTS = 10000000;

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const assertPlainObject = (value, path) => {
    if (!isPlainObject(value)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${path} must be an object.`);
    }
};

const assertAllowedKeys = (value, allowedKeys, path) => {
    const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unknown.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            `${path} contains unsupported fields.`,
            { fields: unknown }
        );
    }
};

const requireTrimmedString = (value, path, min, max) => {
    if (typeof value !== 'string') {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${path} is required.`);
    }

    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            `${path} must be between ${min} and ${max} characters.`
        );
    }

    if (trimmed.startsWith('$')) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${path} is invalid.`);
    }

    return trimmed;
};

const requirePositiveInteger = (value, path, max = MAX_API_REQUESTS) => {
    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            `${path} must be a positive integer no greater than ${max}.`
        );
    }
    return value;
};

const requireDate = (value, path) => {
    if (typeof value !== 'string' && !(value instanceof Date)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${path} is required.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${path} must be a valid date.`);
    }
    return date;
};

const validateTechnicalContact = (value) => {
    assertPlainObject(value, 'technicalContact');
    assertAllowedKeys(value, ['name', 'email', 'phone'], 'technicalContact');

    const name = requireTrimmedString(value.name, 'technicalContact.name', 2, 120);
    const email = requireTrimmedString(value.email, 'technicalContact.email', 5, 254).toLowerCase();
    const phone = requireTrimmedString(value.phone, 'technicalContact.phone', 7, 20);

    if (!emailPattern.test(email)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'technicalContact.email must be a valid email address.');
    }

    if (!phonePattern.test(phone)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'technicalContact.phone must be a valid phone number.');
    }

    return { name, email, phone };
};

const validateIntegrationDetails = (value) => {
    assertPlainObject(value, 'integrationDetails');
    assertAllowedKeys(
        value,
        ['useCase', 'expectedMonthlyShipmentVolume', 'volume', 'expectedMonthlyApiRequests', 'description'],
        'integrationDetails'
    );

    const expectedMonthlyShipmentVolume = value.expectedMonthlyShipmentVolume || value.volume;
    if (!APPLICATION_VOLUME_BUCKETS.includes(expectedMonthlyShipmentVolume)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'integrationDetails.expectedMonthlyShipmentVolume must be one of the approved volume buckets.',
            { allowedValues: APPLICATION_VOLUME_BUCKETS }
        );
    }

    return {
        useCase: requireTrimmedString(value.useCase, 'integrationDetails.useCase', 10, 2000),
        expectedMonthlyShipmentVolume,
        expectedMonthlyApiRequests: requirePositiveInteger(
            value.expectedMonthlyApiRequests,
            'integrationDetails.expectedMonthlyApiRequests'
        ),
        description: requireTrimmedString(value.description, 'integrationDetails.description', 10, 4000)
    };
};

const validateAgreements = (value) => {
    assertPlainObject(value, 'agreements');
    assertAllowedKeys(
        value,
        ['termsAccepted', 'walletBillingAccepted', 'rateLimitAccepted', 'customsComplianceAccepted', 'agreementVersion'],
        'agreements'
    );

    const requiredAgreementKeys = [
        'termsAccepted',
        'walletBillingAccepted',
        'rateLimitAccepted',
        'customsComplianceAccepted'
    ];

    const missing = requiredAgreementKeys.filter((key) => value[key] !== true);
    if (missing.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.MANDATORY_AGREEMENT_REQUIRED,
            'All mandatory Partner API agreements must be accepted.',
            { fields: missing }
        );
    }

    return {
        termsAccepted: true,
        walletBillingAccepted: true,
        rateLimitAccepted: true,
        customsComplianceAccepted: true,
        agreementVersion: requireTrimmedString(value.agreementVersion || '1.0', 'agreements.agreementVersion', 1, 40),
        acceptedAt: new Date()
    };
};

const validateProductionUseCase = (value) => {
    assertPlainObject(value, 'productionUseCase');
    assertAllowedKeys(
        value,
        ['description', 'expectedMonthlyShipmentVolume', 'expectedMonthlyApiRequests', 'plannedLaunchDate', 'integrationOwner'],
        'productionUseCase'
    );

    const expectedMonthlyShipmentVolume = value.expectedMonthlyShipmentVolume;
    if (!APPLICATION_VOLUME_BUCKETS.includes(expectedMonthlyShipmentVolume)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'productionUseCase.expectedMonthlyShipmentVolume must be one of the approved volume buckets.',
            { allowedValues: APPLICATION_VOLUME_BUCKETS }
        );
    }

    return {
        description: requireTrimmedString(value.description, 'productionUseCase.description', 10, 4000),
        expectedMonthlyShipmentVolume,
        expectedMonthlyApiRequests: requirePositiveInteger(
            value.expectedMonthlyApiRequests,
            'productionUseCase.expectedMonthlyApiRequests'
        ),
        plannedLaunchDate: requireDate(value.plannedLaunchDate, 'productionUseCase.plannedLaunchDate'),
        integrationOwner: validateTechnicalContact(value.integrationOwner)
    };
};

const validateOperationalDetails = (value) => {
    assertPlainObject(value, 'operationalDetails');
    assertAllowedKeys(value, ['supportContactEmail', 'incidentContactEmail', 'businessHours'], 'operationalDetails');

    const supportContactEmail = requireTrimmedString(value.supportContactEmail, 'operationalDetails.supportContactEmail', 5, 254).toLowerCase();
    const incidentContactEmail = requireTrimmedString(value.incidentContactEmail, 'operationalDetails.incidentContactEmail', 5, 254).toLowerCase();
    if (!emailPattern.test(supportContactEmail)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'operationalDetails.supportContactEmail must be a valid email address.');
    }
    if (!emailPattern.test(incidentContactEmail)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'operationalDetails.incidentContactEmail must be a valid email address.');
    }

    return {
        supportContactEmail,
        incidentContactEmail,
        businessHours: requireTrimmedString(value.businessHours, 'operationalDetails.businessHours', 3, 120)
    };
};

const validateProductionAgreements = (value) => {
    assertPlainObject(value, 'agreements');
    assertAllowedKeys(
        value,
        ['productionTermsAccepted', 'walletBillingAccepted', 'dataAccuracyAccepted', 'complianceResponsibilityAccepted', 'agreementVersion'],
        'agreements'
    );

    const requiredAgreementKeys = [
        'productionTermsAccepted',
        'walletBillingAccepted',
        'dataAccuracyAccepted',
        'complianceResponsibilityAccepted'
    ];

    const missing = requiredAgreementKeys.filter((key) => value[key] !== true);
    if (missing.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.MANDATORY_AGREEMENT_REQUIRED,
            'All mandatory Production API agreements must be accepted.',
            { fields: missing }
        );
    }

    return {
        productionTermsAccepted: true,
        walletBillingAccepted: true,
        dataAccuracyAccepted: true,
        complianceResponsibilityAccepted: true,
        agreementVersion: requireTrimmedString(value.agreementVersion || '1.0', 'agreements.agreementVersion', 1, 40),
        acceptedAt: new Date()
    };
};

const validateOptInPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['technicalContact', 'integrationDetails', 'agreements'], 'request body');

    return {
        technicalContact: validateTechnicalContact(body.technicalContact),
        integrationDetails: validateIntegrationDetails(body.integrationDetails),
        agreements: validateAgreements(body.agreements)
    };
};

const validateApplicationUpdatePayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['technicalContact', 'integrationDetails', 'agreements'], 'request body');

    const updates = {};
    if (body.technicalContact !== undefined) {
        updates.technicalContact = validateTechnicalContact(body.technicalContact);
    }
    if (body.integrationDetails !== undefined) {
        updates.integrationDetails = validateIntegrationDetails(body.integrationDetails);
    }
    if (body.agreements !== undefined) {
        updates.agreements = validateAgreements(body.agreements);
    }

    if (Object.keys(updates).length === 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'At least one editable application section is required.');
    }

    return updates;
};

const validateProductionRequestPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['productionUseCase', 'operationalDetails', 'agreements'], 'request body');

    return {
        productionUseCase: validateProductionUseCase(body.productionUseCase),
        operationalDetails: validateOperationalDetails(body.operationalDetails),
        agreements: validateProductionAgreements(body.agreements)
    };
};

const validateProductionRequestUpdatePayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['productionUseCase', 'operationalDetails', 'agreements'], 'request body');

    const updates = {};
    if (body.productionUseCase !== undefined) {
        updates.productionUseCase = validateProductionUseCase(body.productionUseCase);
    }
    if (body.operationalDetails !== undefined) {
        updates.operationalDetails = validateOperationalDetails(body.operationalDetails);
    }
    if (body.agreements !== undefined) {
        updates.agreements = validateProductionAgreements(body.agreements);
    }

    if (Object.keys(updates).length === 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'At least one editable Production request section is required.');
    }

    return updates;
};

const validateProductionListQuery = (query) => {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const sortBy = ['submittedAt', 'updatedAt', 'status', 'productionRequestId'].includes(query.sortBy)
        ? query.sortBy
        : 'submittedAt';
    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

    const status = query.status && query.status !== 'all' ? query.status : null;
    if (status && !APPLICATION_STATUS_VALUES.includes(status)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'status is invalid.');
    }

    const readinessStatus = query.readinessStatus && query.readinessStatus !== 'all'
        ? requireTrimmedString(query.readinessStatus, 'readinessStatus', 3, 40)
        : null;
    if (readinessStatus && !['ready', 'blocked', 'complete', 'incomplete'].includes(readinessStatus)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'readinessStatus is invalid.');
    }

    const kycStatus = query.kycStatus && query.kycStatus !== 'all'
        ? requireTrimmedString(query.kycStatus, 'kycStatus', 3, 40)
        : null;

    return {
        query: typeof query.query === 'string' ? query.query.trim().slice(0, 120) : '',
        status,
        assignedReviewer: query.assignedReviewer || null,
        kycStatus,
        readinessStatus,
        dateFrom: query.dateFrom ? new Date(query.dateFrom) : null,
        dateTo: query.dateTo ? new Date(query.dateTo) : null,
        page,
        limit,
        sortBy,
        sortOrder
    };
};

const validateProductionReviewerPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['reviewerId'], 'request body');

    if (!mongoose.Types.ObjectId.isValid(body.reviewerId)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'reviewerId must be a valid admin ID.');
    }

    return { reviewerId: body.reviewerId };
};

const validateProductionMoreInfoPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['reason', 'customerMessage', 'missingInformation', 'internalNotes'], 'request body');

    const reason = requireTrimmedString(body.reason, 'reason', 10, 1000);
    const customerMessage = requireTrimmedString(body.customerMessage, 'customerMessage', 10, 2000);
    if (!Array.isArray(body.missingInformation) || body.missingInformation.length === 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'missingInformation is required.');
    }

    const missingInformation = body.missingInformation.map((item, index) => (
        requireTrimmedString(item, `missingInformation.${index}`, 3, 160)
    ));
    const internalNotes = body.internalNotes === undefined
        ? null
        : requireTrimmedString(body.internalNotes, 'internalNotes', 3, 4000);

    return {
        reason,
        customerMessage,
        missingInformation,
        internalNotes
    };
};

const validateProductionRejectPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['reason', 'customerMessage', 'internalNotes', 'allowResubmission'], 'request body');

    return {
        reason: requireTrimmedString(body.reason, 'reason', 10, 1000),
        customerMessage: requireTrimmedString(body.customerMessage, 'customerMessage', 10, 2000),
        internalNotes: body.internalNotes === undefined
            ? null
            : requireTrimmedString(body.internalNotes, 'internalNotes', 3, 4000),
        allowResubmission: body.allowResubmission === true
    };
};

const validateProductionApprovePayload = (body = {}) => {
    assertPlainObject(body || {}, 'request body');
    assertAllowedKeys(body || {}, ['reason', 'customerMessage', 'internalNotes', 'tier'], 'request body');

    const tier = body.tier === undefined ? null : requireTrimmedString(body.tier, 'tier', 3, 40).toUpperCase();
    if (tier && !SLA_TIER_VALUES.includes(tier)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'tier must be one of the approved SLA tiers.',
            { allowedValues: SLA_TIER_VALUES }
        );
    }

    return {
        reason: body.reason === undefined
            ? 'Production access approved after final Super Admin review.'
            : requireTrimmedString(body.reason, 'reason', 10, 1000),
        customerMessage: body.customerMessage === undefined
            ? 'Your Production access has been approved. You can now generate a Live API credential.'
            : requireTrimmedString(body.customerMessage, 'customerMessage', 10, 2000),
        internalNotes: body.internalNotes === undefined
            ? null
            : requireTrimmedString(body.internalNotes, 'internalNotes', 3, 4000),
        tier
    };
};

const validateApprovalPayload = (body) => {
    assertPlainObject(body || {}, 'request body');
    assertAllowedKeys(body || {}, ['notes', 'customerMessage', 'assignedReviewer'], 'request body');

    const payload = {};
    if (body.notes !== undefined) {
        payload.notes = requireTrimmedString(body.notes, 'notes', 3, 4000);
    }
    if (body.customerMessage !== undefined) {
        payload.customerMessage = requireTrimmedString(body.customerMessage, 'customerMessage', 3, 2000);
    }
    if (body.assignedReviewer !== undefined) {
        if (!mongoose.Types.ObjectId.isValid(body.assignedReviewer)) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'assignedReviewer must be a valid admin ID.');
        }
        payload.assignedReviewer = body.assignedReviewer;
    }

    return payload;
};

const validateReviewerPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['assignedReviewer'], 'request body');

    if (!mongoose.Types.ObjectId.isValid(body.assignedReviewer)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'assignedReviewer must be a valid admin ID.');
    }

    return { assignedReviewer: body.assignedReviewer };
};

const validateRejectPayload = (body) => {
    assertPlainObject(body, 'request body');
    assertAllowedKeys(body, ['decision', 'reason', 'customerMessage', 'missingInformation', 'internalNotes'], 'request body');

    if (![APPLICATION_STATUSES.REJECTED, APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED].includes(body.decision)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'decision must be REJECTED or MORE_INFORMATION_REQUIRED.'
        );
    }

    const reason = requireTrimmedString(body.reason, 'reason', 10, 1000);
    const customerMessage = requireTrimmedString(body.customerMessage, 'customerMessage', 10, 2000);
    const internalNotes = body.internalNotes === undefined
        ? null
        : requireTrimmedString(body.internalNotes, 'internalNotes', 3, 4000);

    let missingInformation = [];
    if (body.decision === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED) {
        if (!Array.isArray(body.missingInformation) || body.missingInformation.length === 0) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.INVALID_INPUT,
                'missingInformation is required when requesting more information.'
            );
        }

        missingInformation = body.missingInformation.map((item, index) => (
            requireTrimmedString(item, `missingInformation.${index}`, 3, 160)
        ));
    } else if (body.missingInformation !== undefined) {
        if (!Array.isArray(body.missingInformation)) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'missingInformation must be an array.');
        }
        missingInformation = body.missingInformation.map((item, index) => (
            requireTrimmedString(item, `missingInformation.${index}`, 3, 160)
        ));
    }

    return {
        decision: body.decision,
        reason,
        customerMessage,
        missingInformation,
        internalNotes
    };
};

const validateListQuery = (query) => {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const sortBy = ['submittedAt', 'updatedAt', 'status', 'applicationId'].includes(query.sortBy)
        ? query.sortBy
        : 'submittedAt';
    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

    const status = query.status && query.status !== 'all' ? query.status : null;
    if (status && !APPLICATION_STATUS_VALUES.includes(status)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'status is invalid.');
    }

    return {
        query: typeof query.query === 'string' ? query.query.trim().slice(0, 120) : '',
        status,
        assignedReviewer: query.assignedReviewer || null,
        dateFrom: query.dateFrom ? new Date(query.dateFrom) : null,
        dateTo: query.dateTo ? new Date(query.dateTo) : null,
        page,
        limit,
        sortBy,
        sortOrder
    };
};

module.exports = {
    validateOptInPayload,
    validateApplicationUpdatePayload,
    validateApprovalPayload,
    validateReviewerPayload,
    validateRejectPayload,
    validateProductionRequestPayload,
    validateProductionRequestUpdatePayload,
    validateProductionListQuery,
    validateProductionReviewerPayload,
    validateProductionMoreInfoPayload,
    validateProductionRejectPayload,
    validateProductionApprovePayload,
    validateListQuery
};
