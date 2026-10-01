const mongoose = require('mongoose');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperProductionRequest = require('../../models/DeveloperProductionRequest');
const ApiCredential = require('../../models/ApiCredential');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    DEVELOPER_PERMISSIONS,
    SLA_TIERS
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const {
    validateProductionRequestPayload,
    validateProductionRequestUpdatePayload,
    validateProductionListQuery,
    validateProductionReviewerPayload,
    validateProductionMoreInfoPayload,
    validateProductionRejectPayload,
    validateProductionApprovePayload
} = require('./developerPortalValidationService');
const { assertProductionRequestTransition } = require('./developerPortalTransitionService');
const { createCustomerAudit, createAdminAudit } = require('./developerPortalAuditService');
const { notifyDeveloperApplicationEvent } = require('./developerPortalNotificationService');
const { getReadinessForCustomer } = require('./sandboxSimulatorService');

const ACTIVE_PRODUCTION_STATUSES = DeveloperProductionRequest.ACTIVE_PRODUCTION_REQUEST_STATUSES;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const getCompanyName = (user) => (
    user?.companyName ||
    user?.kycData?.panName ||
    user?.name ||
    null
);

const isKycApproved = (user) => Boolean(user?.kycVerified || user?.kycData?.status === 'verified');

const findCustomerDeveloperAccount = (userId) => DeveloperAccount.findOne({ userId });

const findLatestApplication = (account, userId) => {
    if (!account) return null;
    return DeveloperApplication.findOne({ userId, developerAccountId: account._id }).sort({ createdAt: -1 });
};

const findCurrentProductionRequest = (account, userId, includePrivate = false) => {
    if (!account) return null;
    const query = DeveloperProductionRequest.findOne({ userId, developerAccountId: account._id }).sort({ createdAt: -1 });
    if (includePrivate) {
        query.select('+internalReviewNotes +decisionHistory.internalReviewNotes');
    }
    return query;
};

const safeDate = (value) => value?.toISOString?.() || null;

const getStatusLabel = (status) => {
    const labels = {
        NOT_REQUESTED: 'Production Access Not Requested',
        [APPLICATION_STATUSES.PRODUCTION_REQUESTED]: 'Production Request Submitted',
        [APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW]: 'Production Review in Progress',
        [APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED]: 'More Information Required',
        [APPLICATION_STATUSES.REJECTED]: 'Production Request Rejected',
        [APPLICATION_STATUSES.LIVE_APPROVED]: 'Live Access Approved'
    };
    return labels[status] || status;
};

const getCustomerMessage = (request) => {
    if (!request) {
        return 'Production access has not been requested yet.';
    }
    if (request.customerMessage) {
        return request.customerMessage;
    }
    const messages = {
        [APPLICATION_STATUSES.PRODUCTION_REQUESTED]: 'Your Production access request has been submitted.',
        [APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW]: 'Your Production access request is being reviewed.',
        [APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED]: 'DFL needs more information before Production review can continue.',
        [APPLICATION_STATUSES.REJECTED]: 'Your Production access request cannot be approved at this time.',
        [APPLICATION_STATUSES.LIVE_APPROVED]: 'Your Production access has been approved.'
    };
    return messages[request.status] || 'Your Production access request has been updated.';
};

const getNextStep = (request) => {
    if (!request) return 'Complete Sandbox readiness and submit a Production access request.';
    const steps = {
        [APPLICATION_STATUSES.PRODUCTION_REQUESTED]: 'No action is currently required.',
        [APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW]: 'No action is currently required.',
        [APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED]: 'Provide the requested information and resubmit.',
        [APPLICATION_STATUSES.REJECTED]: request.allowResubmission ? 'Resolve the listed issues before submitting again.' : 'Contact DFL support for next steps.',
        [APPLICATION_STATUSES.LIVE_APPROVED]: 'Generate a Live API credential from the credentials page.'
    };
    return steps[request.status] || 'No action is currently required.';
};

const buildProductionTimeline = (request) => {
    if (!request) {
        return [
            { id: 'submitted', label: 'Production Request Submitted', status: 'pending', updatedAt: null },
            { id: 'review', label: 'Production Review', status: 'pending', updatedAt: null },
            { id: 'approved', label: 'Live Access Approved', status: 'pending', updatedAt: null }
        ];
    }

    const submittedComplete = Boolean(request.submittedAt);
    const reviewStarted = [
        APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
        APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
        APPLICATION_STATUSES.REJECTED,
        APPLICATION_STATUSES.LIVE_APPROVED
    ].includes(request.status);

    return [
        {
            id: 'submitted',
            label: 'Production Request Submitted',
            status: submittedComplete ? 'complete' : 'pending',
            updatedAt: safeDate(request.submittedAt)
        },
        {
            id: 'review',
            label: 'Production Review',
            status: request.status === APPLICATION_STATUSES.PRODUCTION_REQUESTED
                ? 'current'
                : (reviewStarted ? 'complete' : 'pending'),
            updatedAt: safeDate(request.reviewStartedAt || request.updatedAt)
        },
        {
            id: 'approved',
            label: 'Live Access Approved',
            status: request.status === APPLICATION_STATUSES.LIVE_APPROVED ? 'complete' : 'pending',
            updatedAt: request.status === APPLICATION_STATUSES.LIVE_APPROVED ? safeDate(request.decidedAt) : null
        }
    ];
};

