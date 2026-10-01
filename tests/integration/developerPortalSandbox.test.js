process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-4-test-pepper';

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
const SandboxBooking = require('../../models/SandboxBooking');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS,
    SANDBOX_BOOKING_STATUSES
} = require('../../constants/developerPortal');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Sandbox User',
    email: overrides.email || `${nextUnique('sandbox')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    kycData: {
        status: 'verified',
        panName: overrides.companyName || 'Sandbox Customer Pvt Ltd'
    },
    ...overrides
});

const createSandboxApprovedAccount = async (user, overrides = {}) => {
    const account = await DeveloperAccount.create({
        userId: user._id,
        accessLevel: overrides.accessLevel || ACCESS_LEVELS.SANDBOX,
        accountStatus: overrides.accountStatus || DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        sandboxApprovedAt: new Date(),
        liveApprovedAt: overrides.accessLevel === ACCESS_LEVELS.LIVE ? new Date() : null,
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
        status: overrides.accessLevel === ACCESS_LEVELS.LIVE
            ? APPLICATION_STATUSES.LIVE_APPROVED
            : APPLICATION_STATUSES.SANDBOX_APPROVED,
        submittedAt: new Date()
    });

    return account;
};

const authRequest = (user) => ({
    get: (path) => request(app).get(path).set('Authorization', `Bearer ${signToken(user._id)}`),
    post: (path) => request(app).post(path).set('Authorization', `Bearer ${signToken(user._id)}`)
});

const generateKey = async (user, environment = DEVELOPER_ENVIRONMENTS.SANDBOX) => {
    const response = await authRequest(user)
        .post('/api/developer/credentials')
        .send({
            name: `${environment} API Key`,
            environment,
            password: 'Password123!'
        })
        .expect(201);

    return response.body.data;
};

const validPayload = (overrides = {}) => ({
    recipient: {
        name: 'Sandbox Customer',
        phone: '9876543210',
        email: 'customer@example.com',
        addressLine1: 'Test Address',
        addressLine2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        postalCode: '400001',
        countryCode: 'IN',
        ...(overrides.recipient || {})
    },
    package: {
        weightKg: 1.5,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        declaredValue: 1000,
        currency: 'INR',
        description: 'Sandbox test product',
        ...(overrides.package || {})
    },
    order: {
        orderId: 'TEST-ORDER-1001',
        invoiceNumber: 'TEST-INV-1001',
        ...(overrides.order || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['recipient', 'package', 'order'].includes(key)))
});

const partnerCreate = (apiKey, partnerRequestId, payload = validPayload(), scenario = 'success') => {
    const req = request(app)
        .post('/api/v1/partner/bookings')
        .set('Content-Type', 'application/json');
    if (apiKey) req.set('x-api-key', apiKey);
    if (partnerRequestId) req.set('x-partner-request-id', partnerRequestId);
    if (scenario) req.set('x-sandbox-scenario', scenario);
    return req.send(payload);
};

describe('Partner API backend Step 4 Sandbox simulator', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init(),
            SandboxBooking.init(),
            Shipment.init(),
            Transaction.init()
        ]);
    });

    afterEach(() => {
        delete process.env.PARTNER_SANDBOX_RATE_LIMIT_PER_MINUTE;
    });

    test('creates a sandbox booking with real API-key auth, logs request, and avoids production side effects', async () => {
        const user = await createUser({ walletBalance: 30000 });
        const account = await createSandboxApprovedAccount(user);
        const key = await generateKey(user);

        const response = await partnerCreate(key.secret, 'test-order-1001').expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data).toMatchObject({
            partnerRequestId: 'test-order-1001',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            status: SANDBOX_BOOKING_STATUSES.BOOKED,
            label: {
                available: false
            }
        });
        expect(response.body.data.bookingId).toMatch(/^SBKG_[A-F0-9]{16}$/);
        expect(response.body.data.trackingNumber).toMatch(/^SBOXDFL[A-F0-9]{12}$/);

        const booking = await SandboxBooking.findOne({ sandboxBookingId: response.body.data.bookingId });
        expect(booking).toMatchObject({
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            walletDeducted: false,
            carrierInvoked: false,
            realLabelGenerated: false,
            manifestEligible: false
        });
        expect(booking.trackingEvents).toHaveLength(1);
        expect(booking.trackingEvents[0].status).toBe(SANDBOX_BOOKING_STATUSES.BOOKED);

        const logs = await ApiRequestLog.find({ developerAccountId: account._id });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
            endpoint: '/api/v1/partner/bookings',
            partnerRequestId: 'test-order-1001',
            statusCode: 201,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX
        });
        expect(JSON.stringify(logs[0].toJSON())).not.toContain(key.secret);
        expect(JSON.stringify(logs[0].toJSON())).not.toContain('x-api-key');

        const audit = await DeveloperAuditLog.findOne({
            action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_CREATED,
            targetId: response.body.data.bookingId
        });
        expect(audit).not.toBeNull();

        const updatedUser = await User.findById(user._id);
        expect(updatedUser.walletBalance).toBe(30000);
        expect(await Shipment.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
    });

    test('validates required headers, payload fields, unknown fields, and scenario allowlist', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const key = await generateKey(user);

        const missingPartnerId = await partnerCreate(key.secret, null).expect(400);
        expect(missingPartnerId.body.error_code).toBe('PARTNER_REQUEST_ID_REQUIRED');

        const invalidPartnerId = await partnerCreate(key.secret, 'bad id with spaces').expect(400);
        expect(invalidPartnerId.body.error_code).toBe('INVALID_PARTNER_REQUEST_ID');

        const invalidPayload = await partnerCreate(
            key.secret,
            'test-invalid-weight',
            validPayload({ package: { weightKg: -1 } })
        ).expect(400);
        expect(invalidPayload.body.error_code).toBe('INVALID_INPUT');
        expect(invalidPayload.body.details.some((detail) => detail.field === 'package.weightKg')).toBe(true);

        const unknownField = await partnerCreate(
            key.secret,
            'test-unknown-field',
            validPayload({ unexpected: 'not allowed' })
        ).expect(400);
        expect(unknownField.body.details.some((detail) => detail.field === 'unexpected')).toBe(true);

        const unknownScenario = await partnerCreate(key.secret, 'test-bad-scenario', validPayload(), 'eval(process)').expect(400);
        expect(unknownScenario.body.error_code).toBe('INVALID_SANDBOX_SCENARIO');
    });

    test('idempotency returns the same booking for identical replay and conflicts for changed payload', async () => {
        const user = await createUser();
        const account = await createSandboxApprovedAccount(user);
        const key = await generateKey(user);

        const first = await partnerCreate(key.secret, 'test-idempotent').expect(201);
        const second = await partnerCreate(key.secret, 'test-idempotent').expect(200);
        expect(second.body.data.bookingId).toBe(first.body.data.bookingId);
        expect(await SandboxBooking.countDocuments({ developerAccountId: account._id, partnerRequestId: 'test-idempotent' })).toBe(1);

        const conflict = await partnerCreate(
            key.secret,
            'test-idempotent',
            validPayload({ package: { declaredValue: 2000 } })
        ).expect(409);
        expect(conflict.body.error_code).toBe('IDEMPOTENCY_CONFLICT');

        const otherUser = await createUser();
        await createSandboxApprovedAccount(otherUser);
        const otherKey = await generateKey(otherUser);
        await partnerCreate(otherKey.secret, 'test-idempotent').expect(201);
        expect(await SandboxBooking.countDocuments({ partnerRequestId: 'test-idempotent' })).toBe(2);
    });

    test('scenario engine returns controlled sandbox errors without creating bookings', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const key = await generateKey(user);

        const validation = await partnerCreate(key.secret, 'scenario-validation', validPayload(), 'validation_error').expect(400);
        expect(validation.body.error_code).toBe('INVALID_INPUT');

        const balance = await partnerCreate(key.secret, 'scenario-balance', validPayload(), 'insufficient_sandbox_balance').expect(402);
        expect(balance.body.error_code).toBe('SANDBOX_INSUFFICIENT_BALANCE');

        const timeout = await partnerCreate(key.secret, 'scenario-timeout', validPayload(), 'carrier_timeout').expect(504);
        expect(timeout.body.error_code).toBe('SANDBOX_CARRIER_TIMEOUT');

        const rejected = await partnerCreate(key.secret, 'scenario-rejected', validPayload(), 'booking_rejected').expect(422);
        expect(rejected.body.error_code).toBe('SANDBOX_BOOKING_REJECTED');

        expect(await SandboxBooking.countDocuments()).toBe(0);
        expect(await Shipment.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
    });

    test('booking retrieval, tracking, cancellation, and portal readiness are tenant scoped', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const key = await generateKey(user);
        const created = await partnerCreate(key.secret, 'test-flow', validPayload(), 'tracking_progress').expect(201);

        const otherUser = await createUser();
        await createSandboxApprovedAccount(otherUser);
        const otherKey = await generateKey(otherUser);
        await request(app)
            .get(`/api/v1/partner/bookings/${created.body.data.bookingId}`)
            .set('x-api-key', otherKey.secret)
            .expect(404);
        await request(app)
            .get(`/api/v1/partner/tracking/${created.body.data.trackingNumber}`)
            .set('x-api-key', otherKey.secret)
            .expect(404);

        const booking = await request(app)
            .get(`/api/v1/partner/bookings/${created.body.data.bookingId}`)
            .set('x-api-key', key.secret)
            .expect(200);
        expect(booking.body.data.status).toBe(SANDBOX_BOOKING_STATUSES.IN_TRANSIT);

        const tracking = await request(app)
            .get(`/api/v1/partner/tracking/${created.body.data.trackingNumber}`)
            .set('x-api-key', key.secret)
            .expect(200);
        expect(tracking.body.data.events.map((event) => event.status)).toEqual([
            SANDBOX_BOOKING_STATUSES.BOOKED,
            SANDBOX_BOOKING_STATUSES.PICKUP_SCHEDULED,
            SANDBOX_BOOKING_STATUSES.PICKED_UP,
            SANDBOX_BOOKING_STATUSES.IN_TRANSIT
        ]);

        const notCancellable = await request(app)
            .post(`/api/v1/partner/bookings/${created.body.data.bookingId}/cancel`)
            .set('Content-Type', 'application/json')
            .set('x-api-key', key.secret)
            .send({ reason: 'Sandbox cancellation test' })
            .expect(409);
        expect(notCancellable.body.error_code).toBe('BOOKING_NOT_CANCELLABLE');

        const cancellable = await partnerCreate(key.secret, 'test-cancel').expect(201);
        const cancelled = await request(app)
            .post(`/api/v1/partner/bookings/${cancellable.body.data.bookingId}/cancel`)
            .set('Content-Type', 'application/json')
            .set('x-api-key', key.secret)
            .send({ reason: 'Sandbox cancellation test' })
            .expect(200);
        expect(cancelled.body.data.status).toBe(SANDBOX_BOOKING_STATUSES.CANCELLED);

        await partnerCreate(key.secret, 'test-readiness-validation', validPayload(), 'validation_error').expect(400);
        const readiness = await authRequest(user).get('/api/developer/sandbox/readiness').expect(200);
        expect(readiness.body.data.summary.successfulBookings).toBeGreaterThanOrEqual(2);
        expect(readiness.body.data.summary.trackingTests).toBeGreaterThanOrEqual(1);
        expect(readiness.body.data.summary.cancellationTests).toBeGreaterThanOrEqual(1);
        expect(readiness.body.data.readinessScore).toBeGreaterThanOrEqual(80);

        const portalList = await authRequest(user).get('/api/developer/sandbox/bookings').expect(200);
        expect(portalList.body.data.some((item) => item.bookingId === cancellable.body.data.bookingId)).toBe(true);
        const portalDetail = await authRequest(user).get(`/api/developer/sandbox/bookings/${cancellable.body.data.bookingId}`).expect(200);
        expect(portalDetail.body.data.tracking.events.some((event) => event.status === SANDBOX_BOOKING_STATUSES.CANCELLED)).toBe(true);
    });

    test('customer dashboard simulator creates, tracks, and cancels sandbox bookings without exposing API keys', async () => {
        const user = await createUser();
        await createSandboxApprovedAccount(user);

        const created = await authRequest(user)
            .post('/api/developer/sandbox/bookings')
            .send({
                partnerRequestId: 'dashboard-sandbox-1001',
                scenario: 'success',
                payload: validPayload({ order: { orderId: 'dashboard-sandbox-1001' } })
            })
            .expect(201);

        expect(created.body.data).toMatchObject({
            partnerRequestId: 'dashboard-sandbox-1001',
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            status: SANDBOX_BOOKING_STATUSES.BOOKED
        });

        const tracking = await authRequest(user)
            .get(`/api/developer/sandbox/tracking/${created.body.data.trackingNumber}`)
            .expect(200);
        expect(tracking.body.data.tracking.currentStatus).toBe(SANDBOX_BOOKING_STATUSES.BOOKED);

        const cancelled = await authRequest(user)
            .post(`/api/developer/sandbox/bookings/${created.body.data.bookingId}/cancel`)
            .send({ reason: 'Dashboard cancellation test.' })
            .expect(200);
        expect(cancelled.body.data.status).toBe(SANDBOX_BOOKING_STATUSES.CANCELLED);

        const logs = await ApiRequestLog.find({});
        expect(JSON.stringify(logs)).not.toContain('x-api-key');
    });

    test('partner tracking routes live credentials to scoped Live tracking and enforces sandbox credential rate limits', async () => {
        const liveUser = await createUser();
        await createSandboxApprovedAccount(liveUser, { accessLevel: ACCESS_LEVELS.LIVE });
        const liveKey = await generateKey(liveUser, DEVELOPER_ENVIRONMENTS.LIVE);

        const liveDenied = await request(app)
            .get('/api/v1/partner/tracking/SBOXDFLLIVEKEY')
            .set('x-api-key', liveKey.secret)
            .expect(404);
        expect(liveDenied.body.error_code).toBe('TRACKING_NOT_FOUND');

        const user = await createUser();
        await createSandboxApprovedAccount(user);
        const key = await generateKey(user);
        process.env.PARTNER_SANDBOX_RATE_LIMIT_PER_MINUTE = '1';

        await partnerCreate(key.secret, 'rate-limit-one').expect(201);
        const limited = await partnerCreate(key.secret, 'rate-limit-two').expect(429);
        expect(limited.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
        expect(limited.headers['retry-after']).toBeTruthy();
    });
});
