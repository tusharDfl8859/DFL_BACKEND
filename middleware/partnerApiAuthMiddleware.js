const ApiCredential = require('../models/ApiCredential');
const ApiRequestLog = require('../models/ApiRequestLog');
const DeveloperAccount = require('../models/DeveloperAccount');
const {
    ACCESS_LEVELS,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_ERROR_CODES
} = require('../constants/developerPortal');
const { makeRequestId } = require('../utils/developerPortalErrors');
const {
    constantTimeHashEquals,
    hashApiKey,
    parseApiKey
} = require('../utils/developerCredentialCrypto');

const safeUserAgent = (userAgent) => (
    typeof userAgent === 'string' ? userAgent.slice(0, 512) : null
);

const sendPartnerAuthError = (res, statusCode, errorCode, message, requestId) => res.status(statusCode).json({
    success: false,
    error_code: errorCode,
    code: errorCode,
    message,
    request_id: requestId
});

const genericInvalidKey = (res, requestId) => sendPartnerAuthError(
    res,
    401,
    DEVELOPER_ERROR_CODES.INVALID_API_KEY,
    'Partner API authentication failed.',
    requestId
);

const environmentAllowed = (account, environment) => {
    if (!account || account.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE) {
        return false;
    }
    if (environment === 'LIVE') {
        return account.accessLevel === ACCESS_LEVELS.LIVE;
    }
    return [ACCESS_LEVELS.SANDBOX, ACCESS_LEVELS.LIVE].includes(account.accessLevel);
};

const credentialUsable = (credential) => {
    if (!credential) {
        return false;
    }
    if (![CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY].includes(credential.status)) {
        return false;
    }
    if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
        return false;
    }
    return true;
};

const attachPartnerRequestLogger = (req, res) => {
    const startedAt = Date.now();
    res.on('finish', async () => {
        if (!req.partnerAuth || res.locals.skipPartnerAutoLog) {
            return;
        }

        try {
            await ApiRequestLog.create({
                requestId: req.partnerAuth.requestId,
                userId: req.partnerAuth.userId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                credentialPrefix: req.partnerAuth.credentialPrefix,
                environment: req.partnerAuth.environment,
                method: req.method,
                endpoint: req.originalUrl.split('?')[0],
                partnerRequestId: typeof (req.headers['x-partner-request-id'] || req.headers['idempotency-key']) === 'string'
                    ? (req.headers['x-partner-request-id'] || req.headers['idempotency-key']).slice(0, 120)
                    : null,
                statusCode: res.statusCode,
                latencyMs: Date.now() - startedAt,
                errorCode: res.locals.partnerApiErrorCode || null,
                ipAddress: req.ip,
                userAgent: safeUserAgent(req.get('user-agent')),
                requestMetadata: {
                    hasPartnerRequestId: Boolean(req.headers['x-partner-request-id']),
                    hasIdempotencyKey: Boolean(req.headers['idempotency-key'])
                },
                responseMetadata: {
                    controlledStep3Response: res.statusCode === 501
                }
            });
        } catch (error) {
            console.error('Partner API request log failed:', error && error.message ? error.message : error);
        }
    });
};

const authenticatePartnerApiKey = async (req, res, next) => {
    const requestId = req.headers['x-request-id'] || makeRequestId();
    const rawKey = req.get('x-api-key');

    if (!rawKey) {
        return sendPartnerAuthError(
            res,
            401,
            DEVELOPER_ERROR_CODES.API_KEY_REQUIRED,
            'Partner API key is required.',
            requestId
        );
    }

    const parsed = parseApiKey(rawKey);

    if (!parsed) {
        constantTimeHashEquals(null, null);
        return genericInvalidKey(res, requestId);
    }

    const incomingHash = hashApiKey(rawKey);
    const credential = await ApiCredential.findOne({ prefix: parsed.prefix }).select('+secretHash');
    const hashMatches = constantTimeHashEquals(incomingHash, credential?.secretHash);

    if (!credential || !hashMatches || credential.environment !== parsed.environment || !credentialUsable(credential)) {
        return genericInvalidKey(res, requestId);
    }

    const account = await DeveloperAccount.findById(credential.developerAccountId);
    if (!account) {
        return genericInvalidKey(res, requestId);
    }

    if (account.accountStatus === DEVELOPER_ACCOUNT_STATUSES.SUSPENDED) {
        return sendPartnerAuthError(
            res,
            403,
            DEVELOPER_ERROR_CODES.ACCOUNT_SUSPENDED,
            'Developer account is suspended.',
            requestId
        );
    }

    if (!environmentAllowed(account, credential.environment)) {
        return sendPartnerAuthError(
            res,
            403,
            DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED,
            'Credential environment is not allowed for this developer account.',
            requestId
        );
    }

    credential.lastUsedAt = new Date();
    credential.lastUsedIp = req.ip;
    credential.lastUserAgent = safeUserAgent(req.get('user-agent'));
    credential.requestCount = (credential.requestCount || 0) + 1;
    await credential.save();

    account.lastApiActivityAt = credential.lastUsedAt;
    await account.save();

    req.partnerAuth = {
        requestId,
        userId: credential.userId,
        developerAccountObjectId: account._id,
        developerAccountId: account.developerAccountId,
        credentialObjectId: credential._id,
        credentialId: credential.credentialId,
        credentialPrefix: credential.prefix,
        environment: credential.environment,
        tier: account.tier || null,
        accessLevel: account.accessLevel,
        accountStatus: account.accountStatus
    };

    attachPartnerRequestLogger(req, res);
    return next();
};

module.exports = {
    authenticatePartnerApiKey
};
