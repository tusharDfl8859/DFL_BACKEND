const mongoose = require('mongoose');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const {
    ACCESS_LEVELS,
    ACTIVE_APPLICATION_STATUSES,
    APPLICATION_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const {
    validateOptInPayload,
    validateApplicationUpdatePayload,
    validateApprovalPayload,
    validateReviewerPayload,
    validateRejectPayload,
    validateListQuery
} = require('./developerPortalValidationService');
const { assertApplicationTransition } = require('./developerPortalTransitionService');
const { buildCustomerStatus } = require('./developerPortalStatusService');
const { createCustomerAudit, createAdminAudit } = require('./developerPortalAuditService');
const { notifyDeveloperApplicationEvent } = require('./developerPortalNotificationService');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getCompanyName = (user) => (
    user?.companyName ||
    user?.kycData?.panName ||
    user?.name ||
    null
);

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const toPlainAuditValue = (value) => {
    if (value === null || value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
};

const safeProfileSummary = (user) => ({
    userId: user?._id?.toString(),
    customerId: user?.customerId || null,
    name: user?.name || null,
    companyName: getCompanyName(user),
    email: user?.email || null,
    phone: user?.phone || user?.contactNumber || null,
    accountType: user?.accountType || null,
    isRestricted: Boolean(user?.isRestricted),
    kycVerified: Boolean(user?.kycVerified),
    kycStatus: user?.kycData?.status || 'not_submitted',
    walletBalance: typeof user?.walletBalance === 'number' ? user.walletBalance : 0
});

const serializeCustomerApplication = (application) => {
    if (!application) {
        return null;
    }

    return {
        applicationId: application.applicationId,
        status: application.status,
        technicalContact: application.technicalContact,
        integrationDetails: application.integrationDetails,
        submittedAt: application.submittedAt?.toISOString() || null,
        lastUpdatedAt: application.updatedAt?.toISOString() || null,
        customerMessage: application.customerMessage || null,
        decisionReason: application.decisionReason || null,
        missingInformation: application.missingInformation || []
    };
};

const serializeDeveloperAccount = (account) => {
    if (!account) {
        return null;
    }

    return {
        developerAccountId: account.developerAccountId,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus,
        tier: account.tier || null,
        sandboxApprovedAt: account.sandboxApprovedAt?.toISOString() || null,
        liveApprovedAt: account.liveApprovedAt?.toISOString() || null
    };
};

const findCustomerDeveloperAccount = (userId) => DeveloperAccount.findOne({ userId });

const findCurrentCustomerApplication = async (account, userId) => {
    if (!account) {
        return null;
    }

    return DeveloperApplication.findOne({ userId, developerAccountId: account._id })
        .sort({ createdAt: -1 });
};

const validateExistingCustomer = (user) => {
    if (!user) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.AUTHENTICATION_REQUIRED, 'Customer authentication is required.');
    }

    if (user.isRestricted) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CUSTOMER_ACCOUNT_RESTRICTED, 'Customer account is restricted.');
    }

    const missingProfileFields = ['name', 'email', 'phone'].filter((field) => !user[field]);
    if (missingProfileFields.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'Customer profile is incomplete.',
            { fields: missingProfileFields }
        );
    }

    if (!user.kycData || !user.kycData.status) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Customer KYC state is unavailable.');
    }

    if (typeof user.walletBalance !== 'number') {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Customer wallet state is unavailable.');
    }
};

const getOrCreateDeveloperAccount = async (user) => {
    let account;
    try {
        account = await DeveloperAccount.findOneAndUpdate(
            { userId: user._id },
            {
                $setOnInsert: {
                    userId: user._id,
                    accessLevel: ACCESS_LEVELS.NONE,
                    accountStatus: DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW
                }
            },
            {
                upsert: true,
                returnDocument: 'after',
                setDefaultsOnInsert: true,
                runValidators: true
            }
        );
    } catch (error) {
        if (error && error.code === 11000) {
            account = await DeveloperAccount.findOne({ userId: user._id });
        } else {
            throw error;
        }
    }

    if (account.accessLevel !== ACCESS_LEVELS.NONE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.RESOURCE_CONFLICT,
            'Developer account already has API access.'
        );
    }

    if ([DEVELOPER_ACCOUNT_STATUSES.REVOKED, DEVELOPER_ACCOUNT_STATUSES.SUSPENDED].includes(account.accountStatus)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.RESOURCE_CONFLICT,
            'Developer account is not eligible for a new application.'
        );
    }

    if (account.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW) {
        account.accountStatus = DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW;
        await account.save();
    }

    return account;
};

