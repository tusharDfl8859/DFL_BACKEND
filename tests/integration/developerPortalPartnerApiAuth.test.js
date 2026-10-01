process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-3b-test-pepper';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const ApiCredential = require('../../models/ApiCredential');
const ApiRequestLog = require('../../models/ApiRequestLog');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_ENVIRONMENTS
} = require('../../constants/developerPortal');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Partner API User',
    email: overrides.email || `${nextUnique('partnerapi')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycData: {
        status: 'verified',
        panName: overrides.companyName || 'Partner API Customer Pvt Ltd'
    },
    ...overrides
});

const createSandboxApprovedAccount = async (user, overrides = {}) => {
    const account = await DeveloperAccount.create({
        userId: user._id,
        accessLevel: overrides.accessLevel || ACCESS_LEVELS.SANDBOX,
        accountStatus: overrides.accountStatus || DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        sandboxApprovedAt: new Date(),
        ...overrides.account
    });

    await DeveloperApplication.create({
        userId: user._id,
        developerAccountId: account._id,
        technicalContact: {
            name: 'Technical Owner',
            email: 'technical.owner@example.com',
            phone: '+919777777777'
        },
        integrationDetails: {
            useCase: 'Automated shipment booking through the Partner API.',
            expectedMonthlyShipmentVolume: '100 - 500',
            expectedMonthlyApiRequests: 5000,
            description: 'We will create DFL bookings and reconcile status updates.'
        },
        agreements: {
            termsAccepted: true,
            walletBillingAccepted: true,
            rateLimitAccepted: true,
            customsComplianceAccepted: true,
            agreementVersion: '1.0',
            acceptedAt: new Date()
        },
        status: APPLICATION_STATUSES.SANDBOX_APPROVED,
        submittedAt: new Date()
    });

    return account;
};

const authRequest = (user) => ({
    post: (path) => request(app).post(path).set('Authorization', `Bearer ${signToken(user._id)}`)
});

const generateSandboxKey = async (user) => {
    const response = await authRequest(user)
        .post('/api/developer/credentials')
        .send({
            name: 'Sandbox API Key',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            password: 'Password123!'
        })
        .expect(201);

    return response.body.data;
};

const partnerPost = (apiKey, headers = {}, path = '/api/v1/partner/bookings') => {
    const req = request(app).post(path);
    if (apiKey) {
        req.set('x-api-key', apiKey);
    }
    Object.entries(headers).forEach(([key, value]) => {
        req.set(key, value);
    });
    return req.send({ ignored: 'Step 3B does not execute booking payloads' });
};

describe('Partner API backend Step 3B API-key authentication', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init()
        ]);
    });

    test('missing, malformed, and unknown API keys fail with controlled generic authentication errors', async () => {
        const missing = await partnerPost().expect(401);
        expect(missing.body.error_code).toBe('API_KEY_REQUIRED');

        const malformed = await partnerPost('not-a-real-key').expect(401);
        expect(malformed.body.error_code).toBe('INVALID_API_KEY');

        const unknown = await partnerPost('dfl_test_pk_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').expect(401);
        expect(unknown.body.error_code).toBe('INVALID_API_KEY');
        expect(unknown.body.message).toBe('Partner API authentication failed.');
        expect(JSON.stringify(unknown.body)).not.toContain('aaaaaaaa');
    });

    test('valid Sandbox key authenticates and reaches only the controlled Step 3B 501 response', async () => {
        const user = await createUser();
        const account = await createSandboxApprovedAccount(user);
        const generated = await generateSandboxKey(user);

        const response = await partnerPost(generated.secret, {
            'idempotency-key': 'REQ-SANDBOX-1',
            'user-agent': 'Step3BTestAgent/1.0'
        }, '/api/v1/partner/unimplemented-boundary').expect(501);

        expect(response.body).toMatchObject({
            success: false,
            error_code: 'FEATURE_NOT_IMPLEMENTED',
            message: 'This Partner API operation is not implemented yet.'
        });

        const credential = await ApiCredential.findOne({ credentialId: generated.credential.credentialId });
        expect(credential.lastUsedAt).toBeTruthy();
        expect(credential.requestCount).toBe(1);
        expect(credential.lastUsedIp).toBeTruthy();
        expect(credential.lastUserAgent).toBeTruthy();

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.lastApiActivityAt).toBeTruthy();

        const logs = await ApiRequestLog.find({ credentialId: credential._id });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
            developerAccountId: account._id,
            credentialPrefix: generated.credential.prefix,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            method: 'POST',
            endpoint: '/api/v1/partner/unimplemented-boundary',
            statusCode: 501,
            errorCode: 'FEATURE_NOT_IMPLEMENTED',
            partnerRequestId: 'REQ-SANDBOX-1'
        });
        expect(JSON.stringify(logs[0].toJSON())).not.toContain(generated.secret);
        expect(JSON.stringify(logs[0].toJSON())).not.toContain('x-api-key');
    });

    test('revoked credential fails immediately and does not create Partner API request log', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const generated = await generateSandboxKey(user);

        await authRequest(user)
            .post(`/api/developer/credentials/${generated.credential.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(200);
        await authRequest(user)
            .post(`/api/developer/credentials/${generated.credential.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(409);

        await ApiCredential.updateOne(
            { credentialId: generated.credential.credentialId },
            { status: CREDENTIAL_STATUSES.REVOKED, revokedAt: new Date(), isPrimary: false }
        );

        const denied = await partnerPost(generated.secret).expect(401);
        expect(denied.body.error_code).toBe('INVALID_API_KEY');
        expect(await ApiRequestLog.countDocuments()).toBe(0);
    });

    test('expired secondary credential is rejected during authentication', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const generated = await generateSandboxKey(user);

        await authRequest(user)
            .post(`/api/developer/credentials/${generated.credential.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(200);

        await ApiCredential.updateOne(
            { credentialId: generated.credential.credentialId },
            { status: CREDENTIAL_STATUSES.SECONDARY, expiresAt: new Date(Date.now() - 1000), isPrimary: false }
        );

        const denied = await partnerPost(generated.secret).expect(401);
        expect(denied.body.error_code).toBe('INVALID_API_KEY');
    });

    test('suspended account and environment access mismatch are rejected with authorization errors', async () => {
        const suspendedUser = await createUser();
        const suspendedAccount = await createSandboxApprovedAccount(suspendedUser);
        const suspendedKey = await generateSandboxKey(suspendedUser);
        suspendedAccount.accountStatus = DEVELOPER_ACCOUNT_STATUSES.SUSPENDED;
        await suspendedAccount.save();

        const suspended = await partnerPost(suspendedKey.secret).expect(403);
        expect(suspended.body.error_code).toBe('ACCOUNT_SUSPENDED');

        const mismatchUser = await createUser();
        const mismatchAccount = await createSandboxApprovedAccount(mismatchUser);
        const mismatchKey = await generateSandboxKey(mismatchUser);
        mismatchAccount.accessLevel = ACCESS_LEVELS.NONE;
        await mismatchAccount.save();

        const mismatch = await partnerPost(mismatchKey.secret).expect(403);
        expect(mismatch.body.error_code).toBe('ENVIRONMENT_NOT_ALLOWED');
    });

    test('tampered secret for an existing prefix is rejected without leaking credential existence', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const generated = await generateSandboxKey(user);
        const tampered = generated.secret.replace(/[a-f0-9]{64}$/, 'c'.repeat(64));

        const denied = await partnerPost(tampered).expect(401);
        expect(denied.body.error_code).toBe('INVALID_API_KEY');
        expect(denied.body.message).toBe('Partner API authentication failed.');

        const credential = await ApiCredential.findOne({ credentialId: generated.credential.credentialId });
        expect(credential.requestCount).toBe(0);
        expect(credential.lastUsedAt).toBeNull();
    });
});
