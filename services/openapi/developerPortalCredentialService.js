const ApiCredential = require('../../models/ApiCredential');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperConfig = require('../../models/DeveloperConfig');
const User = require('../../models/User');
const mongoose = require('mongoose');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    CREDENTIAL_STATUS_VALUES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ENVIRONMENT_VALUES,
    DEVELOPER_ERROR_CODES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');
const {
    createAdminAudit,
    createCustomerAudit,
    createDeveloperAudit
} = require('./developerPortalAuditService');
const {
    assertCredentialActionAllowed,
    assertReauthenticationAllowed,
    clearFailedReauthentication,
    recordCredentialActionAttempt,
    recordFailedReauthentication
} = require('./developerPortalCredentialRateLimitService');

const USABLE_CREDENTIAL_STATUSES = [CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY];
const ADMIN_SORT_FIELDS = new Set(['createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt', 'status', 'environment', 'name']);

const requireTrimmedString = (value, field, min, max) => {
    if (typeof value !== 'string') {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${field} is required.`);
    }
    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${field} must be between ${min} and ${max} characters.`);
    }
    if (trimmed.startsWith('$')) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, `${field} is invalid.`);
    }
    return trimmed;
};

const assertAllowedKeys = (body, allowedKeys) => {
    const unknown = Object.keys(body || {}).filter((key) => !allowedKeys.includes(key));
    if (unknown.length > 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Request body contains unsupported fields.', { fields: unknown });
    }
};

const serializeCredential = (credential) => ({
    credentialId: credential.credentialId,
    name: credential.name,
    environment: credential.environment,
    prefix: credential.prefix,
    status: credential.status,
    isPrimary: credential.isPrimary,
    createdAt: credential.createdAt?.toISOString() || null,
    lastUsedAt: credential.lastUsedAt?.toISOString() || null,
    expiresAt: credential.expiresAt?.toISOString() || null,
    revokedAt: credential.revokedAt?.toISOString() || null
});

const parseListQuery = (query = {}) => {
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
    const environment = query.environment && query.environment !== 'all' ? String(query.environment).toUpperCase() : null;
    const status = query.status && query.status !== 'all' ? String(query.status).toUpperCase() : null;

    if (environment && !DEVELOPER_ENVIRONMENT_VALUES.includes(environment)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'environment is invalid.');
    }
    if (status && !CREDENTIAL_STATUS_VALUES.includes(status)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'status is invalid.');
    }

    return { page, limit, environment, status };
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getCompanyName = (user) => (
    user?.kycData?.panName
    || user?.kycData?.billingAddress?.companyName
    || user?.name
    || 'Unknown customer'
);

const parseAdminListQuery = (query = {}) => {
    const base = parseListQuery(query);
    const sortBy = ADMIN_SORT_FIELDS.has(query.sortBy) ? query.sortBy : 'createdAt';
    const sortOrder = String(query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const developerAccountId = typeof query.developerAccountId === 'string' && query.developerAccountId.trim()
        ? query.developerAccountId.trim()
        : null;
    const search = typeof query.query === 'string' && query.query.trim()
        ? query.query.trim()
        : null;

    return {
        ...base,
        developerAccountId,
        query: search,
        sortBy,
        sortOrder
    };
};

const findDeveloperAccountForUser = async (user) => DeveloperAccount.findOne({ userId: user._id });

const assertSandboxApprovedApplication = async (user, account) => {
    const application = await DeveloperApplication.findOne({
        userId: user._id,
        developerAccountId: account._id,
        status: { $in: [APPLICATION_STATUSES.SANDBOX_APPROVED, APPLICATION_STATUSES.SANDBOX_TESTING, APPLICATION_STATUSES.LIVE_APPROVED] }
    }).sort({ createdAt: -1 });

    if (!application && !account.sandboxApprovedAt) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ACCESS_NOT_ENABLED, 'Sandbox access is not enabled for this developer account.');
    }
};