const assertNoActiveApplication = async (userId) => {
    const activeApplication = await DeveloperApplication.findOne({
        userId,
        status: { $in: ACTIVE_APPLICATION_STATUSES }
    });

    if (activeApplication) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.APPLICATION_ALREADY_EXISTS,
            'An active Partner API application already exists.'
        );
    }
};

const getCustomerApplicationState = async (user) => {
    const account = await findCustomerDeveloperAccount(user._id);
    const application = await findCurrentCustomerApplication(account, user._id);

    return {
        application: serializeCustomerApplication(application),
        developerAccount: serializeDeveloperAccount(account),
        canSubmitApplication: !application || application.status === APPLICATION_STATUSES.REJECTED,
        canRequestProduction: false
    };
};

const submitOptIn = async (user, body, context = {}) => {
    validateExistingCustomer(user);
    const payload = validateOptInPayload(body);
    await assertNoActiveApplication(user._id);

    const account = await getOrCreateDeveloperAccount(user);

    try {
        const application = await DeveloperApplication.create({
            userId: user._id,
            developerAccountId: account._id,
            technicalContact: payload.technicalContact,
            integrationDetails: payload.integrationDetails,
            agreements: payload.agreements,
            status: APPLICATION_STATUSES.SUBMITTED,
            submittedAt: new Date(),
            customerMessage: null,
            decisionReason: null,
            missingInformation: [],
            decisionHistory: [{
                status: APPLICATION_STATUSES.SUBMITTED,
                decidedAt: new Date(),
                reason: 'Customer submitted Partner API opt-in request.',
                customerMessage: null
            }]
        });

        await createCustomerAudit({
            actorId: user._id,
            action: DEVELOPER_AUDIT_ACTIONS.APPLICATION_SUBMITTED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.DEVELOPER_APPLICATION,
            targetId: application.applicationId,
            userId: user._id,
            developerAccountId: account._id,
            previousValue: null,
            newValue: {
                status: application.status,
                accessLevel: account.accessLevel,
                expectedMonthlyShipmentVolume: application.integrationDetails.expectedMonthlyShipmentVolume
            },
            reason: 'Customer submitted Partner API opt-in.',
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent
        });

        await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.APPLICATION_SUBMITTED, {
            user,
            application,
            message: 'Your Partner API access request has been submitted.'
        });

        return {
            applicationId: application.applicationId,
            developerAccountId: account.developerAccountId,
            status: application.status,
            accessLevel: account.accessLevel,
            submittedAt: application.submittedAt.toISOString()
        };
    } catch (error) {
        if (error && error.code === 11000) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.APPLICATION_ALREADY_EXISTS,
                'An active Partner API application already exists.'
            );
        }
        throw error;
    }
};

const updateCustomerApplication = async (user, body, context = {}) => {
    validateExistingCustomer(user);
    const payload = validateApplicationUpdatePayload(body);
    const account = await findCustomerDeveloperAccount(user._id);
    const application = await findCurrentCustomerApplication(account, user._id);

    if (!application) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.APPLICATION_NOT_FOUND, 'Partner API application was not found.');
    }

    assertApplicationTransition(application.status, APPLICATION_STATUSES.SUBMITTED);

    const previousValue = {
        status: application.status,
        technicalContact: toPlainAuditValue(application.technicalContact),
        integrationDetails: toPlainAuditValue(application.integrationDetails),
        missingInformation: application.missingInformation
    };

    if (payload.technicalContact) {
        application.technicalContact = payload.technicalContact;
    }
    if (payload.integrationDetails) {
        application.integrationDetails = payload.integrationDetails;
    }
    if (payload.agreements) {
        application.agreements = payload.agreements;
    }

    application.status = APPLICATION_STATUSES.SUBMITTED;
    application.customerMessage = null;
    application.decisionReason = null;
    application.missingInformation = [];
    application.decisionHistory.push({
        status: APPLICATION_STATUSES.SUBMITTED,
        decidedAt: new Date(),
        reason: 'Customer resubmitted requested Partner API information.',
        customerMessage: null
    });
    await application.save();

    account.accountStatus = DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW;
    await account.save();

    await createCustomerAudit({
        actorId: user._id,
        action: DEVELOPER_AUDIT_ACTIONS.APPLICATION_UPDATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.DEVELOPER_APPLICATION,
        targetId: application.applicationId,
        userId: user._id,
        developerAccountId: account._id,
        previousValue,
        newValue: {
            status: application.status,
            technicalContact: toPlainAuditValue(application.technicalContact),
            integrationDetails: toPlainAuditValue(application.integrationDetails)
        },
        reason: 'Customer updated Partner API application.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return {
        application: serializeCustomerApplication(application),
        developerAccount: serializeDeveloperAccount(account)
    };
};