const serializeProductionRequest = (request, account) => {
    if (!request) {
        return {
            productionRequest: null,
            status: 'NOT_REQUESTED',
            statusLabel: getStatusLabel('NOT_REQUESTED'),
            accessLevel: account?.accessLevel || ACCESS_LEVELS.NONE,
            customerMessage: getCustomerMessage(null),
            nextStep: getNextStep(null),
            missingInformation: [],
            canResubmit: false,
            liveAccessApproved: account?.accessLevel === ACCESS_LEVELS.LIVE,
            timeline: buildProductionTimeline(null)
        };
    }

    return {
        productionRequestId: request.productionRequestId,
        status: request.status,
        statusLabel: getStatusLabel(request.status),
        accessLevel: account?.accessLevel || ACCESS_LEVELS.NONE,
        customerMessage: getCustomerMessage(request),
        nextStep: getNextStep(request),
        missingInformation: request.missingInformation || [],
        rejectionReason: request.status === APPLICATION_STATUSES.REJECTED ? request.decisionReason : null,
        canResubmit: request.status === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
        liveAccessApproved: account?.accessLevel === ACCESS_LEVELS.LIVE || request.status === APPLICATION_STATUSES.LIVE_APPROVED,
        submittedAt: safeDate(request.submittedAt),
        lastUpdatedAt: safeDate(request.updatedAt),
        productionUseCase: request.productionUseCase,
        operationalDetails: request.operationalDetails,
        agreements: {
            productionTermsAccepted: request.agreements?.productionTermsAccepted,
            walletBillingAccepted: request.agreements?.walletBillingAccepted,
            dataAccuracyAccepted: request.agreements?.dataAccuracyAccepted,
            complianceResponsibilityAccepted: request.agreements?.complianceResponsibilityAccepted,
            agreementVersion: request.agreements?.agreementVersion,
            acceptedAt: safeDate(request.agreements?.acceptedAt)
        },
        timeline: buildProductionTimeline(request)
    };
};

const buildReadiness = async (user) => {
    const [account, sandboxReadiness] = await Promise.all([
        findCustomerDeveloperAccount(user._id),
        getReadinessForCustomer(user)
    ]);
    const [application, productionRequest, activeSandboxCredentials] = await Promise.all([
        findLatestApplication(account, user._id),
        findCurrentProductionRequest(account, user._id),
        account
            ? ApiCredential.countDocuments({
                userId: user._id,
                developerAccountId: account._id,
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
                status: { $in: [CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY] }
            })
            : 0
    ]);

    const profileMissingFields = ['name', 'email', 'phone'].filter((field) => !user?.[field]);
    if (!getCompanyName(user)) profileMissingFields.push('companyName');

    const requiredTestsComplete = (sandboxReadiness.requiredTests || []).every((test) => test.status === 'complete');
    const kycReady = isKycApproved(user);
    const walletReady = typeof user?.walletBalance === 'number' && !user?.isRestricted;
    const accountActive = account?.accountStatus === DEVELOPER_ACCOUNT_STATUSES.ACTIVE;
    const hasSandboxAccess = account?.accessLevel === ACCESS_LEVELS.SANDBOX;
    const alreadyLive = account?.accessLevel === ACCESS_LEVELS.LIVE || productionRequest?.status === APPLICATION_STATUSES.LIVE_APPROVED;
    const hasActiveProductionRequest = productionRequest && ACTIVE_PRODUCTION_STATUSES.includes(productionRequest.status);

    const blockers = [];
    if (!account) blockers.push({ code: 'DEVELOPER_ACCOUNT_REQUIRED', message: 'Developer account was not found.' });
    if (account && !accountActive) blockers.push({ code: 'DEVELOPER_ACCOUNT_NOT_ACTIVE', message: 'Developer account must be active.' });
    if (account && account.accountStatus === DEVELOPER_ACCOUNT_STATUSES.SUSPENDED) blockers.push({ code: DEVELOPER_ERROR_CODES.SECURITY_RESTRICTION, message: 'Developer account is suspended.' });
    if (alreadyLive) blockers.push({ code: DEVELOPER_ERROR_CODES.PRODUCTION_ALREADY_APPROVED, message: 'Live access is already approved.' });
    if (account && !hasSandboxAccess && !alreadyLive) blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_ACCESS_REQUIRED, message: 'Sandbox access is required before Production access can be requested.' });
    if (!account?.sandboxApprovedAt) blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_ACCESS_REQUIRED, message: 'Sandbox approval must be complete.' });
    if (sandboxReadiness.readinessScore < 100) blockers.push({ code: DEVELOPER_ERROR_CODES.PRODUCTION_READINESS_INCOMPLETE, message: 'Sandbox readiness score must be 100.' });
    if (!requiredTestsComplete) blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_TESTS_INCOMPLETE, message: 'All required Sandbox tests must be complete.' });
    if (!kycReady) blockers.push({ code: DEVELOPER_ERROR_CODES.KYC_APPROVAL_REQUIRED, message: 'Customer KYC must be approved.' });
    if (profileMissingFields.length > 0) blockers.push({ code: DEVELOPER_ERROR_CODES.PROFILE_INCOMPLETE, message: 'Customer profile is incomplete.', fields: profileMissingFields });
    if (!walletReady) blockers.push({ code: DEVELOPER_ERROR_CODES.WALLET_NOT_READY, message: 'Wallet must be configured and active.' });
    if (user?.isRestricted) blockers.push({ code: DEVELOPER_ERROR_CODES.SECURITY_RESTRICTION, message: 'Customer account is restricted.' });
    if (activeSandboxCredentials < 1) blockers.push({ code: 'SANDBOX_CREDENTIAL_REQUIRED', message: 'At least one active Sandbox credential is required.' });
    if (hasActiveProductionRequest) blockers.push({ code: DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_ALREADY_EXISTS, message: 'An active Production request already exists.' });

    const data = {
        developerAccountId: account?.developerAccountId || null,
        accessLevel: account?.accessLevel || ACCESS_LEVELS.NONE,
        accountStatus: account?.accountStatus || null,
        sandbox: {
            approved: Boolean(account?.sandboxApprovedAt),
            readinessScore: sandboxReadiness.readinessScore,
            requiredTestsComplete,
            requiredTests: sandboxReadiness.requiredTests || [],
            successfulBookings: sandboxReadiness.summary?.successfulBookings || 0,
            validationTests: sandboxReadiness.summary?.validationTests || ((sandboxReadiness.requiredTests || []).some((test) => test.id === 'validation_error' && test.status === 'complete') ? 1 : 0),
            trackingTests: sandboxReadiness.summary?.trackingTests || 0,
            cancellationTests: sandboxReadiness.summary?.cancellationTests || 0,
            apiRequests: sandboxReadiness.summary?.apiRequests || 0,
            lastTestAt: sandboxReadiness.summary?.lastRunAt || null
        },
        kyc: {
            status: user?.kycData?.status || (user?.kycVerified ? 'verified' : 'not_submitted'),
            ready: kycReady
        },
        profile: {
            complete: profileMissingFields.length === 0,
            missingFields: profileMissingFields
        },
        wallet: {
            configured: typeof user?.walletBalance === 'number',
            status: walletReady ? 'ACTIVE' : 'NOT_READY',
            ready: walletReady
        },
        credentials: {
            activeSandboxCredentials,
            compromisedCredentials: 0,
            ready: activeSandboxCredentials > 0
        },
        compliance: {
            ready: Boolean(application?.agreements?.termsAccepted && application?.agreements?.walletBillingAccepted && application?.agreements?.customsComplianceAccepted),
            blockers: []
        },
        eligibleForProductionRequest: blockers.length === 0,
        blockers,
        productionRequestStatus: productionRequest?.status || 'NOT_REQUESTED',
        productionRequestId: productionRequest?.productionRequestId || null,
        sandboxApplicationId: application?.applicationId || null
    };

    if (!data.compliance.ready) {
        data.compliance.blockers.push('Sandbox application agreements are incomplete.');
        data.blockers.push({ code: DEVELOPER_ERROR_CODES.COMPLIANCE_BLOCKED, message: 'Required Sandbox application agreements are incomplete.' });
        data.eligibleForProductionRequest = false;
    }

    return { data, account, application, productionRequest };
};

