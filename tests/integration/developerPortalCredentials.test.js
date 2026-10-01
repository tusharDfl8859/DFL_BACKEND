process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-3a-test-pepper';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const ApiCredential = require('../../models/ApiCredential');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS
} = require('../../constants/developerPortal');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Credential User',
    email: overrides.email || `${nextUnique('credential')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycData: {
        status: 'verified',
        panName: overrides.companyName || 'Credential Customer Pvt Ltd'
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

const credentialBody = (overrides = {}) => ({
    name: overrides.name || 'Sandbox Integration',
    environment: overrides.environment || DEVELOPER_ENVIRONMENTS.SANDBOX,
    password: overrides.password || 'Password123!'
});

const authRequest = (user) => ({
    get: (path) => request(app).get(path).set('Authorization', `Bearer ${signToken(user._id)}`),
    post: (path) => request(app).post(path).set('Authorization', `Bearer ${signToken(user._id)}`),
    delete: (path) => request(app).delete(path).set('Authorization', `Bearer ${signToken(user._id)}`)
});

describe('Partner API backend Step 3A customer credentials', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init()
        ]);
    });

    test('sandbox-approved customer generates and lists Sandbox credential with one-time raw secret only', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const generated = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);

        expect(generated.body.success).toBe(true);
        expect(generated.body.data.secret).toMatch(/^dfl_test_pk_[a-f0-9]{8}_[a-f0-9]{64}$/);
        expect(generated.body.data.credential).toMatchObject({
            name: 'Sandbox Integration',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            status: CREDENTIAL_STATUSES.ACTIVE,
            isPrimary: true
        });
        expect(generated.body.data.credential.secretHash).toBeUndefined();

        const credentialId = generated.body.data.credential.credentialId;
        const list = await authRequest(user)
            .get('/api/developer/credentials?environment=SANDBOX&status=ACTIVE&page=1&limit=10')
            .expect(200);

        expect(list.body.data).toHaveLength(1);
        expect(list.body.data[0]).toMatchObject({
            credentialId,
            prefix: generated.body.data.credential.prefix,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX
        });
        expect(list.body.data[0].secret).toBeUndefined();
        expect(list.body.data[0].secretHash).toBeUndefined();

        const stored = await ApiCredential.findOne({ credentialId }).select('+secretHash');
        expect(stored.secretHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(stored.toJSON())).not.toContain('secretHash');
        expect(JSON.stringify(stored.toJSON())).not.toContain(generated.body.data.secret);
    });

    test('credential generation requires customer auth, active Sandbox access, permitted environment, and password reauth', async () => {
        await request(app)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(401);

        const noAccessUser = await createUser();
        const denied = await authRequest(noAccessUser)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(403);
        expect(denied.body.error_code).toBe('ACCESS_NOT_ENABLED');

        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const liveDenied = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody({ environment: DEVELOPER_ENVIRONMENTS.LIVE }))
            .expect(403);
        expect(liveDenied.body.error_code).toBe('ENVIRONMENT_NOT_ALLOWED');

        const badPassword = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody({ password: 'WrongPassword123!' }))
            .expect(401);
        expect(badPassword.body.error_code).toBe('REAUTHENTICATION_FAILED');

        const audits = await DeveloperAuditLog.find({ action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_REAUTH_FAILED });
        expect(audits).toHaveLength(1);
        expect(JSON.stringify(audits[0])).not.toContain('WrongPassword123');
    });

    test('normal generation blocks duplicate primary credentials and invalid credential names', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const invalid = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody({ name: 'x' }))
            .expect(400);
        expect(invalid.body.error_code).toBe('INVALID_INPUT');

        await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);

        const duplicate = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody({ name: 'Another Sandbox Key' }))
            .expect(409);
        expect(duplicate.body.error_code).toBe('CREDENTIAL_LIMIT_REACHED');
    });

    test('rotation creates a new primary, makes previous key secondary, and returns new secret once', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const generated = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);

        const oldCredentialId = generated.body.data.credential.credentialId;
        const rotated = await authRequest(user)
            .post(`/api/developer/credentials/${oldCredentialId}/rotate`)
            .send({
                password: 'Password123!',
                name: 'Rotated Sandbox Credential'
            })
            .expect(200);

        expect(rotated.body.data.secret).toMatch(/^dfl_test_pk_[a-f0-9]{8}_[a-f0-9]{64}$/);
        expect(rotated.body.data.secret).not.toBe(generated.body.data.secret);
        expect(rotated.body.data.credential).toMatchObject({
            name: 'Rotated Sandbox Credential',
            status: CREDENTIAL_STATUSES.ACTIVE,
            isPrimary: true
        });
        expect(rotated.body.data.previousCredential).toMatchObject({
            credentialId: oldCredentialId,
            status: CREDENTIAL_STATUSES.SECONDARY,
            isPrimary: false
        });
        expect(rotated.body.data.previousCredential.expiresAt).toBeTruthy();

        const credentials = await ApiCredential.find({ userId: user._id }).sort({ createdAt: 1 });
        expect(credentials).toHaveLength(2);
        expect(credentials.filter((credential) => credential.isPrimary)).toHaveLength(1);
        expect(credentials.find((credential) => credential.credentialId === oldCredentialId).status).toBe(CREDENTIAL_STATUSES.SECONDARY);
    });

    test('rotation refuses secondary credentials and more than two usable keys', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const generated = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);
        const oldCredentialId = generated.body.data.credential.credentialId;

        await authRequest(user)
            .post(`/api/developer/credentials/${oldCredentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(200);

        const secondaryRotation = await authRequest(user)
            .post(`/api/developer/credentials/${oldCredentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(409);
        expect(secondaryRotation.body.error_code).toBe('CREDENTIAL_ROTATION_CONFLICT');

        const limitUser = await createUser();
        await createSandboxApprovedAccount(limitUser);
        const limitGenerated = await authRequest(limitUser)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);
        await authRequest(limitUser)
            .post(`/api/developer/credentials/${limitGenerated.body.data.credential.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(200);
        const active = await ApiCredential.findOne({ userId: limitUser._id, status: CREDENTIAL_STATUSES.ACTIVE });
        const limit = await authRequest(limitUser)
            .post(`/api/developer/credentials/${active.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(409);
        expect(limit.body.error_code).toBe('CREDENTIAL_LIMIT_REACHED');
    });

    test('customer revokes own credential and cannot revoke another customer credential', async () => {
        const owner = await createUser();
        await createSandboxApprovedAccount(owner);
        const otherUser = await createUser();
        await createSandboxApprovedAccount(otherUser);

        const generated = await authRequest(owner)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);
        const credentialId = generated.body.data.credential.credentialId;

        const crossTenant = await authRequest(otherUser)
            .delete(`/api/developer/credentials/${credentialId}`)
            .send({
                password: 'Password123!',
                reason: 'Attempting to revoke another customer credential.'
            })
            .expect(404);
        expect(crossTenant.body.error_code).toBe('CREDENTIAL_NOT_FOUND');

        const revoked = await authRequest(owner)
            .delete(`/api/developer/credentials/${credentialId}`)
            .send({
                password: 'Password123!',
                reason: 'Credential is no longer used.'
            })
            .expect(200);
        expect(revoked.body.data.credential).toMatchObject({
            credentialId,
            status: CREDENTIAL_STATUSES.REVOKED,
            isPrimary: false
        });
        expect(revoked.body.data.credential.secret).toBeUndefined();

        const duplicate = await authRequest(owner)
            .delete(`/api/developer/credentials/${credentialId}`)
            .send({
                password: 'Password123!',
                reason: 'Credential is no longer used.'
            })
            .expect(409);
        expect(duplicate.body.error_code).toBe('CREDENTIAL_ALREADY_REVOKED');
    });

    test('customer cannot revoke active primary while a secondary rotation credential remains usable', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const generated = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody())
            .expect(201);
        const rotated = await authRequest(user)
            .post(`/api/developer/credentials/${generated.body.data.credential.credentialId}/rotate`)
            .send({ password: 'Password123!' })
            .expect(200);

        const denied = await authRequest(user)
            .delete(`/api/developer/credentials/${rotated.body.data.credential.credentialId}`)
            .send({
                password: 'Password123!',
                reason: 'Primary suspected to be compromised.'
            })
            .expect(409);
        expect(denied.body.error_code).toBe('CREDENTIAL_ROTATION_CONFLICT');
    });

    test('credential action attempts are rate limited per customer', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        for (let index = 0; index < 3; index += 1) {
            await authRequest(user)
                .post('/api/developer/credentials')
                .send(credentialBody({ password: 'WrongPassword123!' }))
                .expect(401);
        }

        const limited = await authRequest(user)
            .post('/api/developer/credentials')
            .send(credentialBody({ password: 'WrongPassword123!' }))
            .expect(429);
        expect(limited.body.error_code).toBe('CREDENTIAL_ACTION_RATE_LIMITED');
    });
});