const getActiveDeveloperAccount = async (user, requestedEnvironment) => {
    const account = await findDeveloperAccountForUser(user);
    if (!account) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ACCESS_NOT_ENABLED, 'Developer account access is not enabled.');
    }
    if (account.accountStatus === DEVELOPER_ACCOUNT_STATUSES.SUSPENDED) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ACCOUNT_SUSPENDED, 'Developer account is suspended.');
    }
    if (account.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ACCESS_NOT_ENABLED, 'Developer account is not active.');
    }
    if (account.accessLevel === ACCESS_LEVELS.NONE) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ACCESS_NOT_ENABLED, 'API access is not enabled.');
    }
    if (requestedEnvironment === DEVELOPER_ENVIRONMENTS.LIVE && account.accessLevel !== ACCESS_LEVELS.LIVE) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED, 'Live credentials require Live access.');
    }
    if (requestedEnvironment === DEVELOPER_ENVIRONMENTS.SANDBOX && ![ACCESS_LEVELS.SANDBOX, ACCESS_LEVELS.LIVE].includes(account.accessLevel)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED, 'Sandbox credentials require Sandbox access.');
    }

    await assertSandboxApprovedApplication(user, account);
    return account;
};

const reauthenticateUser = async (user, password, context = {}) => {
    if (typeof password !== 'string' || password.length === 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.REAUTHENTICATION_REQUIRED, 'Reauthentication is required.');
    }

    const allowed = await assertReauthenticationAllowed(user._id.toString());
    if (!allowed) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_ACTION_RATE_LIMITED, 'Too many failed credential authentication attempts. Try again later.');
    }

    const fullUser = await User.findById(user._id).select('+password');
    const matched = fullUser && await fullUser.matchPassword(password);
    if (!matched) {
        await recordFailedReauthentication(user._id.toString());
        await createCustomerAudit({
            actorId: user._id,
            action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_REAUTH_FAILED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
            userId: user._id,
            reason: 'Customer credential action reauthentication failed.',
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent
        });
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.REAUTHENTICATION_FAILED, 'Reauthentication failed.');
    }

    await clearFailedReauthentication(user._id.toString());
};

const enforceCredentialActionLimit = async (user) => {
    const allowed = await assertCredentialActionAllowed(user._id.toString());
    if (!allowed) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_ACTION_RATE_LIMITED, 'Too many credential actions. Try again later.');
    }
    await recordCredentialActionAttempt(user._id.toString());
};

const countUsableCredentials = (account, environment) => ApiCredential.countDocuments({
    developerAccountId: account._id,
    environment,
    status: { $in: USABLE_CREDENTIAL_STATUSES }
});

const getPrimaryCredential = (account, environment) => ApiCredential.findOne({
    developerAccountId: account._id,
    environment,
    status: CREDENTIAL_STATUSES.ACTIVE,
    isPrimary: true
});

const listCustomerCredentials = async (user, queryParams = {}) => {
    const account = await findDeveloperAccountForUser(user);
    const params = parseListQuery(queryParams);
    if (!account) {
        return {
            data: [],
            pagination: {
                page: params.page,
                limit: params.limit,
                total: 0,
                totalPages: 1
            }
        };
    }

    const query = {
        userId: user._id,
        developerAccountId: account._id
    };
    if (params.environment) query.environment = params.environment;
    if (params.status) query.status = params.status;

    const skip = (params.page - 1) * params.limit;
    const [total, credentials] = await Promise.all([
        ApiCredential.countDocuments(query),
        ApiCredential.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(params.limit)
    ]);

    return {
        data: credentials.map(serializeCredential),
        pagination: {
            page: params.page,
            limit: params.limit,
            total,
            totalPages: Math.ceil(total / params.limit) || 1
        }
    };
};

const validateCredentialCreateBody = (body = {}) => {
    assertAllowedKeys(body, ['name', 'environment', 'password']);
    const environment = typeof body.environment === 'string' ? body.environment.toUpperCase() : null;
    if (!DEVELOPER_ENVIRONMENT_VALUES.includes(environment)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'environment is required.');
    }
    return {
        name: requireTrimmedString(body.name, 'name', 2, 120),
        environment,
        password: body.password
    };
};

