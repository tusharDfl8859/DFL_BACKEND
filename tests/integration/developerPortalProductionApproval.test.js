process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-5c-test-pepper';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';
process.env.SPEEDBOX_API_URL = '';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperProductionRequest = require('../../models/DeveloperProductionRequest');
const ApiCredential = require('../../models/ApiCredential');
const ApiRequestLog = require('../../models/ApiRequestLog');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const SandboxBooking = require('../../models/SandboxBooking');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const RateZone = require('../../models/RateZone');
const RateTable = require('../../models/RateTable');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_PERMISSIONS,
    SLA_TIERS
} = require('../../constants/developerPortal');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');
const rateCalculator = require('../../utils/rateCalculator');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Production Approval Customer',
    email: overrides.email || `${nextUnique('prod-approval-customer')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycVerified: overrides.kycVerified ?? true,
    companyName: overrides.companyName || undefined,
    kycData: {
        status: overrides.kycStatus || 'verified',
        panName: overrides.companyName || 'Production Approval Company Pvt Ltd',
        kycVerifiedAt: new Date()
    },
    isRestricted: overrides.isRestricted || false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ![
        'kycStatus',
        'companyName'
    ].includes(key)))
});

const createAdmin = async (permissions = [], overrides = {}) => Admin.create({
    name: overrides.name || 'Production Approval Admin',
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
        accessLevel: overrides.accessLevel || ACCESS_LEVELS.SANDBOX,
        accountStatus: overrides.accountStatus || DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        sandboxApprovedAt: overrides.sandboxApprovedAt === undefined ? new Date() : overrides.sandboxApprovedAt,
        tier: overrides.tier || null
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
            termsAccepted: overrides.termsAccepted ?? true,
            walletBillingAccepted: overrides.walletBillingAccepted ?? true,
            rateLimitAccepted: overrides.rateLimitAccepted ?? true,
            customsComplianceAccepted: overrides.customsComplianceAccepted ?? true,
            agreementVersion: '1.0',
            acceptedAt: new Date()
        },
        status: overrides.applicationStatus || overrides.status || APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
        submittedAt: new Date(),
        reviewStartedAt: new Date()
    });
    const productionRequest = await DeveloperProductionRequest.create({
        userId: user._id,
        developerAccountId: account._id,
        sandboxApplicationId: application._id,
        productionUseCase: {
            description: 'We will use the DFL Partner API for live e-commerce shipment booking.',
            expectedMonthlyShipmentVolume: '500 - 2000',
            expectedMonthlyApiRequests: 25000,
            plannedLaunchDate: new Date('2026-09-01T00:00:00.000Z'),
            integrationOwner: {
                name: 'Production Owner',
                email: 'owner@example.com',
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
        status: overrides.status || APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
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
        reviewStartedAt: new Date(),
        customerMessage: 'Your Production access request is being reviewed.',
        missingInformation: overrides.missingInformation || [],
        allowResubmission: overrides.allowResubmission || false,
        decisionHistory: [{
            status: overrides.status || APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
            decidedAt: new Date(),
            reason: 'Production review started.',
            customerMessage: 'Your Production access request is being reviewed.'
        }]
    });

    const generated = generateApiKey(DEVELOPER_ENVIRONMENTS.SANDBOX);
    await ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        name: 'Sandbox Approval Fixture Key',
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        status: CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: true,
        createdBy: user._id,
        createdByModel: 'User'
    });

    return { user, account, application, productionRequest };
};

const adminPost = (admin, path) => request(app).post(path).set('Authorization', `Bearer ${signToken(admin._id)}`);
const customerPost = (user, path) => request(app).post(path).set('Authorization', `Bearer ${signToken(user._id)}`);

const approvalBody = (overrides = {}) => ({
    reason: 'Final review completed and Live API access is approved.',
    customerMessage: 'Your Production access has been approved. You can now generate a Live API credential.',
    internalNotes: 'Security and readiness checks completed before approval.',
    tier: SLA_TIERS.GOLD,
    ...overrides
});

const credentialBody = (overrides = {}) => ({
    name: overrides.name || 'Live Integration',
    environment: overrides.environment || DEVELOPER_ENVIRONMENTS.LIVE,
    password: overrides.password || 'Password123!'
});

const resetRateCalculator = () => {
    rateCalculator.zones = null;
    rateCalculator.rates = null;
    rateCalculator.serviceMap = null;
    rateCalculator.lastLoaded = null;
    rateCalculator.cache = new Map();
};

const seedAuthoritativeRates = async () => {
    resetRateCalculator();
    await Promise.all([
        RateZone.create({ country: 'US', state: 'NY', zone: 'TUS1' }),
        RateTable.create({
            weight: 2,
            rates: {
                TUS1: 500,
                UUSPS: 575
            }
        })
    ]);
};

const partnerBookingPayload = () => ({
    recipient: {
        name: 'Live Customer',
        phone: '9876543210',
        email: 'customer@example.com',
        addressLine1: 'Production Address',
        city: 'New York',
        state: 'NY',
        postalCode: '10001',
        countryCode: 'US'
    },
    package: {
        weightKg: 1.5,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        declaredValue: 1000,
        currency: 'INR',
        description: 'Live test product'
    },
    order: {
        orderId: nextUnique('LIVE-ORDER-'),
        invoiceNumber: nextUnique('LIVE-INV-')
    },
    service: {
        serviceName: 'DFL EXPRESS - Standard',
        serviceCode: 'DFLS100'
    },
    customs: {
        hsnCode: '6109',
        itemDescription: 'Cotton T-shirt',
        quantity: 1,
        unitValue: 1000,
        countryOfOrigin: 'IN',
        csbType: 'CSB4'
    }
});

describe('Partner API backend Step 5C Production final approval', () => {
    beforeAll(async () => {
        await Promise.all([
            User.init(),
            Admin.init(),
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            DeveloperProductionRequest.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            SandboxBooking.init(),
            Shipment.init(),
            Transaction.init(),
            PartnerApiIdempotency.init(),
            WalletReservation.init(),
            PartnerApiOutboxEvent.init(),
            RateZone.init(),
            RateTable.init()
        ]);
    });

    beforeEach(async () => {
        await seedAuthoritativeRates();
    });

    test('final approval requires Super Admin authority even if a normal admin has the approve permission', async () => {
        const { account, productionRequest } = await createProductionFixture();
        const forgedApprovalAdmin = await createAdmin([DEVELOPER_PERMISSIONS.PRODUCTION_APPROVE], { role: 'admin' });

        await request(app)
            .post(`/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`)
            .expect(401);

        const denied = await adminPost(
            forgedApprovalAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`
        )
            .send(approvalBody())
            .expect(403);

        expect(denied.body.error_code).toBe('PRODUCTION_APPROVAL_PERMISSION_REQUIRED');

        const unchangedAccount = await DeveloperAccount.findById(account._id);
        const unchangedRequest = await DeveloperProductionRequest.findById(productionRequest._id);
        expect(unchangedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(unchangedAccount.liveApprovedAt).toBeNull();
        expect(unchangedRequest.status).toBe(APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW);
    });

    test('Super Admin approval enables Live access, stamps approver fields, audits the decision, and creates no production side effects', async () => {
        const { user, account, application, productionRequest } = await createProductionFixture();
        const superAdmin = await createAdmin([], { role: 'super_admin' });
        const beforeSideEffects = {
            shipments: await Shipment.countDocuments(),
            transactions: await Transaction.countDocuments(),
            sandboxBookings: await SandboxBooking.countDocuments(),
            liveCredentials: await ApiCredential.countDocuments({ environment: DEVELOPER_ENVIRONMENTS.LIVE })
        };

        const response = await adminPost(
            superAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`
        )
            .send(approvalBody())
            .expect(200);

        expect(response.body.data).toMatchObject({
            productionRequestId: productionRequest.productionRequestId,
            developerAccountId: account.developerAccountId,
            status: APPLICATION_STATUSES.LIVE_APPROVED,
            accessLevel: ACCESS_LEVELS.LIVE,
            accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
            tier: SLA_TIERS.GOLD
        });
        expect(response.body.data.liveApprovedAt).toBeTruthy();
        expect(response.body.data.approvedBy).toMatchObject({
            id: superAdmin._id.toString(),
            role: 'super_admin'
        });
        expect(JSON.stringify(response.body)).not.toContain('secretHash');

        const [updatedAccount, updatedRequest, updatedApplication, audits] = await Promise.all([
            DeveloperAccount.findById(account._id),
            DeveloperProductionRequest.findById(productionRequest._id).select('+internalReviewNotes +decisionHistory.internalReviewNotes'),
            DeveloperApplication.findById(application._id).select('+internalReviewNotes +decisionHistory.internalReviewNotes'),
            DeveloperAuditLog.find({ userId: user._id }).sort({ createdAt: 1 })
        ]);

        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.LIVE);
        expect(updatedAccount.accountStatus).toBe(DEVELOPER_ACCOUNT_STATUSES.ACTIVE);
        expect(updatedAccount.tier).toBe(SLA_TIERS.GOLD);
        expect(updatedAccount.liveApprovedAt).toBeTruthy();
        expect(updatedAccount.liveApprovedBy.toString()).toBe(superAdmin._id.toString());

        expect(updatedRequest.status).toBe(APPLICATION_STATUSES.LIVE_APPROVED);
        expect(updatedRequest.decidedBy.toString()).toBe(superAdmin._id.toString());
        expect(updatedRequest.decisionReason).toBe('Final review completed and Live API access is approved.');
        expect(updatedRequest.internalReviewNotes).toBe('Security and readiness checks completed before approval.');
        expect(updatedRequest.decisionHistory.map((entry) => entry.status)).toContain(APPLICATION_STATUSES.LIVE_APPROVED);

        expect(updatedApplication.status).toBe(APPLICATION_STATUSES.LIVE_APPROVED);
        expect(updatedApplication.decidedBy.toString()).toBe(superAdmin._id.toString());

        expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining([
            DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_APPROVED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_ACCESS_ENABLED
        ]));
        expect(audits.every((audit) => audit.actorRole === 'super_admin')).toBe(true);

        await expect(Shipment.countDocuments()).resolves.toBe(beforeSideEffects.shipments);
        await expect(Transaction.countDocuments()).resolves.toBe(beforeSideEffects.transactions);
        await expect(SandboxBooking.countDocuments()).resolves.toBe(beforeSideEffects.sandboxBookings);
        await expect(ApiCredential.countDocuments({ environment: DEVELOPER_ENVIRONMENTS.LIVE })).resolves.toBe(beforeSideEffects.liveCredentials);
    });

    test('approval rejects stale or incomplete review state without enabling Live access', async () => {
        const incomplete = await createProductionFixture({
            readinessScore: 80,
            requiredTestsComplete: false
        });
        const superAdmin = await createAdmin([], { role: 'super_admin' });

        const denied = await adminPost(
            superAdmin,
            `/api/admin/developer-hub/production-requests/${incomplete.productionRequest.productionRequestId}/approve`
        )
            .send(approvalBody())
            .expect(403);
        expect(denied.body.error_code).toBe('PRODUCTION_NOT_ELIGIBLE');
        expect(denied.body.details.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
            'PRODUCTION_READINESS_INCOMPLETE',
            'SANDBOX_TESTS_INCOMPLETE'
        ]));

        const unchangedAccount = await DeveloperAccount.findById(incomplete.account._id);
        expect(unchangedAccount.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(unchangedAccount.liveApprovedAt).toBeNull();

        const moreInfo = await createProductionFixture({
            status: APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
            missingInformation: ['Updated launch runbook'],
            allowResubmission: true
        });
        const notReviewable = await adminPost(
            superAdmin,
            `/api/admin/developer-hub/production-requests/${moreInfo.productionRequest.productionRequestId}/approve`
        )
            .send(approvalBody())
            .expect(409);
        expect(notReviewable.body.error_code).toBe('PRODUCTION_REQUEST_NOT_REVIEWABLE');
    });

    test('Live credentials are blocked before approval, allowed after approval, and valid Live keys admit bookings without carrier side effects', async () => {
        const { user, productionRequest } = await createProductionFixture();
        const superAdmin = await createAdmin([], { role: 'super_admin' });

        const liveDenied = await customerPost(user, '/api/developer/credentials')
            .send(credentialBody({ name: 'Pre Approval Live Key' }))
            .expect(403);
        expect(liveDenied.body.error_code).toBe('ENVIRONMENT_NOT_ALLOWED');

        await adminPost(
            superAdmin,
            `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`
        )
            .send(approvalBody())
            .expect(200);

        const generated = await customerPost(user, '/api/developer/credentials')
            .send(credentialBody())
            .expect(201);
        expect(generated.body.data.secret).toMatch(/^dfl_live_pk_[a-f0-9]{8}_[a-f0-9]{64}$/);
        expect(generated.body.data.credential).toMatchObject({
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            status: CREDENTIAL_STATUSES.ACTIVE,
            isPrimary: true
        });
        expect(generated.body.data.credential.secretHash).toBeUndefined();

        const beforePartnerCall = {
            shipments: await Shipment.countDocuments(),
            transactions: await Transaction.countDocuments(),
            sandboxBookings: await SandboxBooking.countDocuments(),
            reservations: await WalletReservation.countDocuments(),
            outboxEvents: await PartnerApiOutboxEvent.countDocuments(),
            idempotencyRecords: await PartnerApiIdempotency.countDocuments()
        };
        const walletBefore = await User.findById(user._id).lean();
        const partnerRequestId = nextUnique('live-admission-');

        const liveResponse = await request(app)
            .post('/api/v1/partner/bookings')
            .set('x-api-key', generated.body.data.secret)
            .set('x-partner-request-id', partnerRequestId)
            .send(partnerBookingPayload())
            .expect(202);

        expect(liveResponse.body).toMatchObject({
            success: true,
            message: 'Booking request accepted for processing.',
            data: {
                partnerRequestId,
                status: 'PROCESSING',
                environment: DEVELOPER_ENVIRONMENTS.LIVE
            }
        });
        expect(liveResponse.body.data.bookingId).toMatch(/^BKG_/);

        await expect(Shipment.countDocuments()).resolves.toBe(beforePartnerCall.shipments + 1);
        await expect(Transaction.countDocuments()).resolves.toBe(beforePartnerCall.transactions);
        await expect(SandboxBooking.countDocuments()).resolves.toBe(beforePartnerCall.sandboxBookings);
        await expect(WalletReservation.countDocuments()).resolves.toBe(beforePartnerCall.reservations + 1);
        await expect(PartnerApiOutboxEvent.countDocuments()).resolves.toBe(beforePartnerCall.outboxEvents + 1);
        await expect(PartnerApiIdempotency.countDocuments()).resolves.toBe(beforePartnerCall.idempotencyRecords + 1);

        const [walletAfter, shipment, reservation, outboxEvent] = await Promise.all([
            User.findById(user._id).lean(),
            Shipment.findOne({ partnerApiBookingId: liveResponse.body.data.bookingId }).lean(),
            WalletReservation.findOne({ partnerRequestId }).lean(),
            PartnerApiOutboxEvent.findOne({ partnerRequestId }).lean()
        ]);

        expect(shipment).toMatchObject({
            bookingSource: 'PARTNER_API',
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            processingStatus: 'PROCESSING',
            partnerRequestId,
            status: 'Pending',
            carrierBookingStatus: 'PENDING'
        });
        expect(shipment.trackingId).toBe('');
        expect(reservation).toMatchObject({
            status: 'ACTIVE',
            currency: 'INR',
            bookingId: liveResponse.body.data.bookingId,
            partnerRequestId
        });
        expect(outboxEvent).toMatchObject({
            status: 'PUBLISHED',
            eventType: 'LIVE_PARTNER_BOOKING_REQUESTED',
            partnerRequestId
        });
        expect(walletAfter.walletReservedBalance).toBeCloseTo((walletBefore.walletReservedBalance || 0) + reservation.amount);
        expect(walletAfter.walletBalance).toBeCloseTo(walletBefore.walletBalance - reservation.amount);

        const liveCredential = await ApiCredential.findOne({ credentialId: generated.body.data.credential.credentialId });
        expect(liveCredential.lastUsedAt).toBeTruthy();
        expect(liveCredential.requestCount).toBe(1);

        const apiLog = await ApiRequestLog.findOne({ credentialId: liveCredential._id });
        expect(apiLog).toMatchObject({
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            endpoint: '/api/v1/partner/bookings',
            statusCode: 202,
            errorCode: null
        });
        expect(JSON.stringify(apiLog.toJSON())).not.toContain(generated.body.data.secret);
    });

    test('competing final approvals produce exactly one approval and one controlled conflict', async () => {
        const { account, productionRequest } = await createProductionFixture();
        const superAdmin = await createAdmin([], { role: 'super_admin' });

        const [first, second] = await Promise.all([
            adminPost(
                superAdmin,
                `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`
            ).send(approvalBody({ internalNotes: 'First concurrent approval.' })),
            adminPost(
                superAdmin,
                `/api/admin/developer-hub/production-requests/${productionRequest.productionRequestId}/approve`
            ).send(approvalBody({ internalNotes: 'Second concurrent approval.' }))
        ]);

        expect([first.status, second.status].sort()).toEqual([200, 409]);
        const failed = first.status === 409 ? first : second;
        expect(['PRODUCTION_APPROVAL_CONFLICT', 'PRODUCTION_ALREADY_APPROVED']).toContain(failed.body.error_code);

        const updatedAccount = await DeveloperAccount.findById(account._id);
        expect(updatedAccount.accessLevel).toBe(ACCESS_LEVELS.LIVE);
        expect(updatedAccount.liveApprovedBy.toString()).toBe(superAdmin._id.toString());

        const approvalAudits = await DeveloperAuditLog.find({
            targetId: productionRequest.productionRequestId,
            action: DEVELOPER_AUDIT_ACTIONS.PRODUCTION_ACCESS_APPROVED
        });
        expect(approvalAudits).toHaveLength(1);
    });
});