const getCustomerStatus = async (user) => {
    const account = await findCustomerDeveloperAccount(user._id);
    const application = await findCurrentCustomerApplication(account, user._id);
    return buildCustomerStatus({ application, developerAccount: account });
};

const findApplicationForAdmin = async (id, includePrivate = false) => {
    const criteria = { applicationId: id };
    if (isObjectId(id)) {
        criteria.$or = [{ applicationId: id }, { _id: id }];
        delete criteria.applicationId;
    }

    const query = DeveloperApplication.findOne(criteria)
        .populate('userId', 'name email phone customerId companyName accountType walletBalance kycVerified kycData isRestricted')
        .populate('developerAccountId')
        .populate('assignedReviewer', 'name email role permissions')
        .populate('decidedBy', 'name email role');

    if (includePrivate) {
        query.select('+internalReviewNotes +decisionHistory.internalReviewNotes');
    }

    const application = await query;
    if (!application) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.APPLICATION_NOT_FOUND, 'Partner API application was not found.');
    }

    return application;
};

const mapAdminApplicationRow = (application) => {
    const user = application.userId;
    const account = application.developerAccountId;
    return {
        applicationId: application.applicationId,
        developerAccountId: account?.developerAccountId || null,
        companyName: getCompanyName(user),
        primaryContact: user?.name || null,
        email: user?.email || null,
        technicalContact: {
            name: application.technicalContact?.name || null,
            email: application.technicalContact?.email || null
        },
        useCase: application.integrationDetails?.useCase || null,
        expectedMonthlyShipmentVolume: application.integrationDetails?.expectedMonthlyShipmentVolume || null,
        status: application.status,
        assignedReviewer: application.assignedReviewer
            ? {
                id: application.assignedReviewer._id.toString(),
                name: application.assignedReviewer.name,
                email: application.assignedReviewer.email
            }
            : null,
        submittedAt: application.submittedAt?.toISOString() || null,
        updatedAt: application.updatedAt?.toISOString() || null
    };
};

const listApplicationsForAdmin = async (queryParams) => {
    const params = validateListQuery(queryParams);
    const query = {};

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

    if (params.query) {
        const regex = new RegExp(escapeRegex(params.query), 'i');
        const [users, accounts] = await Promise.all([
            User.find({
                $or: [
                    { name: regex },
                    { email: regex },
                    { 'kycData.panName': regex }
                ]
            }).select('_id'),
            DeveloperAccount.find({ developerAccountId: regex }).select('_id')
        ]);

        query.$or = [
            { applicationId: regex },
            { 'technicalContact.email': regex },
            { 'technicalContact.name': regex }
        ];

        if (users.length > 0) {
            query.$or.push({ userId: { $in: users.map((user) => user._id) } });
        }

        if (accounts.length > 0) {
            query.$or.push({ developerAccountId: { $in: accounts.map((account) => account._id) } });
        }
    }

    const sort = { [params.sortBy]: params.sortOrder };
    const skip = (params.page - 1) * params.limit;

    const [total, applications] = await Promise.all([
        DeveloperApplication.countDocuments(query),
        DeveloperApplication.find(query)
            .populate('userId', 'name email phone customerId companyName accountType walletBalance kycVerified kycData isRestricted')
            .populate('developerAccountId')
            .populate('assignedReviewer', 'name email role')
            .sort(sort)
            .skip(skip)
            .limit(params.limit)
    ]);

    return {
        data: applications.map(mapAdminApplicationRow),
        pagination: {
            page: params.page,
            limit: params.limit,
            total,
            totalPages: Math.ceil(total / params.limit) || 1
        }
    };
};