const createCustomerCredential = async (user, body, context = {}) => {
    const payload = validateCredentialCreateBody(body);
    await enforceCredentialActionLimit(user);
    const account = await getActiveDeveloperAccount(user, payload.environment);
    await reauthenticateUser(user, payload.password, context);

    const primaryCredential = await getPrimaryCredential(account, payload.environment);
    if (primaryCredential) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_LIMIT_REACHED, 'A primary credential already exists. Rotate the existing credential instead.');
    }

    const usableCount = await countUsableCredentials(account, payload.environment);
    if (usableCount >= 2) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_LIMIT_REACHED, 'Credential limit reached for this environment.');
    }

    const generated = generateApiKey(payload.environment);
    const credential = await ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment: payload.environment,
        name: payload.name,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        status: CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: true,
        createdBy: user._id,
        createdByModel: 'User'
    });

    await createCustomerAudit({
        actorId: user._id,
        action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_GENERATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
        targetId: credential.credentialId,
        userId: user._id,
        developerAccountId: account._id,
        environment: payload.environment,
        newValue: {
            credentialId: credential.credentialId,
            environment: credential.environment,
            status: credential.status,
            isPrimary: credential.isPrimary,
            prefix: credential.prefix
        },
        reason: 'Customer generated API credential.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return {
        credential: serializeCredential(credential),
        secret: generated.fullApiKey
    };
};

const findOwnedCredential = async (user, credentialId, account = null) => {
    const developerAccount = account || await findDeveloperAccountForUser(user);
    if (!developerAccount) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_NOT_FOUND, 'Credential was not found.');
    }

    const credential = await ApiCredential.findOne({
        credentialId,
        userId: user._id,
        developerAccountId: developerAccount._id
    });
    if (!credential) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_NOT_FOUND, 'Credential was not found.');
    }
    return { credential, account: developerAccount };
};

