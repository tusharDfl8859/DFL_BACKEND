process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';

const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');

const { app } = require('../../../server');
const User = require('../../../models/User');
const Admin = require('../../../models/Admin');
const DeveloperAccount = require('../../../models/DeveloperAccount');
const DeveloperApplication = require('../../../models/DeveloperApplication');
const ApiCredential = require('../../../models/ApiCredential');
const ApiRequestLog = require('../../../models/ApiRequestLog');
const DeveloperAuditLog = require('../../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../../models/DeveloperConfig');
const SandboxBooking = require('../../../models/SandboxBooking');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_PERMISSIONS
} = require('../../../constants/developerPortal');
const { sanitizeLogMetadata, REDACTED_VALUE } = require('../../../utils/developerPortalLogSanitizer');
const {
    buildTenantScopedQuery,
    belongsToDeveloperTenant
} = require('../../../services/openapi/developerPortalOwnershipService');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Developer User',
    email: overrides.email || `${nextUnique('dev')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    ...overrides
});

const createAdmin = async (overrides = {}) => Admin.create({
    name: overrides.name || 'Admin User',
    email: overrides.email || `${nextUnique('admin')}@example.com`,
    password: overrides.password || 'Password123!',
    contactNumber: overrides.contactNumber || '+919888888888',
    designation: overrides.designation || 'Ops',
    department: overrides.department || 'Operations',
    role: overrides.role || 'member',
    permissions: overrides.permissions || [],
    ...overrides
});

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createDeveloperAccount = async (user, overrides = {}) => DeveloperAccount.create({
    userId: user._id,
    ...overrides
});

const validApplicationPayload = (user, account, overrides = {}) => ({
    userId: user._id,
    developerAccountId: account._id,
    technicalContact: {
        name: 'Technical Owner',
        email: 'technical.owner@example.com',
        phone: '+919777777777'
    },
    integrationDetails: {
        useCase: 'Automated cross-border shipment booking from our ERP.',
        expectedMonthlyShipmentVolume: '100 - 500',
        expectedMonthlyApiRequests: 1500,
        description: 'The API will be used for booking, status checks, labels, and operational reconciliation.'
    },
    agreements: {
        termsAccepted: true,
        walletBillingAccepted: true,
        rateLimitAccepted: true,
        customsComplianceAccepted: true
    },
    ...overrides
});

describe('Partner API backend Step 1 foundation', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init(),
            SandboxBooking.init()
        ]);
    });

    test('developer constants expose required status and permission values', () => {
        expect(ACCESS_LEVELS.NONE).toBe('NONE');
        expect(APPLICATION_STATUSES.PRODUCTION_REQUESTED).toBe('PRODUCTION_REQUESTED');
        expect(DEVELOPER_ACCOUNT_STATUSES.SUSPENDED).toBe('SUSPENDED');
        expect(DEVELOPER_PERMISSIONS.CREDENTIALS_REVOKE).toBe('developer.credentials.revoke');
        expect(Object.isFrozen(DEVELOPER_PERMISSIONS)).toBe(true);
    });

    test('customer and admin route boundaries are protected before returning 501', async () => {
        await request(app).get('/api/developer/application').expect(401);
        await request(app).get('/api/admin/developer-hub/overview').expect(401);

        const customer = await createUser();
        const customerToken = signToken(customer._id);
        const customerAdminAttempt = await request(app)
            .get('/api/admin/developer-hub/overview')
            .set('Authorization', `Bearer ${customerToken}`)
            .expect(401);
        expect(customerAdminAttempt.body.message).toMatch(/Not authorized/);

        const adminWithoutPermission = await createAdmin({ role: 'member', permissions: [] });
        const deniedAdminToken = signToken(adminWithoutPermission._id);
        const deniedAdmin = await request(app)
            .get('/api/admin/developer-hub/overview')
            .set('Authorization', `Bearer ${deniedAdminToken}`)
            .expect(403);
        expect(deniedAdmin.body.code).toBe('PERMISSION_DENIED');

        const permittedAdmin = await createAdmin({
            role: 'member',
            permissions: [DEVELOPER_PERMISSIONS.OVERVIEW_READ]
        });
        const permittedAdminToken = signToken(permittedAdmin._id);
        const adminBoundary = await request(app)
            .get('/api/admin/developer-hub/overview')
            .set('Authorization', `Bearer ${permittedAdminToken}`)
            .expect(501);
        expect(adminBoundary.body.code).toBe('FEATURE_NOT_IMPLEMENTED');
        expect(adminBoundary.body.stack).toBeUndefined();

        const adminCustomerAttempt = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${permittedAdminToken}`)
            .expect(403);
        expect(adminCustomerAttempt.body.code).toBe('PERMISSION_DENIED');

        const customerWithAdminFlag = await createUser({ isAdmin: true });
        const flaggedCustomerToken = signToken(customerWithAdminFlag._id);
        const flaggedCustomerApplication = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${flaggedCustomerToken}`)
            .expect(200);
        expect(flaggedCustomerApplication.body.data.application).toBeNull();
        expect(flaggedCustomerApplication.body.data.canSubmitApplication).toBe(true);

        const customerApplication = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${customerToken}`)
            .expect(200);
        expect(customerApplication.body.data.application).toBeNull();
        expect(customerApplication.body.data.canSubmitApplication).toBe(true);

        const customerBoundary = await request(app)
            .get('/api/developer/unknown-step-one-boundary')
            .set('Authorization', `Bearer ${customerToken}`)
            .expect(501);
        expect(customerBoundary.body.code).toBe('FEATURE_NOT_IMPLEMENTED');
        expect(customerBoundary.body.stack).toBeUndefined();
    });

    test('partner API route group requires real API key authentication before the controlled boundary', async () => {
        const noKey = await request(app).post('/api/v1/partner/bookings').send({}).expect(401);
        expect(noKey.body.code).toBe('API_KEY_REQUIRED');

        const invalidKey = await request(app)
            .post('/api/v1/partner/bookings')
            .set('x-api-key', 'dfl_test_publicprefix.raw-secret-placeholder')
            .send({})
            .expect(401);
        expect(invalidKey.body.code).toBe('INVALID_API_KEY');
        expect(invalidKey.body.stack).toBeUndefined();
    });

    test('DeveloperAccount defaults and unique customer ownership are enforced', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        expect(account.developerAccountId).toMatch(/^DACC_[A-F0-9]{16}$/);
        expect(account.accessLevel).toBe(ACCESS_LEVELS.NONE);
        expect(account.accountStatus).toBe(DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW);

        await expect(createDeveloperAccount(user)).rejects.toThrow(/duplicate key/);
    });

    test('tenant-scoped queries require both userId and developerAccountId', async () => {
        const owner = await createUser();
        const otherUser = await createUser();
        const account = await createDeveloperAccount(owner);

        const ownerScopedQuery = buildTenantScopedQuery({
            userId: owner._id,
            developerAccountId: account.developerAccountId,
            extra: { _id: account._id }
        });
        const ownerRecord = await DeveloperAccount.findOne(ownerScopedQuery);
        expect(ownerRecord).not.toBeNull();
        expect(belongsToDeveloperTenant(ownerRecord, { userId: owner._id, developerAccountId: account.developerAccountId })).toBe(true);

        const crossTenantQuery = buildTenantScopedQuery({
            userId: otherUser._id,
            developerAccountId: account.developerAccountId,
            extra: { _id: account._id }
        });
        const crossTenantRecord = await DeveloperAccount.findOne(crossTenantQuery);
        expect(crossTenantRecord).toBeNull();
    });

    test('DeveloperApplication validates agreements and prevents duplicate active applications', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        await expect(DeveloperApplication.create(validApplicationPayload(user, account, {
            agreements: {
                termsAccepted: false,
                walletBillingAccepted: true,
                rateLimitAccepted: true,
                customsComplianceAccepted: true
            }
        }))).rejects.toThrow(/Terms must be accepted/);

        await DeveloperApplication.create(validApplicationPayload(user, account));
        await expect(DeveloperApplication.create(validApplicationPayload(user, account, {
            technicalContact: {
                name: 'Second Owner',
                email: 'second.owner@example.com',
                phone: '+919666666666'
            }
        }))).rejects.toThrow(/duplicate key/);
    });

    test('ApiCredential validates environment, prefix uniqueness, and hides secretHash', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        const credential = await ApiCredential.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            name: 'Sandbox Primary',
            prefix: nextUnique('dfl_test_'),
            secretHash: 'a'.repeat(64)
        });

        const queried = await ApiCredential.findById(credential._id);
        expect(queried.secretHash).toBeUndefined();
        expect(queried.toJSON().secretHash).toBeUndefined();
        expect(queried.toObject().secretHash).toBeUndefined();

        const withSecret = await ApiCredential.findById(credential._id).select('+secretHash');
        expect(withSecret.secretHash).toBe('a'.repeat(64));
        expect(withSecret.toJSON().secretHash).toBeUndefined();

        await expect(ApiCredential.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: 'INVALID',
            name: 'Invalid Environment',
            prefix: nextUnique('dfl_bad_'),
            secretHash: 'b'.repeat(64)
        })).rejects.toThrow(/not a valid enum value/);

        await expect(ApiCredential.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            name: 'Duplicate Prefix',
            prefix: credential.prefix,
            secretHash: 'c'.repeat(64)
        })).rejects.toThrow(/duplicate key/);
    });

    test('ApiRequestLog requires explicit environment and rejects sensitive metadata', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        await expect(ApiRequestLog.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            method: 'POST',
            endpoint: '/api/v1/partner/bookings',
            statusCode: 400,
            latencyMs: 12,
            requestMetadata: { headers: { authorization: 'Bearer secret' } }
        })).rejects.toThrow(/Metadata contains sensitive keys/);

        const log = await ApiRequestLog.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            method: 'GET',
            endpoint: '/api/v1/partner/track/DFL123',
            partnerRequestId: 'partner-req-1',
            credentialPrefix: 'dfl_live_abcd',
            statusCode: 200,
            latencyMs: 8,
            requestMetadata: { query: { trackingId: 'DFL123' } }
        });
        expect(log.requestId).toMatch(/^DREQ_[A-F0-9]{16}$/);
        expect(log.environment).toBe(DEVELOPER_ENVIRONMENTS.LIVE);
    });

    test('log sanitizer masks sensitive keys recursively', () => {
        const sanitized = sanitizeLogMetadata({
            authorization: 'Bearer secret',
            nested: {
                apiKey: 'raw-key',
                safe: 'visible',
                array: [{ refreshToken: 'refresh-secret' }]
            }
        });

        expect(sanitized.authorization).toBe(REDACTED_VALUE);
        expect(sanitized.nested.apiKey).toBe(REDACTED_VALUE);
        expect(sanitized.nested.safe).toBe('visible');
        expect(sanitized.nested.array[0].refreshToken).toBe(REDACTED_VALUE);
    });

    test('DeveloperAuditLog is append-only and rejects sensitive values', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        const audit = await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.ADMIN,
            action: 'sandbox.approve',
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.DEVELOPER_ACCOUNT,
            targetId: account.developerAccountId,
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            newValue: { accessLevel: ACCESS_LEVELS.SANDBOX }
        });
        expect(audit.auditId).toMatch(/^DAUD_[A-F0-9]{16}$/);

        await expect(DeveloperAuditLog.updateOne({ _id: audit._id }, { $set: { action: 'changed' } }))
            .rejects.toThrow(/append-only/);
        await expect(DeveloperAuditLog.deleteOne({ _id: audit._id }))
            .rejects.toThrow(/append-only/);
        await expect(DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.ADMIN,
            action: 'credential.view',
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.API_CREDENTIAL,
            userId: user._id,
            developerAccountId: account._id,
            newValue: { secretHash: 'do-not-store' }
        })).rejects.toThrow(/Metadata contains sensitive keys/);
    });

    test('SandboxBooking enforces sandbox-only isolation and idempotency scope', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);

        const booking = await SandboxBooking.create({
            userId: user._id,
            developerAccountId: account._id,
            partnerRequestId: 'partner-request-1',
            requestMetadata: { shipmentType: 'sandbox' }
        });
        expect(booking.environment).toBe(DEVELOPER_ENVIRONMENTS.SANDBOX);
        expect(booking.walletDeducted).toBe(false);
        expect(booking.carrierInvoked).toBe(false);

        await expect(SandboxBooking.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId: 'partner-request-2'
        })).rejects.toThrow(/SandboxBooking records must remain/);

        await expect(SandboxBooking.create({
            userId: user._id,
            developerAccountId: account._id,
            partnerRequestId: 'partner-request-1'
        })).rejects.toThrow(/duplicate key/);
    });

    test('DeveloperConfig validates positive security and throttling values', async () => {
        const config = await DeveloperConfig.getSingleton();
        expect(config.sandboxRetentionDays).toBe(30);
        expect(config.sandboxMinimumSuccessfulBookings).toBe(10);
        expect(config.credentialRotationHours).toBe(24);

        await expect(DeveloperConfig.create({
            configKey: 'INVALID_CONFIG',
            sandboxRetentionDays: 0,
            silverRateLimit: 0,
            silverBurstLimit: 0,
            goldRateLimit: 0,
            goldBurstLimit: 0,
            platinumRateLimit: 0,
            platinumBurstLimit: 0,
            credentialRotationHours: 0
        })).rejects.toThrow();
    });

    test('foundation indexes include public IDs and isolation constraints', () => {
        const credentialIndexes = ApiCredential.schema.indexes();
        const applicationIndexes = DeveloperApplication.schema.indexes();
        const sandboxIndexes = SandboxBooking.schema.indexes();

        expect(credentialIndexes).toEqual(expect.arrayContaining([
            expect.arrayContaining([{ credentialId: 1 }, expect.objectContaining({ unique: true })]),
            expect.arrayContaining([{ prefix: 1 }, expect.objectContaining({ unique: true })])
        ]));
        expect(applicationIndexes.some(([fields, options]) => (
            fields.userId === 1 &&
            fields.status === 1 &&
            options.unique === true &&
            options.name === 'unique_active_developer_application_per_user'
        ))).toBe(true);
        expect(sandboxIndexes.some(([fields, options]) => (
            fields.developerAccountId === 1 &&
            fields.environment === 1 &&
            fields.partnerRequestId === 1 &&
            options.unique === true
        ))).toBe(true);

        expect(new mongoose.Types.ObjectId().toString()).toHaveLength(24);
    });
});