const getApplicationDetailForAdmin = async (id) => {
    const application = await findApplicationForAdmin(id, true);
    const user = application.userId;
    const account = application.developerAccountId;
    const audits = await DeveloperAuditLog.find({
        $or: [
            { targetId: application.applicationId },
            { developerAccountId: account?._id }
        ]
    }).sort({ createdAt: -1 }).limit(25);

    return {
        application: {
            applicationId: application.applicationId,
            status: application.status,
            technicalContact: application.technicalContact,
            integrationDetails: application.integrationDetails,
            agreements: {
                termsAccepted: application.agreements?.termsAccepted,
                walletBillingAccepted: application.agreements?.walletBillingAccepted,
                rateLimitAccepted: application.agreements?.rateLimitAccepted,
                customsComplianceAccepted: application.agreements?.customsComplianceAccepted,
                acceptedAt: application.agreements?.acceptedAt?.toISOString() || null,
                agreementVersion: application.agreements?.agreementVersion || null
            },
            assignedReviewer: application.assignedReviewer
                ? {
                    id: application.assignedReviewer._id.toString(),
                    name: application.assignedReviewer.name,
                    email: application.assignedReviewer.email
                }
                : null,
            customerMessage: application.customerMessage || null,
            decisionReason: application.decisionReason || null,
            missingInformation: application.missingInformation || [],
            internalReviewNotes: application.internalReviewNotes || null,
            decisionHistory: application.decisionHistory || [],
            submittedAt: application.submittedAt?.toISOString() || null,
            reviewStartedAt: application.reviewStartedAt?.toISOString() || null,
            decidedAt: application.decidedAt?.toISOString() || null,
            updatedAt: application.updatedAt?.toISOString() || null
        },
        developerAccount: serializeDeveloperAccount(account),
        customer: safeProfileSummary(user),
        company: {
            companyName: getCompanyName(user),
            accountType: user?.accountType || null
        },
        kyc: {
            verified: Boolean(user?.kycVerified),
            status: user?.kycData?.status || 'not_submitted',
            submittedAt: user?.kycData?.kycSubmittedAt?.toISOString?.() || null,
            verifiedAt: user?.kycData?.kycVerifiedAt?.toISOString?.() || null
        },
        walletReadiness: {
            walletBalance: typeof user?.walletBalance === 'number' ? user.walletBalance : 0,
            walletAvailable: typeof user?.walletBalance === 'number',
            liveBillingNotEnabledInStep2: true
        },
        auditActivity: audits.map((audit) => ({
            auditId: audit.auditId,
            action: audit.action,
            actorType: audit.actorType,
            actorRole: audit.actorRole,
            reason: audit.reason,
            createdAt: audit.createdAt?.toISOString() || null
        }))
    };
};

const validateAdminReviewer = async (adminId) => {
    const admin = await Admin.findById(adminId).select('name email role permissions');
    if (!admin) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Assigned reviewer was not found.');
    }
    return admin;
};

const assignReviewer = async (id, body, admin, context = {}) => {
    const payload = validateReviewerPayload(body);
    const application = await findApplicationForAdmin(id, true);
    const reviewer = await validateAdminReviewer(payload.assignedReviewer);
    const previousValue = {
        status: application.status,
        assignedReviewer: application.assignedReviewer?.toString() || null
    };

    application.assignedReviewer = reviewer._id;
    if (application.status === APPLICATION_STATUSES.SUBMITTED) {
        assertApplicationTransition(application.status, APPLICATION_STATUSES.UNDER_REVIEW);
        application.status = APPLICATION_STATUSES.UNDER_REVIEW;
        application.reviewStartedAt = new Date();
        application.decisionHistory.push({
            status: APPLICATION_STATUSES.UNDER_REVIEW,
            decidedAt: new Date(),
            decidedBy: admin._id,
            reason: 'Application review started.',
            internalReviewNotes: 'Reviewer assignment started review.'
        });
    }

    await application.save();

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action: DEVELOPER_AUDIT_ACTIONS.REVIEWER_ASSIGNED,
        targetId: application.applicationId,
        userId: application.userId?._id || application.userId,
        developerAccountId: application.developerAccountId?._id || application.developerAccountId,
        previousValue,
        newValue: {
            status: application.status,
            assignedReviewer: reviewer._id.toString()
        },
        reason: 'Reviewer assigned to Partner API application.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return getApplicationDetailForAdmin(application.applicationId);
};