const rotateCustomerCredential = async (user, credentialId, body = {}, context = {}) => {
    assertAllowedKeys(body, ['password', 'name']);
    await enforceCredentialActionLimit(user);
    const { credential, account } = await findOwnedCredential(user, credentialId);
    await getActiveDeveloperAccount(user, credential.environment);
    await reauthenticateUser(user, body.password, context);

    if (credential.status !== CREDENTIAL_STATUSES.ACTIVE || !credential.isPrimary) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_ROTATION_CONFLICT, 'Only the active primary credential can be rotated.');
    }

    const usableCount = await countUsableCredentials(account, credential.environment);
    if (usableCount >= 2) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_LIMIT_REACHED, 'Credential limit reached for this environment.');
    }

    const config = await DeveloperConfig.getSingleton();
    const expiresAt = new Date(Date.now() + config.credentialRotationHours * 60 * 60 * 1000);
    const generated = generateApiKey(credential.environment);
    const newName = body.name === undefined
        ? `${credential.name} rotated`
        : requireTrimmedString(body.name, 'name', 2, 120);

    credential.status = CREDENTIAL_STATUSES.SECONDARY;
    credential.isPrimary = false;
    credential.expiresAt = expiresAt;
    await credential.save();

    const newCredential = await ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment: credential.environment,
        name: newName,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        status: CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: true,
        createdBy: user._id,
        createdByModel: 'User'
    });

    await createCustomerAudit({
        actorId: user._id,
        action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_ROTATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
        targetId: newCredential.credentialId,
        userId: user._id,
        developerAccountId: account._id,
        environment: credential.environment,
        previousValue: {
            credentialId: credential.credentialId,
            status: CREDENTIAL_STATUSES.SECONDARY,
            expiresAt: expiresAt.toISOString()
        },
        newValue: {
            credentialId: newCredential.credentialId,
            status: newCredential.status,
            isPrimary: newCredential.isPrimary,
            prefix: newCredential.prefix
        },
        reason: 'Customer rotated API credential.',
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return {
        credential: serializeCredential(newCredential),
        previousCredential: serializeCredential(credential),
        secret: generated.fullApiKey
    };
};

const revokeCustomerCredential = async (user, credentialId, body = {}, context = {}) => {
    assertAllowedKeys(body, ['password', 'reason']);
    const reason = requireTrimmedString(body.reason, 'reason', 5, 1000);
    await enforceCredentialActionLimit(user);
    const { credential, account } = await findOwnedCredential(user, credentialId);
    await reauthenticateUser(user, body.password, context);

    if (credential.status === CREDENTIAL_STATUSES.REVOKED) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_ALREADY_REVOKED, 'Credential is already revoked.');
    }

    const hasSecondary = credential.isPrimary && await ApiCredential.exists({
        developerAccountId: account._id,
        environment: credential.environment,
        status: CREDENTIAL_STATUSES.SECONDARY
    });
    if (hasSecondary) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.CREDENTIAL_ROTATION_CONFLICT,
            'Revoke the secondary credential or wait for it to expire before revoking the primary credential.'
        );
    }

    const previousValue = {
        status: credential.status,
        isPrimary: credential.isPrimary
    };

    credential.status = CREDENTIAL_STATUSES.REVOKED;
    credential.isPrimary = false;
    credential.revokedAt = new Date();
    credential.revokedBy = user._id;
    credential.revocationReason = reason;
    credential.expiresAt = credential.expiresAt || credential.revokedAt;
    await credential.save();

    await createCustomerAudit({
        actorId: user._id,
        action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_REVOKED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
        targetId: credential.credentialId,
        userId: user._id,
        developerAccountId: account._id,
        environment: credential.environment,
        previousValue,
        newValue: {
            status: credential.status,
            isPrimary: credential.isPrimary,
            revokedAt: credential.revokedAt.toISOString()
        },
        reason,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return serializeCredential(credential);
};

const serializeAdminCredential = (credential) => {
    const user = credential.userId;
    const account = credential.developerAccountId;

    return {
        credentialId: credential.credentialId,
        developerAccountId: account?.developerAccountId || null,
        developerAccountObjectId: account?._id?.toString() || null,
        customerId: user?.customerId || null,
        customerName: user?.name || null,
        companyName: getCompanyName(user),
        customerEmail: user?.email || null,
        name: credential.name,
        environment: credential.environment,
        prefix: credential.prefix,
        status: credential.status,
        isPrimary: credential.isPrimary,
        createdAt: credential.createdAt?.toISOString() || null,
        lastUsedAt: credential.lastUsedAt?.toISOString() || null,
        expiresAt: credential.expiresAt?.toISOString() || null,
        revokedAt: credential.revokedAt?.toISOString() || null,
        requestCount: credential.requestCount || 0
    };
};

const buildAdminCredentialQuery = async (params) => {
    const query = {};
    if (params.environment) query.environment = params.environment;
    if (params.status) query.status = params.status;

    if (params.developerAccountId) {
        const accountSelector = mongoose.Types.ObjectId.isValid(params.developerAccountId)
            ? { $or: [{ _id: params.developerAccountId }, { developerAccountId: params.developerAccountId }] }
            : { developerAccountId: params.developerAccountId };
        const account = await DeveloperAccount.findOne(accountSelector).select('_id');
        if (!account) return null;
        query.developerAccountId = account._id;
    }

    if (params.query) {
        const regex = new RegExp(escapeRegex(params.query), 'i');
        const [users, accounts] = await Promise.all([
            User.find({
                $or: [
                    { name: regex },
                    { email: regex },
                    { customerId: regex },
                    { 'kycData.panName': regex }
                ]
            }).select('_id'),
            DeveloperAccount.find({ developerAccountId: regex }).select('_id')
        ]);

        query.$or = [
            { credentialId: regex },
            { name: regex },
            { prefix: regex }
        ];

        if (users.length > 0) {
            query.$or.push({ userId: { $in: users.map((user) => user._id) } });
        }
        if (accounts.length > 0) {
            query.$or.push({ developerAccountId: { $in: accounts.map((account) => account._id) } });
        }
    }

    return query;
};

const listCredentialsForAdmin = async (queryParams = {}) => {
    const params = parseAdminListQuery(queryParams);
    const query = await buildAdminCredentialQuery(params);

    if (query === null) {
        return {
            data: [],
            pagination: {
                page: params.page,
                limit: params.limit,
                total: 0,
                totalPages: 1
            }
        };
    }

    const skip = (params.page - 1) * params.limit;
    const sort = { [params.sortBy]: params.sortOrder, _id: params.sortOrder };
    const [total, credentials] = await Promise.all([
        ApiCredential.countDocuments(query),
        ApiCredential.find(query)
            .populate('userId', 'name email customerId accountType kycData.panName kycData.status')
            .populate('developerAccountId', 'developerAccountId accessLevel accountStatus lastApiActivityAt')
            .sort(sort)
            .skip(skip)
            .limit(params.limit)
    ]);

    return {
        data: credentials.map(serializeAdminCredential),
        pagination: {
            page: params.page,
            limit: params.limit,
            total,
            totalPages: Math.ceil(total / params.limit) || 1
        }
    };
};

const revokeCredentialForAdmin = async (credentialId, body = {}, admin, context = {}) => {
    assertAllowedKeys(body, ['reason']);
    const reason = requireTrimmedString(body.reason, 'reason', 5, 1000);

    const credential = await ApiCredential.findOne({ credentialId })
        .populate('userId', 'name email customerId accountType kycData.panName kycData.status')
        .populate('developerAccountId', 'developerAccountId accessLevel accountStatus lastApiActivityAt');

    if (!credential) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_NOT_FOUND, 'Credential was not found.');
    }
    if (credential.status === CREDENTIAL_STATUSES.REVOKED) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CREDENTIAL_ALREADY_REVOKED, 'Credential is already revoked.');
    }

    const previousValue = {
        status: credential.status,
        isPrimary: credential.isPrimary,
        expiresAt: credential.expiresAt?.toISOString() || null
    };

    credential.status = CREDENTIAL_STATUSES.REVOKED;
    credential.isPrimary = false;
    credential.revokedAt = new Date();
    credential.revokedBy = admin._id;
    credential.revocationReason = reason;
    credential.expiresAt = credential.expiresAt || credential.revokedAt;
    await credential.save();
    await credential.populate('userId', 'name email customerId accountType kycData.panName kycData.status');
    await credential.populate('developerAccountId', 'developerAccountId accessLevel accountStatus lastApiActivityAt');

    await createAdminAudit({
        actorId: admin._id,
        actorRole: admin.role,
        action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_ADMIN_REVOKED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
        targetId: credential.credentialId,
        userId: credential.userId?._id || credential.userId,
        developerAccountId: credential.developerAccountId?._id || credential.developerAccountId,
        environment: credential.environment,
        previousValue,
        newValue: {
            status: credential.status,
            isPrimary: credential.isPrimary,
            revokedAt: credential.revokedAt.toISOString()
        },
        reason,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
    });

    return serializeAdminCredential(credential);
};

