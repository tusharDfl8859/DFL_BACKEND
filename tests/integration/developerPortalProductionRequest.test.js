process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-5a-test-pepper';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperProductionRequest = require('../../models/DeveloperProductionRequest');
const ApiCredential = require('../../models/ApiCredential');
const ApiRequestLog = require('../../models/ApiRequestLog');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const SandboxBooking = require('../../models/SandboxBooking');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
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

const authRequest = (user) => ({
    get: (path) => request(app).get(path).set('Authorization', `Bearer ${signToken(user._id)}`),
    post: (path) => request(app).post(path).set('Authorization', `Bearer ${signToken(user._id)}`),
    patch: (path) => request(app).patch(path).set('Authorization', `Bearer ${signToken(user._id)}`)
});

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Production User',
    email: overrides.email || `${nextUnique('production')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycVerified: overrides.kycVerified ?? true,
    kycData: {
        status: overrides.kycStatus || 'verified',
        panName: overrides.companyName || 'Production Customer Pvt Ltd'
    },
    isRestricted: overrides.isRestricted || false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ![
        'kycStatus',
        'companyName'
    ].includes(key)))
});

const createSandboxApprovedAccount = async (user, overrides = {}) => {
    const account = await DeveloperAccount.create({
        userId: user._id,
        accessLevel: overrides.accessLevel || ACCESS_LEVELS.SANDBOX,
        accountStatus: overrides.accountStatus || DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        sandboxApprovedAt: overrides.sandboxApprovedAt === undefined ? new Date() : overrides.sandboxApprovedAt
    });

    const application = await DeveloperApplication.create({
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
        status: overrides.applicationStatus || APPLICATION_STATUSES.SANDBOX_APPROVED,
        submittedAt: new Date()
    });

    return { account, application };
};

const productionRequestBody = (overrides = {}) => ({
    productionUseCase: {
        description: 'We will use the DFL Partner API for live e-commerce shipment booking.',
        expectedMonthlyShipmentVolume: '500 - 2000',
        expectedMonthlyApiRequests: 25000,
        plannedLaunchDate: '2026-09-01',
        integrationOwner: {
            name: 'Technical Owner',
            email: 'developer@example.com',
            phone: '+919876543210'
        },
        ...(overrides.productionUseCase || {})
    },
    operationalDetails: {
        supportContactEmail: 'support@example.com',
        incidentContactEmail: 'incident@example.com',
        businessHours: '09:00-18:00 IST',
        ...(overrides.operationalDetails || {})
    },
    agreements: {
        productionTermsAccepted: true,
        walletBillingAccepted: true,
        dataAccuracyAccepted: true,
        complianceResponsibilityAccepted: true,
        agreementVersion: '1.0',
        ...(overrides.agreements || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ![
        'productionUseCase',
        'operationalDetails',
        'agreements'
    ].includes(key)))
});

const sandboxPayload = (orderId) => ({
    recipient: {
        name: 'Sandbox Customer',
        phone: '9876543210',
        email: 'customer@example.com',
        addressLine1: 'Test Address',
        city: 'Mumbai',
        state: 'Maharashtra',
        postalCode: '400001',
        countryCode: 'IN'
    },
    package: {
        weightKg: 1.5,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        declaredValue: 1000,
        currency: 'INR',
        description: 'Sandbox test product'
    },
    order: {
        orderId,
        invoiceNumber: `${orderId}-INV`
    }
});

const generateSandboxKey = async (user) => {
    const response = await authRequest(user)
        .post('/api/developer/credentials')
        .send({
            name: 'Sandbox key',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            password: 'Password123!'
        })
        .expect(201);
    return response.body.data.secret;
};

const createPartnerBooking = (apiKey, requestId, scenario = 'success') => request(app)
    .post('/api/v1/partner/bookings')
    .set('Content-Type', 'application/json')
    .set('x-api-key', apiKey)
    .set('x-partner-request-id', requestId)
    .set('x-sandbox-scenario', scenario)
    .send(sandboxPayload(requestId));

const completeSandboxReadiness = async (user) => {
    const apiKey = await generateSandboxKey(user);
    const success = await createPartnerBooking(apiKey, nextUnique('success-')).expect(201);
    await createPartnerBooking(apiKey, nextUnique('validation-'), 'validation_error').expect(400);
    const cancellable = await createPartnerBooking(apiKey, nextUnique('cancel-')).expect(201);

    await request(app)
        .get(`/api/v1/partner/tracking/${success.body.data.trackingNumber}`)
        .set('x-api-key', apiKey)
        .expect(200);

    await request(app)
        .post(`/api/v1/partner/bookings/${cancellable.body.data.bookingId}/cancel`)
        .set('x-api-key', apiKey)
        .send({ reason: 'Sandbox cancellation readiness test' })
        .expect(200);

    return apiKey;
};

describe('Partner API backend Step 5A customer Production request', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            DeveloperProductionRequest.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init(),
            SandboxBooking.init(),
            Shipment.init(),
            Transaction.init()
        ]);
    });

    test('production readiness returns blockers for customers without complete Sandbox/KYC/profile state', async () => {
        await request(app)
            .get('/api/developer/production-readiness')
            .expect(401);

        const user = await createUser({ kycVerified: false, kycStatus: 'pending', walletBalance: 0 });

        const readiness = await authRequest(user)
            .get('/api/developer/production-readiness')
            .expect(200);

        expect(readiness.body.data.eligibleForProductionRequest).toBe(false);
        expect(readiness.body.data.productionRequestStatus).toBe('NOT_REQUESTED');
        expect(readiness.body.data.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
            'DEVELOPER_ACCOUNT_REQUIRED',
            'SANDBOX_ACCESS_REQUIRED',
            'PRODUCTION_READINESS_INCOMPLETE',
            'KYC_APPROVAL_REQUIRED'
        ]));

        const denied = await authRequest(user)
            .post('/api/developer/production-request')
            .send(productionRequestBody())
            .expect(403);
        expect(denied.body.error_code).toBe('PRODUCTION_NOT_ELIGIBLE');
        expect(denied.body.details.blockers.length).toBeGreaterThan(0);
    });

    test('eligible customer submits Production request without enabling Live or creating production side effects', async () => {
        const user = await createUser();
        const { account, application } = await createSandboxApprovedAccount(user);
        await completeSandboxReadiness(user);

        const readiness = await authRequest(user)
            .get('/api/developer/production-readiness')
            .expect(200);
        expect(readiness.body.data).toMatchObject({
            accessLevel: ACCESS_LEVELS.SANDBOX,
            accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
            eligibleForProductionRequest: true,
            productionRequestStatus: 'NOT_REQUESTED'
        });
        expect(readiness.body.data.sandbox.readinessScore).toBe(100);
        expect(readiness.body.data.credentials.activeSandboxCredentials).toBe(1);

        const response = await authRequest(user)
            .post('/api/developer/production-request')
            .send(productionRequestBody())
            .expect(201);

        expect(response.body.data).toMatchObject({
            developerAccountId: account.developerAccountId,
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            accessLevel: ACCESS_LEVELS.SANDBOX
        });
        expect(response.body.data.productionRequestId).toMatch(/^DPROD_[A-F0-9]{16}$/);

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(updatedAccount.liveApprovedAt).toBeNull();

        const updatedApplication = await DeveloperApplication.findById(application._id);
        expect(updatedApplication.status).toBe(APPLICATION_STATUSES.PRODUCTION_REQUESTED);

        const productionRequest = await DeveloperProductionRequest.findOne({ userId: user._id });
        expect(productionRequest).toMatchObject({
            developerAccountId: account._id,
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED
        });
        expect(productionRequest.sandboxReadinessSnapshot.readinessScore).toBe(100);
        expect(productionRequest.agreements.acceptedAt).toBeInstanceOf(Date);

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_REQUESTED,
            targetId: productionRequest.productionRequestId
        });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit.toJSON())).not.toContain('Authorization');

        expect(await ApiCredential.countDocuments({ environment: DEVELOPER_ENVIRONMENTS.LIVE })).toBe(0);
        expect(await Shipment.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
    });

    test('duplicate active Production requests are blocked, including concurrent submissions', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        await completeSandboxReadiness(user);

        const [first, second] = await Promise.all([
            authRequest(user).post('/api/developer/production-request').send(productionRequestBody()),
            authRequest(user).post('/api/developer/production-request').send(productionRequestBody({
                productionUseCase: { description: 'Second concurrent Production request attempt.' }
            }))
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([201, 409]);
        expect(await DeveloperProductionRequest.countDocuments({ userId: user._id })).toBe(1);

        const duplicate = await authRequest(user)
            .post('/api/developer/production-request')
            .send(productionRequestBody())
            .expect(409);
        expect(duplicate.body.error_code).toBe('PRODUCTION_REQUEST_ALREADY_EXISTS');
    });

    test('customer cannot submit forbidden ownership or decision fields', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        await completeSandboxReadiness(user);

        const response = await authRequest(user)
            .post('/api/developer/production-request')
            .send(productionRequestBody({
                status: APPLICATION_STATUSES.LIVE_APPROVED,
                accessLevel: ACCESS_LEVELS.LIVE,
                developerAccountId: 'DACC_FORGED',
                approvedBy: 'ADMIN_FORGED'
            }))
            .expect(400);

        expect(response.body.error_code).toBe('INVALID_INPUT');
        expect(response.body.details.fields).toEqual(expect.arrayContaining([
            'status',
            'accessLevel',
            'developerAccountId',
            'approvedBy'
        ]));
    });

    test('customer retrieves only their own Production request and empty state is safe', async () => {
        const owner = await createUser();
        await createSandboxApprovedAccount(owner);
        await completeSandboxReadiness(owner);
        const created = await authRequest(owner)
            .post('/api/developer/production-request')
            .send(productionRequestBody())
            .expect(201);

        const other = await createUser();
        await createSandboxApprovedAccount(other);

        const own = await authRequest(owner)
            .get('/api/developer/production-request')
            .expect(200);
        expect(own.body.data.productionRequestId).toBe(created.body.data.productionRequestId);
        expect(JSON.stringify(own.body.data)).not.toContain('internalReviewNotes');

        const empty = await authRequest(other)
            .get('/api/developer/production-request')
            .expect(200);
        expect(empty.body.data).toMatchObject({
            productionRequest: null,
            status: 'NOT_REQUESTED',
            canResubmit: false
        });
        expect(JSON.stringify(empty.body.data)).not.toContain(created.body.data.productionRequestId);
    });

    test('more-information resubmission updates only customer-editable fields', async () => {
        const user = await createUser();
        const { account } = await createSandboxApprovedAccount(user);
        await completeSandboxReadiness(user);
        const created = await authRequest(user)
            .post('/api/developer/production-request')
            .send(productionRequestBody())
            .expect(201);

        const productionRequest = await DeveloperProductionRequest.findOne({
            productionRequestId: created.body.data.productionRequestId
        }).select('+internalReviewNotes +decisionHistory.internalReviewNotes');
        productionRequest.status = APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED;
        productionRequest.customerMessage = 'Please add incident contact details.';
        productionRequest.missingInformation = ['operationalDetails.incidentContactEmail'];
        productionRequest.allowResubmission = true;
        productionRequest.internalReviewNotes = 'Private admin note';
        await productionRequest.save();

        const resubmitted = await authRequest(user)
            .patch('/api/developer/production-request')
            .send(productionRequestBody({
                operationalDetails: {
                    incidentContactEmail: 'new-incident@example.com'
                },
                status: APPLICATION_STATUSES.LIVE_APPROVED
            }))
            .expect(400);
        expect(resubmitted.body.error_code).toBe('INVALID_INPUT');

        const valid = await authRequest(user)
            .patch('/api/developer/production-request')
            .send(productionRequestBody({
                operationalDetails: {
                    incidentContactEmail: 'new-incident@example.com'
                }
            }))
            .expect(200);

        expect(valid.body.data).toMatchObject({
            productionRequestId: created.body.data.productionRequestId,
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            canResubmit: false
        });
        expect(valid.body.data.operationalDetails.incidentContactEmail).toBe('new-incident@example.com');
        expect(JSON.stringify(valid.body.data)).not.toContain('Private admin note');

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REQUEST_UPDATED,
            targetId: created.body.data.productionRequestId
        });
        expect(audit).not.toBeNull();
    });
});