const approveSandbox = async (id, body, admin, context = {}) => {
    const payload = validateApprovalPayload(body || {});
    const application = await findApplicationForAdmin(id, true);
    const account = application.developerAccountId;
    const user = application.userId;

    if (!account || !user) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.APPLICATION_NOT_FOUND, 'Application relationship is incomplete.');
    }

    if ([ACCESS_LEVELS.SANDBOX, ACCESS_LEVELS.LIVE].includes(account.accessLevel)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_ALREADY_APPROVED, 'Sandbox access has already been approved.');
    }

    if (user.isRestricted) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CUSTOMER_ACCOUNT_RESTRICTED, 'Customer account is restricted.');
    }

    if (!application.agreements?.termsAccepted || !application.agreements?.walletBillingAccepted || !application.agreements?.rateLimitAccepted || !application.agreements?.customsComplianceAccepted) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANDATORY_AGREEMENT_REQUIRED, 'Required agreements are incomplete.');
    }

    assertApplicationTransition(application.status, APPLICATION_STATUSES.SANDBOX_APPROVED);

    let assignedReviewer = null;
    if (payload.assignedReviewer) {
        assignedReviewer = await validateAdminReviewer(payload.assignedReviewer);
    }

    const previousValue = {
        status: application.status,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus
    };

    const now = new Date();
    application.status = APPLICATION_STATUSES.SANDBOX_APPROVED;
    application.assignedReviewer = assignedReviewer?._id || application.assignedReviewer || admin._id;
    application.decidedAt = now;
    application.decidedBy = admin._id;
    application.decisionReason = payload.notes || 'Sandbox access approved.';
    application.customerMessage = payload.customerMessage || 'Your Sandbox access has been approved.';
    application.internalReviewNotes = payload.notes || null;
    application.missingInformation = [];
    application.decisionHistory.push({
        status: APPLICATION_STATUSES.SANDBOX_APPROVED,
        decidedAt: now,
        decidedBy: admin._id,
        reason: application.decisionReason,
        customerMessage: application.customerMessage,
        internalReviewNotes: payload.notes || null
    });

    account.accessLevel = ACCESS_LEVELS.SANDBOX;
    account.accountStatus = DEVELOPER_ACCOUNT_STATUSES.ACTIVE;
    account.sandboxApprovedAt = now;
    account.suspendedAt = null;
    account.suspensionReason = null;
    account.revokedAt = null;
    account.revocationReason = null;

    await account.save();
    await application.save();

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_APPROVED,
        targetId: application.applicationId,
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        previousValue,
        newValue: {
            status: application.status,
            accessLevel: account.accessLevel,
            accountStatus: account.accountStatus
        },
        reason: payload.notes || 'Sandbox access approved.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    await notifyDeveloperApplicationEvent(DEVELOPER_AUDIT_ACTIONS.SANDBOX_APPROVED, {
        user,
        application,
        message: application.customerMessage
    });

    return {
        applicationId: application.applicationId,
        developerAccountId: account.developerAccountId,
        status: application.status,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus,
        sandboxApprovedAt: account.sandboxApprovedAt.toISOString()
    };
};

const rejectOrRequestInformation = async (id, body, admin, context = {}) => {
    const payload = validateRejectPayload(body);
    const application = await findApplicationForAdmin(id, true);
    const account = application.developerAccountId;
    const user = application.userId;

    if (!account || !user) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.APPLICATION_NOT_FOUND, 'Application relationship is incomplete.');
    }

    assertApplicationTransition(application.status, payload.decision);

    const previousValue = {
        status: application.status,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus
    };

    application.status = payload.decision;
    application.decidedAt = new Date();
    application.decidedBy = admin._id;
    application.decisionReason = payload.reason;
    application.customerMessage = payload.customerMessage;
    application.internalReviewNotes = payload.internalNotes || null;
    application.missingInformation = payload.missingInformation;
    application.decisionHistory.push({
        status: payload.decision,
        decidedAt: new Date(),
        decidedBy: admin._id,
        reason: payload.reason,
        customerMessage: payload.customerMessage,
        internalReviewNotes: payload.internalNotes || null
    });

    account.accessLevel = ACCESS_LEVELS.NONE;
    account.accountStatus = payload.decision === APPLICATION_STATUSES.REJECTED
        ? DEVELOPER_ACCOUNT_STATUSES.REJECTED
        : DEVELOPER_ACCOUNT_STATUSES.MORE_INFORMATION_REQUIRED;

    await account.save();
    await application.save();

    const action = payload.decision === APPLICATION_STATUSES.REJECTED
        ? DEVELOPER_AUDIT_ACTIONS.APPLICATION_REJECTED
        : DEVELOPER_AUDIT_ACTIONS.MORE_INFORMATION_REQUIRED;

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action,
        targetId: application.applicationId,
        userId: user._id,
        developerAccountId: account._id,
        previousValue,
        newValue: {
            status: application.status,
            accessLevel: account.accessLevel,
            accountStatus: account.accountStatus,
            missingInformation: application.missingInformation
        },
        reason: payload.reason,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    await notifyDeveloperApplicationEvent(action, {
        user,
        application,
        message: payload.customerMessage
    });

    return {
        applicationId: application.applicationId,
        developerAccountId: account.developerAccountId,
        status: application.status,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus,
        customerMessage: application.customerMessage,
        decisionReason: application.decisionReason,
        missingInformation: application.missingInformation
    };
};

module.exports = {
    getCustomerApplicationState,
    submitOptIn,
    updateCustomerApplication,
    getCustomerStatus,
    listApplicationsForAdmin,
    getApplicationDetailForAdmin,
    assignReviewer,
    approveSandbox,
    rejectOrRequestInformation
};