const getProductionReadiness = async (user) => {
    const { data } = await buildReadiness(user);
    return data;
};

const buildSnapshot = (readiness) => ({
    readinessScore: readiness.sandbox.readinessScore,
    requiredTestsComplete: readiness.sandbox.requiredTestsComplete,
    successfulBookings: readiness.sandbox.successfulBookings,
    validationTests: readiness.sandbox.validationTests,
    trackingTests: readiness.sandbox.trackingTests,
    cancellationTests: readiness.sandbox.cancellationTests,
    apiRequests: readiness.sandbox.apiRequests,
    capturedAt: new Date()
});

const assertEligibleForProduction = (readiness) => {
    if (!readiness.eligibleForProductionRequest) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_NOT_ELIGIBLE,
            'Production access requirements are not complete.',
            { blockers: readiness.blockers }
        );
    }
};

const assertNoActiveProductionRequest = async (userId) => {
    const existing = await DeveloperProductionRequest.findOne({
        userId,
        status: { $in: ACTIVE_PRODUCTION_STATUSES }
    });
    if (existing) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_ALREADY_EXISTS,
            'An active Production request already exists.'
        );
    }
};

const submitProductionRequest = async (user, body, context = {}) => {
    const payload = validateProductionRequestPayload(body);
    await assertNoActiveProductionRequest(user._id);
    const { data: readiness, account, application } = await buildReadiness(user);
    await assertNoActiveProductionRequest(user._id);
    assertEligibleForProduction(readiness);

    if (!account || !application) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_NOT_ELIGIBLE, 'Sandbox application is required before Production access can be requested.');
    }

    assertProductionRequestTransition(application.status, APPLICATION_STATUSES.PRODUCTION_REQUESTED);

    try {
        const now = new Date();
        const productionRequest = await DeveloperProductionRequest.create({
            userId: user._id,
            developerAccountId: account._id,
            sandboxApplicationId: application._id,
            productionUseCase: payload.productionUseCase,
            operationalDetails: payload.operationalDetails,
            agreements: payload.agreements,
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            sandboxReadinessSnapshot: buildSnapshot(readiness),
            submittedAt: now,
            customerMessage: 'Your Production access request has been submitted.',
            missingInformation: [],
            decisionHistory: [{
                status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
                decidedAt: now,
                reason: 'Customer submitted Production access request.',
                customerMessage: 'Your Production access request has been submitted.'
            }]
        });

        application.status = APPLICATION_STATUSES.PRODUCTION_REQUESTED;
        application.customerMessage = 'Your Production access request has been submitted.';
        application.missingInformation = [];
        application.decisionHistory.push({
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            decidedAt: now,
            reason: 'Customer submitted Production access request.',
            customerMessage: application.customerMessage
        });
        await application.save();

        await createCustomerAudit({
            actorId: user._id,
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_REQUESTED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
            targetId: productionRequest.productionRequestId,
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            previousValue: {
                accessLevel: account.accessLevel,
                productionRequestStatus: 'NOT_REQUESTED'
            },
            newValue: {
                status: productionRequest.status,
                accessLevel: account.accessLevel,
                readinessScore: readiness.sandbox.readinessScore
            },
            reason: 'Customer requested Production API access.',
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent
        });

        await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_REQUESTED, {
            user,
            application: { applicationId: productionRequest.productionRequestId },
            message: productionRequest.customerMessage
        });

        return {
            productionRequestId: productionRequest.productionRequestId,
            developerAccountId: account.developerAccountId,
            status: productionRequest.status,
            accessLevel: account.accessLevel,
            submittedAt: productionRequest.submittedAt.toISOString()
        };
    } catch (error) {
        if (error && error.code === 11000) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_ALREADY_EXISTS,
                'An active Production request already exists.'
            );
        }
        throw error;
    }
};

const getCustomerProductionRequest = async (user) => {
    const account = await findCustomerDeveloperAccount(user._id);
    const request = await findCurrentProductionRequest(account, user._id);
    return serializeProductionRequest(request, account);
};

