process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-5b-test-pepper';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperProductionRequest = require('../../models/DeveloperProductionRequest');
const ApiCredential = require('../../models/ApiCredential');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_PERMISSIONS
} = require('../../constants/developerPortal');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Production Admin Customer',
    email: overrides.email || `${nextUnique('prod-admin-customer')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycVerified: overrides.kycVerified ?? true,
    companyName: overrides.companyName || undefined,
    kycData: {
        status: overrides.kycStatus || 'verified',
        panName: overrides.companyName || 'Production Review Company Pvt Ltd',
        kycVerifiedAt: new Date()
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ![
        'kycStatus',
        'companyName'
    ].includes(key)))
});

const createAdmin = async (permissions = [], overrides = {}) => Admin.create({
    name: overrides.name || 'Production Admin',
    email: overrides.email || `${nextUnique('admin')}@example.com`,
    password: overrides.password || 'Password123!',
    contactNumber: overrides.contactNumber || '+919888888888',
    designation: overrides.designation || 'Ops',
    department: overrides.department || 'Operations',
    role: overrides.role || 'member',
    permissions,
    ...overrides
});

const createProductionFixture = async (overrides = {}) => {
    const user = await createUser(overrides.user || {});
    const account = await DeveloperAccount.create({
        userId: user._id,
        accessLevel: ACCESS_LEVELS.SANDBOX,
        accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        sandboxApprovedAt: new Date()
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
        status: overrides.status || APPLICATION_STATUSES.PRODUCTION_REQUESTED,
        submittedAt: new Date()
    });
    const productionRequest = await DeveloperProductionRequest.create({
        userId: user._id,
        developerAccountId: account._id,
        sandboxApplicationId: application._id,
        productionUseCase: {
            description: overrides.description || 'We will use the DFL Partner API for live e-commerce shipment booking.',
            expectedMonthlyShipmentVolume: '500 - 2000',
            expectedMonthlyApiRequests: 25000,
            plannedLaunchDate: new Date('2026-09-01T00:00:00.000Z'),
            integrationOwner: {
                name: 'Production Owner',
                email: overrides.integrationOwnerEmail || 'owner@example.com',
                phone: '+919876543210'
            }
        },
        operationalDetails: {
            supportContactEmail: 'support@example.com',
            incidentContactEmail: 'incident@example.com',
            businessHours: '09:00-18:00 IST'
        },
        agreements: {
            productionTermsAccepted: true,
            walletBillingAccepted: true,
            dataAccuracyAccepted: true,
            complianceResponsibilityAccepted: true,
            agreementVersion: '1.0',
            acceptedAt: new Date()
        },
        status: overrides.status || APPLICATION_STATUSES.PRODUCTION_REQUESTED,
        sandboxReadinessSnapshot: {
            readinessScore: overrides.readinessScore ?? 100,
            requiredTestsComplete: overrides.requiredTestsComplete ?? true,
            successfulBookings: 3,
            validationTests: 1,
            trackingTests: 1,
            cancellationTests: 1,
            apiRequests: 6,
            capturedAt: new Date()
        },
        submittedAt: new Date(),
        customerMessage: 'Your Production access request has been submitted.',
        internalReviewNotes: overrides.internalReviewNotes || null,
        missingInformation: overrides.missingInformation || [],
        allowResubmission: overrides.allowResubmission || false,
        decisionHistory: [{
            status: overrides.status || APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            decidedAt: new Date(),
            reason: 'Customer submitted Production access request.',
            customerMessage: 'Your Production access request has been submitted.'
        }]
    });

    const generated = generateApiKey(DEVELOPER_ENVIRONMENTS.SANDBOX);
    await ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        name: 'Sandbox Admin Fixture Key',
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        status: CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: true,
        createdBy: user._id,
        createdByModel: 'User'
    });

    return { user, account, application, productionRequest };
};

const adminGet = (admin, path) => request(app).get(path).set('Authorization', `Bearer ${signToken(admin._id)}`);
const adminPatch = (admin, path) => request(app).patch(path).set('Authorization', `Bearer ${signToken(admin._id)}`);
const adminPost = (admin, path) => request(app).post(path).set('Authorization', `Bearer ${signToken(admin._id)}`);

describe('Partner API backend Step 5B admin Production review workflow', () => {
    beforeAll(async () => {
        await Promise.all([
            User.init(),
            Admin.init(),
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            DeveloperProductionRequest.init(),
            ApiCredential.init(),
            DeveloperAuditLog.init(),
            Shipment.init(),
            Transaction.init()
        ]);
    });

    test('production request list requires admin auth and production read permission', async () => {
        const { user } = await createProductionFixture();

        await request(app)
            .get('/api/admin/developer-hub/production-requests')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(401);

        const noPermissionAdmin = await createAdmin([DEVELOPER_PERMISSIONS.OVERVIEW_READ]);
        const forbidden = await adminGet(noPermissionAdmin, '/api/admin/developer-hub/production-requests')
            .expect(403);
        expect(forbidden.body.error_code).toBe('PERMISSION_DENIED');
    });

    test('production request list supports search, filters, pagination, and safe row shape', async () => {
        const searchable = await createProductionFixture({
            user: {
                name: 'Searchable Production Customer',
                companyName: 'Searchable Production Pvt Ltd'
            },
            integrationOwnerEmail: 'search-owner@example.com'
        });
        await createProductionFixture({
            user: {
                name: 'Other Production Customer',
                companyName: 'Other Production Pvt Ltd'
            },
            status: APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW
        });

        const admin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_READ]);
        const response = await adminGet(
            admin,
            '/api/admin/developer-hub/production-requests?query=Searchable&status=PRODUCTION_REQUESTED&kycStatus=verified&readinessStatus=ready&page=1&limit=5'
        ).expect(200);

        expect(response.body.pagination.total).toBe(1);
        expect(response.body.data[0]).toMatchObject({
            productionRequestId: searchable.productionRequest.productionRequestId,
            developerAccountId: searchable.account.developerAccountId,
            status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            sandboxReadinessScore: 100,
            kycStatus: 'verified',
            requestedProductionVolume: '500 - 2000'
        });
        expect(JSON.stringify(response.body)).not.toContain('secretHash');
        expect(JSON.stringify(response.body)).not.toContain('internalReviewNotes');
    });

    test('production request detail requires read permission and returns authorized review package', async () => {
        const { productionRequest } = await createProductionFixture({
            internalReviewNotes: 'Private review note'
        });
        const readAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_READ]);

        const response = await adminGet(
            readAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}`
        ).expect(200);

        expect(response.body.data.productionRequest).toMatchObject({
            productionRequestId: productionRequest.productionRequestId,
            internalReviewNotes: 'Private review note'
        });
        expect(response.body.data.customer.email).toBeTruthy();
        expect(response.body.data.credentialHealth.activeSandboxCredentials).toBe(1);
        expect(JSON.stringify(response.body)).not.toContain('secretHash');
    });

    test('reviewer assignment requires review permission, validates reviewer permission, starts review, and audits', async () => {
        const { productionRequest, account, application } = await createProductionFixture();
        const readOnlyAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_READ]);
        const reviewAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_REVIEW]);
        const reviewerWithoutPermission = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_READ]);

        await adminPatch(
            readOnlyAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/reviewer`
        ).send({ reviewerId: reviewAdmin._id.toString() }).expect(403);

        const invalidReviewer = await adminPatch(
            reviewAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/reviewer`
        ).send({ reviewerId: reviewerWithoutPermission._id.toString() }).expect(403);
        expect(invalidReviewer.body.error_code).toBe('PERMISSION_DENIED');

        const assigned = await adminPatch(
            reviewAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/reviewer`
        ).send({ reviewerId: reviewAdmin._id.toString() }).expect(200);

        expect(assigned.body.data.productionRequest).toMatchObject({
            productionRequestId: productionRequest.productionRequestId,
            status: APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW
        });
        expect(assigned.body.data.productionRequest.assignedReviewer.id).toBe(reviewAdmin._id.toString());

        const updatedRequest = await DeveloperProductionRequest.findById(productionRequest._id);
        expect(updatedRequest.status).toBe(APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW);
        expect(updatedRequest.assignedReviewer.toString()).toBe(reviewAdmin._id.toString());

        const updatedApplication = await DeveloperApplication.findById(application._id);
        expect(updatedApplication.status).toBe(APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW);

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(updatedAccount.liveApprovedAt).toBeNull();

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REVIEW_STARTED,
            targetId: productionRequest.productionRequestId
        });
        expect(audit).not.toBeNull();
        expect(audit.actorId.toString()).toBe(reviewAdmin._id.toString());
    });

    test('request more information keeps Sandbox access, hides internal notes from customer, and audits', async () => {
        const { productionRequest, user, account } = await createProductionFixture({
            status: APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW
        });
        const reviewAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_REVIEW]);

        const missingPayload = await adminPost(
            reviewAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/request-more-info`
        ).send({
            reason: 'Additional operational information is required.',
            customerMessage: 'Please provide your incident escalation process.',
            missingInformation: ['operationalDetails.incidentContactEmail'],
            internalNotes: 'Private operational concern'
        }).expect(200);

        expect(missingPayload.body.data).toMatchObject({
            productionRequestId: productionRequest.productionRequestId,
            status: APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
            accessLevel: ACCESS_LEVELS.SANDBOX,
            missingInformation: ['operationalDetails.incidentContactEmail']
        });

        const customerView = await request(app)
            .get('/api/developer/production-request')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(200);
        expect(customerView.body.data.status).toBe(APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED);
        expect(JSON.stringify(customerView.body.data)).not.toContain('Private operational concern');

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_MORE_INFORMATION_REQUIRED,
            targetId: productionRequest.productionRequestId
        });
        expect(audit).not.toBeNull();
    });

    test('reject Production request requires reject permission, preserves Sandbox state, and creates no production side effects', async () => {
        const { productionRequest, account } = await createProductionFixture({
            status: APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW
        });
        const readAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_READ]);
        const rejectAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_REJECT]);

        await adminPost(
            readAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/reject`
        ).send({
            reason: 'Production readiness requirements were not satisfied.',
            customerMessage: 'Your Production request cannot be approved at this time.',
            internalNotes: 'Private compliance concern',
            allowResubmission: true
        }).expect(403);

        const rejected = await adminPost(
            rejectAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/reject`
        ).send({
            reason: 'Production readiness requirements were not satisfied.',
            customerMessage: 'Your Production request cannot be approved at this time.',
            internalNotes: 'Private compliance concern',
            allowResubmission: true
        }).expect(200);

        expect(rejected.body.data).toMatchObject({
            productionRequestId: productionRequest.productionRequestId,
            status: APPLICATION_STATUSES.REJECTED,
            accessLevel: ACCESS_LEVELS.SANDBOX,
            allowResubmission: true
        });

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(updatedAccount.liveApprovedAt).toBeNull();

        expect(await Shipment.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await ApiCredential.countDocuments({ environment: DEVELOPER_ENVIRONMENTS.LIVE })).toBe(0);

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_REQUEST_REJECTED,
            targetId: productionRequest.productionRequestId
        });
        expect(audit).not.toBeNull();
        expect(audit.actorId.toString()).toBe(rejectAdmin._id.toString());
    });
});