const expireSecondaryCredentials = async ({ now = new Date(), limit = 250 } = {}) => {
    const candidates = await ApiCredential.find({
        status: CREDENTIAL_STATUSES.SECONDARY,
        expiresAt: { $lte: now }
    }).limit(Math.min(Math.max(Number.parseInt(limit, 10) || 250, 1), 1000));

    const expired = [];
    for (const candidate of candidates) {
        const updated = await ApiCredential.findOneAndUpdate(
            {
                _id: candidate._id,
                status: CREDENTIAL_STATUSES.SECONDARY,
                expiresAt: { $lte: now }
            },
            {
                $set: {
                    status: CREDENTIAL_STATUSES.EXPIRED,
                    isPrimary: false
                }
            },
            { returnDocument: 'after' }
        );

        if (updated) {
            expired.push(updated.credentialId);
            await createDeveloperAudit({
                actorType: DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM,
                action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_EXPIRED,
                targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
                targetId: updated.credentialId,
                userId: updated.userId,
                developerAccountId: updated.developerAccountId,
                environment: updated.environment,
                previousValue: {
                    status: CREDENTIAL_STATUSES.SECONDARY,
                    expiresAt: updated.expiresAt?.toISOString() || null
                },
                newValue: {
                    status: CREDENTIAL_STATUSES.EXPIRED,
                    isPrimary: false
                },
                reason: 'Secondary credential rotation window expired.'
            });
        }
    }

    return {
        expiredCount: expired.length,
        credentialIds: expired
    };
};

module.exports = {
    createCustomerCredential,
    expireSecondaryCredentials,
    listCredentialsForAdmin,
    listCustomerCredentials,
    revokeCredentialForAdmin,
    revokeCustomerCredential,
    rotateCustomerCredential,
    serializeAdminCredential,
    serializeCredential
};