const updateProductionRequest = async (user, body, context = {}) => {
    const payload = validateProductionRequestUpdatePayload(body);
    const account = await findCustomerDeveloperAccount(user._id);
    const productionRequest = await findCurrentProductionRequest(account, user._id, true);

    if (!productionRequest) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_FOUND, 'Production request was not found.');
    }

    if (productionRequest.status !== APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_REVIEWABLE,
            'Production request can only be updated when more information is required.'
        );
    }

    assertProductionRequestTransition(productionRequest.status, APPLICATION_STATUSES.PRODUCTION_REQUESTED);
    const { data: readiness, application } = await buildReadiness(user);

    if (payload.productionUseCase) productionRequest.productionUseCase = payload.productionUseCase;
    if (payload.operationalDetails) productionRequest.operationalDetails = payload.operationalDetails;
    if (payload.agreements) productionRequest.agreements = payload.agreements;

    const previousStatus = productionRequest.status;
    const now = new Date();
    productionRequest.status = APPLICATION_STATUSES.PRODUCTION_REQUESTED;
    productionRequest.resubmittedAt = now;
    productionRequest.customerMessage = 'Your Production access request has been resubmitted.';
    productionRequest.missingInformation = [];
    productionRequest.allowResubmission = false;
    productionRequest.sandboxReadinessSnapshot = buildSnapshot(readiness);
    productionRequest.decisionHistory.push({
        status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
        decidedAt: now,
        reason: 'Customer resubmitted requested Production information.',
        customerMessage: productionRequest.customerMessage
    });
    await productionRequest.save();

    if (application) {
        application.status = APPLICATION_STATUSES.PRODUCTION_REQUESTED;
        application.customerMessage = productionRequest.customerMessage;
        application.missingInformation = [];
        application.decisionHistory.push({
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            decidedAt: now,
            reason: 'Customer resubmitted requested Production information.',
            customerMessage: productionRequest.customerMessage
        });
        await application.save();
    }

    await createCustomerAudit({
        actorId: user._id,
        action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REQUEST_UPDATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
        targetId: productionRequest.productionRequestId,
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        previousValue: { status: previousStatus },
        newValue: { status: productionRequest.status },
        reason: 'Customer updated Production access request.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return serializeProductionRequest(productionRequest, account);
};

const getAdminIdentity = (admin) => ({
    id: admin?._id?.toString() || null,
    name: admin?.name || null,
    email: admin?.email || null,
    role: admin?.role || null
});

const isProductionReviewer = (admin) => (
    admin?.role === 'super_admin' ||
    (Array.isArray(admin?.permissions) && admin.permissions.includes(DEVELOPER_PERMISSIONS.PRODUCTION_REVIEW))
);

const isTransactionUnsupportedError = (error) => {
    const message = error?.message || '';
    return (
        message.includes('Transaction numbers are only allowed') ||
        message.includes('Transactions are not supported') ||
        message.includes('replica set member or mongos')
    );
};

const runWithOptionalTransaction = async (operation) => {
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await operation(session);
        });
        return result;
    } catch (error) {
        if (isTransactionUnsupportedError(error)) {
            return operation(null);
        }
        throw error;
    } finally {
        await session.endSession();
    }
};

const validateProductionReviewer = async (reviewerId) => {
    const reviewer = await Admin.findById(reviewerId).select('name email role permissions');
    if (!reviewer) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Reviewer was not found.');
    }
    if (!isProductionReviewer(reviewer)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PERMISSION_DENIED, 'Reviewer must have Production review permission.');
    }
    return reviewer;
};

const assertProductionApprover = (admin) => {
    if (admin?.role !== 'super_admin') {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_APPROVAL_PERMISSION_REQUIRED,
            'Final Production approval requires Super Admin authority.'
        );
    }
};

const APPROVABLE_PRODUCTION_STATUSES = Object.freeze([
    APPLICATION_STATUSES.PRODUCTION_REQUESTED,
    APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW
]);

const sessionQuery = (query, session) => (session ? query.session(session) : query);

const buildApprovalContext = async (productionRequest, session = null) => {
    const accountId = productionRequest.developerAccountId?._id || productionRequest.developerAccountId;
    const userId = productionRequest.userId?._id || productionRequest.userId;
    const applicationId = productionRequest.sandboxApplicationId?._id || productionRequest.sandboxApplicationId;

    const [account, user, application, activeSandboxCredentials] = await Promise.all([
        accountId ? sessionQuery(DeveloperAccount.findById(accountId), session) : null,
        userId ? sessionQuery(User.findById(userId), session) : null,
        applicationId ? sessionQuery(DeveloperApplication.findById(applicationId), session) : null,
        accountId
            ? sessionQuery(ApiCredential.countDocuments({
                developerAccountId: accountId,
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
                status: { $in: [CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY] }
            }), session)
            : 0
    ]);

    return {
        account,
        user,
        application,
        activeSandboxCredentials
    };
};

const assertProductionRequestApprovable = (productionRequest) => {
    if (productionRequest.status === APPLICATION_STATUSES.LIVE_APPROVED) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_ALREADY_APPROVED, 'Production access is already approved.');
    }
    if (!APPROVABLE_PRODUCTION_STATUSES.includes(productionRequest.status)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_REVIEWABLE,
            'Production request is not ready for final approval.'
        );
    }
    assertProductionRequestTransition(productionRequest.status, APPLICATION_STATUSES.LIVE_APPROVED);
};

const assertCurrentApprovalRequirements = ({
    productionRequest,
    account,
    user,
    application,
    activeSandboxCredentials
}) => {
    assertProductionRequestApprovable(productionRequest);

    const blockers = [];
    if (!account) {
        blockers.push({ code: 'DEVELOPER_ACCOUNT_REQUIRED', message: 'Developer account was not found.' });
    } else {
        if (account.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE) {
            blockers.push({ code: 'DEVELOPER_ACCOUNT_NOT_ACTIVE', message: 'Developer account must be active.' });
        }
        if (account.accessLevel === ACCESS_LEVELS.LIVE) {
            blockers.push({ code: DEVELOPER_ERROR_CODES.PRODUCTION_ALREADY_APPROVED, message: 'Live access is already enabled.' });
        } else if (account.accessLevel !== ACCESS_LEVELS.SANDBOX) {
            blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_ACCESS_REQUIRED, message: 'Sandbox access must remain active before Live approval.' });
        }
        if (!account.sandboxApprovedAt) {
            blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_ACCESS_REQUIRED, message: 'Sandbox approval must be complete.' });
        }
    }

    if (!user) {
        blockers.push({ code: 'CUSTOMER_REQUIRED', message: 'Customer account was not found.' });
    } else {
        const profileMissingFields = ['name', 'email', 'phone'].filter((field) => !user?.[field]);
        if (!getCompanyName(user)) profileMissingFields.push('companyName');
        if (!isKycApproved(user)) blockers.push({ code: DEVELOPER_ERROR_CODES.KYC_APPROVAL_REQUIRED, message: 'Customer KYC must be approved.' });
        if (profileMissingFields.length > 0) blockers.push({ code: DEVELOPER_ERROR_CODES.PROFILE_INCOMPLETE, message: 'Customer profile is incomplete.', fields: profileMissingFields });
        if (typeof user.walletBalance !== 'number' || user.isRestricted) blockers.push({ code: DEVELOPER_ERROR_CODES.WALLET_NOT_READY, message: 'Wallet must be configured and active.' });
        if (user.isRestricted) blockers.push({ code: DEVELOPER_ERROR_CODES.SECURITY_RESTRICTION, message: 'Customer account is restricted.' });
    }

    if ((productionRequest.sandboxReadinessSnapshot?.readinessScore || 0) < 100) {
        blockers.push({ code: DEVELOPER_ERROR_CODES.PRODUCTION_READINESS_INCOMPLETE, message: 'Sandbox readiness snapshot must be 100.' });
    }
    if (productionRequest.sandboxReadinessSnapshot?.requiredTestsComplete !== true) {
        blockers.push({ code: DEVELOPER_ERROR_CODES.SANDBOX_TESTS_INCOMPLETE, message: 'Required Sandbox tests must be complete.' });
    }
    if (activeSandboxCredentials < 1) {
        blockers.push({ code: 'SANDBOX_CREDENTIAL_REQUIRED', message: 'At least one active Sandbox credential is required.' });
    }
    if (
        !application?.agreements?.termsAccepted ||
        !application?.agreements?.walletBillingAccepted ||
        !application?.agreements?.rateLimitAccepted ||
        !application?.agreements?.customsComplianceAccepted
    ) {
        blockers.push({ code: DEVELOPER_ERROR_CODES.COMPLIANCE_BLOCKED, message: 'Required Sandbox application agreements are incomplete.' });
    }

    if (blockers.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRODUCTION_NOT_ELIGIBLE,
            'Production access cannot be approved until all requirements are current.',
            { blockers }
        );
    }
};

