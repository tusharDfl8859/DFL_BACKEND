process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-3c-test-pepper';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const DeveloperAccount = require('../../models/DeveloperAccount');
const ApiCredential = require('../../models/ApiCredential');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const {
    ACCESS_LEVELS,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_PERMISSIONS
} = require('../../constants/developerPortal');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');
const { expireSecondaryCredentials } = require('../../services/openapi/developerPortalCredentialService');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Admin Credential Customer',
    email: overrides.email || `${nextUnique('admin-credential')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycData: {
        status: 'verified',
        panName: overrides.companyName || 'Admin Credential Company Pvt Ltd'
    },
    ...overrides
});

const createAdmin = async (permissions = [], overrides = {}) => Admin.create({
    name: overrides.name || 'Credential Admin',
    email: overrides.email || `${nextUnique('admin')}@example.com`,
    password: overrides.password || 'Password123!',
    contactNumber: overrides.contactNumber || '+919888888888',
    designation: overrides.designation || 'Ops',
    department: overrides.department || 'Operations',
    role: overrides.role || 'member',
    permissions,
    ...overrides
});

const createDeveloperAccount = async (user, overrides = {}) => DeveloperAccount.create({
    userId: user._id,
    accessLevel: overrides.accessLevel || ACCESS_LEVELS.SANDBOX,
    accountStatus: overrides.accountStatus || DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
    sandboxApprovedAt: new Date(),
    ...overrides
});

const createCredential = async (user, account, overrides = {}) => {
    const generated = generateApiKey(overrides.environment || DEVELOPER_ENVIRONMENTS.SANDBOX);
    return ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment: overrides.environment || DEVELOPER_ENVIRONMENTS.SANDBOX,
        name: overrides.name || 'Admin Listed Credential',
        prefix: overrides.prefix || generated.prefix,
        secretHash: overrides.secretHash || generated.secretHash,
        status: overrides.status || CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: overrides.isPrimary ?? true,
        expiresAt: overrides.expiresAt || null,
        createdBy: user._id,
        createdByModel: 'User'
    });
};

describe('Partner API backend Step 3C admin credential management', () => {
    beforeAll(async () => {
        await Promise.all([
            User.init(),
            Admin.init(),
            DeveloperAccount.init(),
            ApiCredential.init(),
            DeveloperAuditLog.init()
        ]);
    });

    test('admin credential list requires admin auth and credential read permission', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);
        await createCredential(user, account);

        await request(app)
            .get('/api/admin/developer-hub/credentials')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(401);

        const noPermissionAdmin = await createAdmin([DEVELOPER_PERMISSIONS.OVERVIEW_READ]);
        const forbidden = await request(app)
            .get('/api/admin/developer-hub/credentials')
            .set('Authorization', `Bearer ${signToken(noPermissionAdmin._id)}`)
            .expect(403);
        expect(forbidden.body.code).toBe('PERMISSION_DENIED');
    });

    test('admin credential list returns searchable metadata without raw secrets or secret hashes', async () => {
        const user = await createUser({
            name: 'Credential Search Customer',
            companyName: 'Credential Search Company Pvt Ltd'
        });
        const account = await createDeveloperAccount(user);
        const credential = await createCredential(user, account, { name: 'Warehouse Sync Key' });

        const admin = await createAdmin([DEVELOPER_PERMISSIONS.CREDENTIALS_READ]);
        const response = await request(app)
            .get('/api/admin/developer-hub/credentials')
            .query({
                query: 'Credential Search',
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
                status: CREDENTIAL_STATUSES.ACTIVE,
                page: 1,
                limit: 5,
                sortBy: 'createdAt',
                sortOrder: 'desc'
            })
            .set('Authorization', `Bearer ${signToken(admin._id)}`)
            .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.pagination.total).toBe(1);
        expect(response.body.data[0]).toMatchObject({
            credentialId: credential.credentialId,
            developerAccountId: account.developerAccountId,
            customerId: user.customerId,
            companyName: 'Credential Search Company Pvt Ltd',
            customerEmail: user.email,
            name: 'Warehouse Sync Key',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            prefix: credential.prefix,
            status: CREDENTIAL_STATUSES.ACTIVE,
            isPrimary: true
        });
        expect(JSON.stringify(response.body)).not.toContain('secretHash');
        expect(JSON.stringify(response.body)).not.toContain('secret');
    });

    test('admin revocation requires revoke permission, reason, and writes an audit event', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);
        const credential = await createCredential(user, account);

        const readOnlyAdmin = await createAdmin([DEVELOPER_PERMISSIONS.CREDENTIALS_READ]);
        await request(app)
            .delete(`/api/admin/developer-hub/credentials/${credential.credentialId}`)
            .set('Authorization', `Bearer ${signToken(readOnlyAdmin._id)}`)
            .send({ reason: 'Compromised credential reported by customer.' })
            .expect(403);

        const revokeAdmin = await createAdmin([DEVELOPER_PERMISSIONS.CREDENTIALS_REVOKE]);
        const missingReason = await request(app)
            .delete(`/api/admin/developer-hub/credentials/${credential.credentialId}`)
            .set('Authorization', `Bearer ${signToken(revokeAdmin._id)}`)
            .send({})
            .expect(400);
        expect(missingReason.body.error_code).toBe('INVALID_INPUT');

        const revoked = await request(app)
            .delete(`/api/admin/developer-hub/credentials/${credential.credentialId}`)
            .set('Authorization', `Bearer ${signToken(revokeAdmin._id)}`)
            .send({ reason: 'Compromised credential reported by customer.' })
            .expect(200);

        expect(revoked.body.data.credential).toMatchObject({
            credentialId: credential.credentialId,
            status: CREDENTIAL_STATUSES.REVOKED,
            isPrimary: false
        });
        expect(JSON.stringify(revoked.body)).not.toContain('secretHash');

        const stored = await ApiCredential.findOne({ credentialId: credential.credentialId });
        expect(stored.status).toBe(CREDENTIAL_STATUSES.REVOKED);
        expect(stored.revokedBy.toString()).toBe(revokeAdmin._id.toString());

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_ADMIN_REVOKED,
            targetId: credential.credentialId
        });
        expect(audit).not.toBeNull();
        expect(audit.actorId.toString()).toBe(revokeAdmin._id.toString());
        expect(audit.reason).toBe('Compromised credential reported by customer.');
    });

    test('secondary credential expiry sweep is idempotent and audits expired keys', async () => {
        const user = await createUser();
        const account = await createDeveloperAccount(user);
        const expiredSecondary = await createCredential(user, account, {
            name: 'Expired Secondary',
            status: CREDENTIAL_STATUSES.SECONDARY,
            isPrimary: false,
            expiresAt: new Date(Date.now() - 60 * 1000)
        });
        await createCredential(user, account, {
            name: 'Current Primary',
            isPrimary: true,
            prefix: generateApiKey(DEVELOPER_ENVIRONMENTS.SANDBOX).prefix
        });

        const firstRun = await expireSecondaryCredentials();
        expect(firstRun).toMatchObject({
            expiredCount: 1,
            credentialIds: [expiredSecondary.credentialId]
        });

        const secondRun = await expireSecondaryCredentials();
        expect(secondRun.expiredCount).toBe(0);

        const stored = await ApiCredential.findOne({ credentialId: expiredSecondary.credentialId });
        expect(stored.status).toBe(CREDENTIAL_STATUSES.EXPIRED);
        expect(stored.isPrimary).toBe(false);

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.CREDENTIAL_EXPIRED,
            targetId: expiredSecondary.credentialId
        });
        expect(audit).not.toBeNull();
    });
});