const getProductionRequestCriteria = (requestId) => {
    if (isObjectId(requestId)) {
        return { $or: [{ productionRequestId: requestId }, { _id: requestId }] };
    }
    return { productionRequestId: requestId };
};

const findProductionRequestForAdmin = async (requestId, includePrivate = false) => {
    const query = DeveloperProductionRequest.findOne(getProductionRequestCriteria(requestId))
        .populate('userId', 'name email phone customerId companyName accountType walletBalance kycVerified kycData isRestricted')
        .populate('developerAccountId')
        .populate('sandboxApplicationId')
        .populate('assignedReviewer', 'name email role permissions')
        .populate('decidedBy', 'name email role');

    if (includePrivate) {
        query.select('+internalReviewNotes +decisionHistory.internalReviewNotes');
    }

    const productionRequest = await query;
    if (!productionRequest) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_FOUND, 'Production request was not found.');
    }
    return productionRequest;
};

const getRequestAccount = (productionRequest) => productionRequest.developerAccountId;
const getRequestUser = (productionRequest) => productionRequest.userId;

const mapAdminProductionRequestRow = (productionRequest) => {
    const user = getRequestUser(productionRequest);
    const account = getRequestAccount(productionRequest);
    return {
        productionRequestId: productionRequest.productionRequestId,
        developerAccountId: account?.developerAccountId || null,
        customer: {
            customerId: user?.customerId || null,
            name: user?.name || null,
            companyName: getCompanyName(user),
            email: user?.email || null
        },
        currentAccessLevel: account?.accessLevel || ACCESS_LEVELS.NONE,
        sandboxReadinessScore: productionRequest.sandboxReadinessSnapshot?.readinessScore || 0,
        kycStatus: user?.kycData?.status || (user?.kycVerified ? 'verified' : 'not_submitted'),
        walletReady: typeof user?.walletBalance === 'number' && !user?.isRestricted,
        requestedProductionVolume: productionRequest.productionUseCase?.expectedMonthlyShipmentVolume || null,
        expectedMonthlyApiRequests: productionRequest.productionUseCase?.expectedMonthlyApiRequests || null,
        status: productionRequest.status,
        assignedReviewer: productionRequest.assignedReviewer
            ? getAdminIdentity(productionRequest.assignedReviewer)
            : null,
        submittedAt: safeDate(productionRequest.submittedAt),
        updatedAt: safeDate(productionRequest.updatedAt)
    };
};

const listProductionRequestsForAdmin = async (queryParams) => {
    const params = validateProductionListQuery(queryParams || {});
    const query = {};
    const andConditions = [];

    if (params.status) {
        query.status = params.status;
    }
    if (params.assignedReviewer) {
        if (!isObjectId(params.assignedReviewer)) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'assignedReviewer is invalid.');
        }
        query.assignedReviewer = params.assignedReviewer;
    }
    if (params.dateFrom || params.dateTo) {
        query.submittedAt = {};
        if (params.dateFrom) {
            if (Number.isNaN(params.dateFrom.getTime())) {
                throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'dateFrom is invalid.');
            }
            query.submittedAt.$gte = params.dateFrom;
        }
        if (params.dateTo) {
            if (Number.isNaN(params.dateTo.getTime())) {
                throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'dateTo is invalid.');
            }
            query.submittedAt.$lte = params.dateTo;
        }
    }
    if (params.readinessStatus) {
        if (['ready', 'complete'].includes(params.readinessStatus)) {
            query['sandboxReadinessSnapshot.readinessScore'] = 100;
            query['sandboxReadinessSnapshot.requiredTestsComplete'] = true;
        } else {
            andConditions.push({
                $or: [
                    { 'sandboxReadinessSnapshot.readinessScore': { $lt: 100 } },
                    { 'sandboxReadinessSnapshot.requiredTestsComplete': { $ne: true } }
                ]
            });
        }
    }

    const userCriteria = [];
    if (params.kycStatus) {
        userCriteria.push({ 'kycData.status': params.kycStatus });
    }

    if (params.query) {
        const regex = new RegExp(escapeRegex(params.query), 'i');
        const [users, accounts] = await Promise.all([
            User.find({
                $or: [
                    { name: regex },
                    { email: regex },
                    { companyName: regex },
                    { customerId: regex },
                    { 'kycData.panName': regex }
                ]
            }).select('_id'),
            DeveloperAccount.find({ developerAccountId: regex }).select('_id')
        ]);

        const searchOr = [
            { productionRequestId: regex },
            { 'productionUseCase.integrationOwner.email': regex },
            { 'productionUseCase.integrationOwner.name': regex }
        ];
        if (users.length > 0) {
            searchOr.push({ userId: { $in: users.map((user) => user._id) } });
        }
        if (accounts.length > 0) {
            searchOr.push({ developerAccountId: { $in: accounts.map((account) => account._id) } });
        }
        andConditions.push({ $or: searchOr });
    }

    if (userCriteria.length > 0) {
        const users = await User.find(userCriteria.length === 1 ? userCriteria[0] : { $and: userCriteria }).select('_id');
        query.userId = { $in: users.map((user) => user._id) };
    }
    if (andConditions.length > 0) {
        query.$and = andConditions;
    }

    const sort = { [params.sortBy]: params.sortOrder };
    const skip = (params.page - 1) * params.limit;
    const [total, productionRequests] = await Promise.all([
        DeveloperProductionRequest.countDocuments(query),
        DeveloperProductionRequest.find(query)
            .populate('userId', 'name email phone customerId companyName accountType walletBalance kycVerified kycData isRestricted')
            .populate('developerAccountId')
            .populate('assignedReviewer', 'name email role')
            .sort(sort)
            .skip(skip)
            .limit(params.limit)
    ]);

    return {
        data: productionRequests.map(mapAdminProductionRequestRow),
        pagination: {
            page: params.page,
            limit: params.limit,
            total,
            totalPages: Math.ceil(total / params.limit) || 1
        }
    };
};

const getProductionRequestDetailForAdmin = async (requestId) => {
    const productionRequest = await findProductionRequestForAdmin(requestId, true);
    const user = getRequestUser(productionRequest);
    const account = getRequestAccount(productionRequest);
    const application = productionRequest.sandboxApplicationId;

    const [credentialHealth, auditActivity] = await Promise.all([
        ApiCredential.aggregate([
            { $match: { developerAccountId: account._id } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    lastUsedAt: { $max: '$lastUsedAt' }
                }
            }
        ]),
        DeveloperAuditLog.find({
            $or: [
                { targetId: productionRequest.productionRequestId },
                { developerAccountId: account._id }
            ]
        }).sort({ createdAt: -1 }).limit(40)
    ]);

    const credentialCounts = credentialHealth.reduce((acc, item) => {
        acc[item._id] = item.count;
        if (item.lastUsedAt && (!acc.lastUsedAt || item.lastUsedAt > acc.lastUsedAt)) {
            acc.lastUsedAt = item.lastUsedAt;
        }
        return acc;
    }, {});

    return {
        productionRequest: {
            productionRequestId: productionRequest.productionRequestId,
            status: productionRequest.status,
            statusLabel: getStatusLabel(productionRequest.status),
            productionUseCase: productionRequest.productionUseCase,
            operationalDetails: productionRequest.operationalDetails,
            agreements: {
                productionTermsAccepted: productionRequest.agreements?.productionTermsAccepted,
                walletBillingAccepted: productionRequest.agreements?.walletBillingAccepted,
                dataAccuracyAccepted: productionRequest.agreements?.dataAccuracyAccepted,
                complianceResponsibilityAccepted: productionRequest.agreements?.complianceResponsibilityAccepted,
                agreementVersion: productionRequest.agreements?.agreementVersion,
                acceptedAt: safeDate(productionRequest.agreements?.acceptedAt)
            },
            customerMessage: productionRequest.customerMessage || null,
            missingInformation: productionRequest.missingInformation || [],
            assignedReviewer: productionRequest.assignedReviewer
                ? getAdminIdentity(productionRequest.assignedReviewer)
                : null,
            internalReviewNotes: productionRequest.internalReviewNotes || null,
            decisionReason: productionRequest.decisionReason || null,
            allowResubmission: productionRequest.allowResubmission,
            decisionHistory: productionRequest.decisionHistory || [],
            submittedAt: safeDate(productionRequest.submittedAt),
            reviewStartedAt: safeDate(productionRequest.reviewStartedAt),
            resubmittedAt: safeDate(productionRequest.resubmittedAt),
            decidedAt: safeDate(productionRequest.decidedAt),
            updatedAt: safeDate(productionRequest.updatedAt)
        },
        developerAccount: {
            developerAccountId: account?.developerAccountId || null,
            accessLevel: account?.accessLevel || null,
            accountStatus: account?.accountStatus || null,
            tier: account?.tier || null,
            sandboxApprovedAt: safeDate(account?.sandboxApprovedAt),
            liveApprovedAt: safeDate(account?.liveApprovedAt)
        },
        customer: {
            userId: user?._id?.toString() || null,
            customerId: user?.customerId || null,
            name: user?.name || null,
            companyName: getCompanyName(user),
            email: user?.email || null,
            phone: user?.phone || null,
            accountStatus: user?.isRestricted ? 'RESTRICTED' : 'ACTIVE',
            profileComplete: Boolean(user?.name && user?.email && user?.phone && getCompanyName(user))
        },
        kyc: {
            status: user?.kycData?.status || (user?.kycVerified ? 'verified' : 'not_submitted'),
            verified: isKycApproved(user),
            verifiedAt: safeDate(user?.kycData?.kycVerifiedAt),
            missingItems: isKycApproved(user) ? [] : ['kyc.approval']
        },
        sandbox: {
            applicationId: application?.applicationId || null,
            approvalStatus: application?.status || null,
            sandboxApprovedAt: safeDate(account?.sandboxApprovedAt),
            readinessSnapshot: productionRequest.sandboxReadinessSnapshot,
            failedTestSummary: [],
            criticalUnresolvedErrors: []
        },
        credentialHealth: {
            activeSandboxCredentials: credentialCounts.ACTIVE || 0,
            revokedCredentials: credentialCounts.REVOKED || 0,
            expiredCredentials: credentialCounts.EXPIRED || 0,
            lastUsedAt: safeDate(credentialCounts.lastUsedAt),
            securityStatus: 'OK'
        },
        internalReview: {
            internalReviewNotes: productionRequest.internalReviewNotes || null,
            decisionHistory: productionRequest.decisionHistory || []
        },
        auditActivity: auditActivity.map((audit) => ({
            auditId: audit.auditId,
            action: audit.action,
            actorType: audit.actorType,
            actorRole: audit.actorRole,
            reason: audit.reason,
            createdAt: safeDate(audit.createdAt)
        }))
    };
};

const updateLinkedApplicationForProductionDecision = async (productionRequest, status, payload, admin, now, session = null) => {
    const applicationId = productionRequest.sandboxApplicationId?._id || productionRequest.sandboxApplicationId;
    if (!applicationId) return;
    const application = await DeveloperApplication.findById(applicationId)
        .select('+internalReviewNotes +decisionHistory.internalReviewNotes')
        .session(session);
    if (!application) return;

    application.status = status;
    application.customerMessage = payload.customerMessage || productionRequest.customerMessage || null;
    application.missingInformation = payload.missingInformation || [];
    application.decidedAt = now;
    application.decidedBy = admin._id;
    application.decisionReason = payload.reason || null;
    application.internalReviewNotes = payload.internalNotes || application.internalReviewNotes || null;
    application.decisionHistory.push({
        status,
        decidedAt: now,
        decidedBy: admin._id,
        reason: payload.reason || null,
        customerMessage: payload.customerMessage || null,
        internalReviewNotes: payload.internalNotes || null
    });
    await application.save({ session });
};

const assignProductionReviewer = async (requestId, body, admin, context = {}) => {
    const payload = validateProductionReviewerPayload(body);
    const reviewer = await validateProductionReviewer(payload.reviewerId);
    const productionRequest = await findProductionRequestForAdmin(requestId, true);
    const account = getRequestAccount(productionRequest);
    const user = getRequestUser(productionRequest);

    if (![APPLICATION_STATUSES.PRODUCTION_REQUESTED, APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW].includes(productionRequest.status)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_REVIEWABLE, 'Production request is not reviewable.');
    }

    const previousValue = {
        status: productionRequest.status,
        assignedReviewer: productionRequest.assignedReviewer?._id?.toString?.() || productionRequest.assignedReviewer?.toString?.() || null
    };
    const now = new Date();
    let action = DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REVIEWER_ASSIGNED;

    productionRequest.assignedReviewer = reviewer._id;
    if (productionRequest.status === APPLICATION_STATUSES.PRODUCTION_REQUESTED) {
        assertProductionRequestTransition(productionRequest.status, APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW);
        productionRequest.status = APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW;
        productionRequest.reviewStartedAt = now;
        action = DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REVIEW_STARTED;
        productionRequest.decisionHistory.push({
            status: APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
            decidedAt: now,
            decidedBy: admin._id,
            reason: 'Production review started.',
            internalReviewNotes: 'Reviewer assignment started Production review.'
        });
        await updateLinkedApplicationForProductionDecision(
            productionRequest,
            APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
            { reason: 'Production review started.', internalNotes: 'Reviewer assignment started Production review.' },
            admin,
            now
        );
    }

    await productionRequest.save();

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
        targetId: productionRequest.productionRequestId,
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        previousValue,
        newValue: {
            status: productionRequest.status,
            assignedReviewer: reviewer._id.toString()
        },
        reason: 'Reviewer assigned to Production request.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    await notifyDeveloperApplicationEvent(action, {
        user,
        application: { applicationId: productionRequest.productionRequestId },
        message: 'Your Partner API Production request is under review.'
    });

    return getProductionRequestDetailForAdmin(productionRequest.productionRequestId);
};

const requestMoreProductionInformation = async (requestId, body, admin, context = {}) => {
    const payload = validateProductionMoreInfoPayload(body);
    const productionRequest = await findProductionRequestForAdmin(requestId, true);
    const account = getRequestAccount(productionRequest);
    const user = getRequestUser(productionRequest);

    assertProductionRequestTransition(productionRequest.status, APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED);

    const previousValue = {
        status: productionRequest.status,
        missingInformation: productionRequest.missingInformation || []
    };
    const now = new Date();
    productionRequest.status = APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED;
    productionRequest.customerMessage = payload.customerMessage;
    productionRequest.missingInformation = payload.missingInformation;
    productionRequest.internalReviewNotes = payload.internalNotes || productionRequest.internalReviewNotes || null;
    productionRequest.allowResubmission = true;
    productionRequest.decidedAt = now;
    productionRequest.decidedBy = admin._id;
    productionRequest.decisionReason = payload.reason;
    productionRequest.decisionHistory.push({
        status: APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
        decidedAt: now,
        decidedBy: admin._id,
        reason: payload.reason,
        customerMessage: payload.customerMessage,
        missingInformation: payload.missingInformation,
        internalReviewNotes: payload.internalNotes || null
    });
    await productionRequest.save();
    await updateLinkedApplicationForProductionDecision(
        productionRequest,
        APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
        payload,
        admin,
        now
    );

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_MORE_INFORMATION_REQUIRED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
        targetId: productionRequest.productionRequestId,
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        previousValue,
        newValue: {
            status: productionRequest.status,
            missingInformation: productionRequest.missingInformation
        },
        reason: payload.reason,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.PRODUCTION_MORE_INFORMATION_REQUIRED, {
        user,
        application: { applicationId: productionRequest.productionRequestId },
        message: payload.customerMessage
    });

    return {
        productionRequestId: productionRequest.productionRequestId,
        status: productionRequest.status,
        accessLevel: account.accessLevel,
        customerMessage: productionRequest.customerMessage,
        missingInformation: productionRequest.missingInformation
    };
};

const approveProductionRequest = async (requestId, body, admin, context = {}) => {
    assertProductionApprover(admin);
    const payload = validateProductionApprovePayload(body);
    const productionRequest = await findProductionRequestForAdmin(requestId, true);
    const initialContext = await buildApprovalContext(productionRequest);
    assertCurrentApprovalRequirements({
        productionRequest,
        ...initialContext
    });

    const approved = await runWithOptionalTransaction(async (session) => {
        const freshRequest = await sessionQuery(
            DeveloperProductionRequest.findOne(getProductionRequestCriteria(requestId))
                .select('+internalReviewNotes +decisionHistory.internalReviewNotes'),
            session
        );
        if (!freshRequest) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.PRODUCTION_REQUEST_NOT_FOUND, 'Production request was not found.');
        }

        const approvalContext = await buildApprovalContext(freshRequest, session);
        assertCurrentApprovalRequirements({
            productionRequest: freshRequest,
            ...approvalContext
        });

        const now = new Date();
        const account = approvalContext.account;
        const user = approvalContext.user;
        const approvedTier = payload.tier || account.tier || SLA_TIERS.SILVER;
        const previousValue = {
            status: freshRequest.status,
            accessLevel: account.accessLevel,
            accountStatus: account.accountStatus,
            tier: account.tier || null
        };

        const updatedRequest = await sessionQuery(
            DeveloperProductionRequest.findOneAndUpdate(
                {
                    _id: freshRequest._id,
                    status: { $in: APPROVABLE_PRODUCTION_STATUSES }
                },
                {
                    $set: {
                        status: APPLICATION_STATUSES.LIVE_APPROVED,
                        customerMessage: payload.customerMessage,
                        missingInformation: [],
                        internalReviewNotes: payload.internalNotes || freshRequest.internalReviewNotes || null,
                        allowResubmission: false,
                        reviewStartedAt: freshRequest.reviewStartedAt || now,
                        decidedAt: now,
                        decidedBy: admin._id,
                        decisionReason: payload.reason
                    },
                    $push: {
                        decisionHistory: {
                            status: APPLICATION_STATUSES.LIVE_APPROVED,
                            decidedAt: now,
                            decidedBy: admin._id,
                            reason: payload.reason,
                            customerMessage: payload.customerMessage,
                            internalReviewNotes: payload.internalNotes || null
                        }
                    }
                },
                { returnDocument: 'after' }
            ).select('+internalReviewNotes +decisionHistory.internalReviewNotes'),
            session
        );
        if (!updatedRequest) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.PRODUCTION_APPROVAL_CONFLICT,
                'Production request was updated before approval could complete.'
            );
        }

        const updatedAccount = await sessionQuery(
            DeveloperAccount.findOneAndUpdate(
                {
                    _id: account._id,
                    accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                    accessLevel: ACCESS_LEVELS.SANDBOX
                },
                {
                    $set: {
                        accessLevel: ACCESS_LEVELS.LIVE,
                        accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                        tier: approvedTier,
                        liveApprovedAt: now,
                        liveApprovedBy: admin._id
                    }
                },
                { returnDocument: 'after' }
            ),
            session
        );
        if (!updatedAccount) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.PRODUCTION_APPROVAL_CONFLICT,
                'Developer account changed before Live access could be enabled.'
            );
        }

        await updateLinkedApplicationForProductionDecision(
            updatedRequest,
            APPLICATION_STATUSES.LIVE_APPROVED,
            payload,
            admin,
            now,
            session
        );

        await createAdminAudit({
            actorId: admin._id,
            actorRole: admin.role,
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_APPROVED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
            targetId: updatedRequest.productionRequestId,
            userId: user._id,
            developerAccountId: updatedAccount._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            previousValue,
            newValue: {
                status: updatedRequest.status,
                accessLevel: updatedAccount.accessLevel,
                accountStatus: updatedAccount.accountStatus,
                tier: updatedAccount.tier,
                liveApprovedAt: now.toISOString()
            },
            reason: payload.reason,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            session
        });

        await createAdminAudit({
            actorId: admin._id,
            actorRole: admin.role,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_ACCESS_ENABLED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.DEVELOPER_ACCOUNT,
            targetId: updatedAccount.developerAccountId,
            userId: user._id,
            developerAccountId: updatedAccount._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            previousValue: {
                accessLevel: previousValue.accessLevel,
                liveApprovedAt: account.liveApprovedAt?.toISOString?.() || null
            },
            newValue: {
                accessLevel: updatedAccount.accessLevel,
                liveApprovedAt: now.toISOString(),
                liveApprovedBy: admin._id.toString()
            },
            reason: payload.reason,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            session
        });

        return {
            productionRequestId: updatedRequest.productionRequestId,
            developerAccountId: updatedAccount.developerAccountId,
            status: updatedRequest.status,
            accessLevel: updatedAccount.accessLevel,
            accountStatus: updatedAccount.accountStatus,
            tier: updatedAccount.tier,
            liveApprovedAt: now.toISOString(),
            approvedBy: getAdminIdentity(admin),
            customerMessage: updatedRequest.customerMessage
        };
    });

    await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_APPROVED, {
        user: initialContext.user,
        application: { applicationId: productionRequest.productionRequestId },
        message: payload.customerMessage
    });

    return approved;
};

const rejectProductionRequest = async (requestId, body, admin, context = {}) => {
    const payload = validateProductionRejectPayload(body);
    const productionRequest = await findProductionRequestForAdmin(requestId, true);
    const account = getRequestAccount(productionRequest);
    const user = getRequestUser(productionRequest);

    assertProductionRequestTransition(productionRequest.status, APPLICATION_STATUSES.REJECTED);

    const previousValue = {
        status: productionRequest.status,
        accessLevel: account.accessLevel
    };
    const now = new Date();
    productionRequest.status = APPLICATION_STATUSES.REJECTED;
    productionRequest.customerMessage = payload.customerMessage;
    productionRequest.missingInformation = [];
    productionRequest.internalReviewNotes = payload.internalNotes || productionRequest.internalReviewNotes || null;
    productionRequest.allowResubmission = payload.allowResubmission;
    productionRequest.decidedAt = now;
    productionRequest.decidedBy = admin._id;
    productionRequest.decisionReason = payload.reason;
    productionRequest.decisionHistory.push({
        status: APPLICATION_STATUSES.REJECTED,
        decidedAt: now,
        decidedBy: admin._id,
        reason: payload.reason,
        customerMessage: payload.customerMessage,
        internalReviewNotes: payload.internalNotes || null
    });
    await productionRequest.save();
    await updateLinkedApplicationForProductionDecision(
        productionRequest,
        APPLICATION_STATUSES.REJECTED,
        payload,
        admin,
        now
    );

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REQUEST_REJECTED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.PRODUCTION_REQUEST,
        targetId: productionRequest.productionRequestId,
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        previousValue,
        newValue: {
            status: productionRequest.status,
            accessLevel: account.accessLevel,
            allowResubmission: productionRequest.allowResubmission
        },
        reason: payload.reason,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REQUEST_REJECTED, {
        user,
        application: { applicationId: productionRequest.productionRequestId },
        message: payload.customerMessage
    });

    return {
        productionRequestId: productionRequest.productionRequestId,
        status: productionRequest.status,
        accessLevel: account.accessLevel,
        customerMessage: productionRequest.customerMessage,
        decisionReason: productionRequest.decisionReason,
        allowResubmission: productionRequest.allowResubmission
    };
};

module.exports = {
    getProductionReadiness,
    getCustomerProductionRequest,
    submitProductionRequest,
    updateProductionRequest,
    listProductionRequestsForAdmin,
    getProductionRequestDetailForAdmin,
    assignProductionReviewer,
    requestMoreProductionInformation,
    approveProductionRequest,
    rejectProductionRequest,
    serializeProductionRequest
};
