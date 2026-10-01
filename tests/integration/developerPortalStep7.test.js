process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-6a-test-pepper';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { app } = require('../../server');
const User = require('../../models/User');
const DeveloperAccount = require('../../models/DeveloperAccount');
const ApiCredential = require('../../models/ApiCredential');
const ApiRequestLog = require('../../models/ApiRequestLog');
const SandboxBooking = require('../../models/SandboxBooking');
const Shipment = require('../../models/Shipment');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const WalletReservation = require('../../models/WalletReservation');

const { generateApiKey } = require('../../utils/developerCredentialCrypto');

describe('Partner API Step 7 - Developer Portal & Services Catalogue', () => {
    let userA, userB;
    let devAccountA, devAccountB;
    let tokenA, tokenB;
    let sandboxCredA, liveCredA;
    let sandboxCredB;
    let apiKeySandboxA, apiKeyLiveA, apiKeySandboxB;

    beforeEach(async () => {
        await Promise.all([
            User.deleteMany({}),
            DeveloperAccount.deleteMany({}),
            ApiCredential.deleteMany({}),
            ApiRequestLog.deleteMany({}),
            SandboxBooking.deleteMany({}),
            Shipment.deleteMany({}),
            PartnerApiCancellation.deleteMany({}),
            WalletReservation.deleteMany({})
        ]);

        // Build Users
        userA = await User.create({
            name: 'Partner User A',
            email: 'partnerA@example.com',
            password: 'Password123!',
            role: 'customer',
            customerId: 'DFLC-PARTNERA',
            kycVerified: true,
            phone: '9876543210'
        });
        tokenA = jwt.sign({ id: userA._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

        userB = await User.create({
            name: 'Partner User B',
            email: 'partnerB@example.com',
            password: 'Password123!',
            role: 'customer',
            customerId: 'DFLC-PARTNERB',
            kycVerified: true,
            phone: '9876543211'
        });
        tokenB = jwt.sign({ id: userB._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

        // Build Developer Accounts
        devAccountA = await DeveloperAccount.create({
            userId: userA._id,
            accessLevel: 'LIVE',
            accountStatus: 'ACTIVE'
        });

        devAccountB = await DeveloperAccount.create({
            userId: userB._id,
            accessLevel: 'SANDBOX',
            accountStatus: 'ACTIVE'
        });

        // Build Credentials
        const generatedSandboxA = generateApiKey('SANDBOX');
        apiKeySandboxA = generatedSandboxA.fullApiKey;
        sandboxCredA = await ApiCredential.create({
            userId: userA._id,
            developerAccountId: devAccountA._id,
            environment: 'SANDBOX',
            name: 'Sandbox Key A',
            prefix: generatedSandboxA.prefix,
            secretHash: generatedSandboxA.secretHash,
            status: 'ACTIVE',
            isPrimary: true,
            createdBy: userA._id,
            createdByModel: 'User'
        });

        const generatedLiveA = generateApiKey('LIVE');
        apiKeyLiveA = generatedLiveA.fullApiKey;
        liveCredA = await ApiCredential.create({
            userId: userA._id,
            developerAccountId: devAccountA._id,
            environment: 'LIVE',
            name: 'Live Key A',
            prefix: generatedLiveA.prefix,
            secretHash: generatedLiveA.secretHash,
            status: 'ACTIVE',
            isPrimary: true,
            createdBy: userA._id,
            createdByModel: 'User'
        });

        const generatedSandboxB = generateApiKey('SANDBOX');
        apiKeySandboxB = generatedSandboxB.fullApiKey;
        sandboxCredB = await ApiCredential.create({
            userId: userB._id,
            developerAccountId: devAccountB._id,
            environment: 'SANDBOX',
            name: 'Sandbox Key B',
            prefix: generatedSandboxB.prefix,
            secretHash: generatedSandboxB.secretHash,
            status: 'ACTIVE',
            isPrimary: true,
            createdBy: userB._id,
            createdByModel: 'User'
        });

        // Seed a live shipment for Partner A
        await Shipment.create({
            developerAccountId: devAccountA._id,
            user: userA._id,
            shipmentId: 'SHIP-LIV-001',
            partnerApiBookingId: 'DFLBK-LIV-001',
            partnerRequestId: 'REQ-LIV-001',
            environment: 'LIVE',
            bookingSource: 'PARTNER_API',
            status: 'Pending',
            processingStatus: 'PROCESSING',
            shipperDetails: {
                shipperName: 'Shipper A',
                mobileNo: '9876543210',
                addressLine1: 'Line 1',
                city: 'Delhi',
                country: 'India',
                pincode: '110001'
            },
            consigneeDetails: {
                consigneeName: 'Consignee A',
                mobileNo: '9876543210',
                addressLine1: 'Line 1',
                city: 'New York',
                country: 'US',
                pincode: '10001'
            },
            shipmentDetails: {
                invoiceNumber: 'INV-LIV-001'
            }
        });

        // Seed a sandbox booking for Partner A
        await SandboxBooking.create({
            userId: userA._id,
            developerAccountId: devAccountA._id,
            sandboxBookingId: 'DFLBK-SB-001',
            partnerRequestId: 'REQ-SB-001',
            environment: 'SANDBOX',
            status: 'BOOKED',
            recipient: {
                name: 'Consignee Sandbox',
                phone: '1234567890',
                countryCode: 'US'
            }
        });

        // Seed a live shipment for Partner B (to test tenant isolation)
        await Shipment.create({
            developerAccountId: devAccountB._id,
            user: userB._id,
            shipmentId: 'SHIP-LIV-002',
            partnerApiBookingId: 'DFLBK-LIV-002',
            partnerRequestId: 'REQ-LIV-002',
            environment: 'LIVE',
            bookingSource: 'PARTNER_API',
            status: 'Pending',
            processingStatus: 'PROCESSING',
            shipperDetails: {
                shipperName: 'Shipper B',
                mobileNo: '9876543210',
                addressLine1: 'Line 1',
                city: 'Delhi',
                country: 'India',
                pincode: '110001'
            },
            consigneeDetails: {
                consigneeName: 'Consignee B',
                mobileNo: '9876543210',
                addressLine1: 'Line 1',
                city: 'New York',
                country: 'US',
                pincode: '10001'
            },
            shipmentDetails: {
                invoiceNumber: 'INV-LIV-002'
            }
        });

        // Seed a request log entry
        await ApiRequestLog.create({
            requestId: 'DREQ-TEST-001',
            userId: userA._id,
            developerAccountId: devAccountA._id,
            credentialId: sandboxCredA._id,
            environment: 'SANDBOX',
            method: 'POST',
            endpoint: '/api/v1/partner/bookings',
            statusCode: 201,
            latencyMs: 150,
            requestMetadata: {
                safeField: 'Hello',
                customField: 'TestValue'
            }
        });
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    describe('Public Service Catalogue - GET /api/v1/partner/services', () => {
        test('Should succeed and return public catalogue for valid Sandbox key', async () => {
            const res = await request(app)
                .get('/api/v1/partner/services')
                .set('x-api-key', apiKeySandboxA);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
            expect(res.body.data.length).toBeGreaterThan(0);

            // Ensure internal fields are absent
            const item = res.body.data[0];
            expect(item).toHaveProperty('serviceName');
            expect(item).toHaveProperty('serviceCode');
            expect(item).not.toHaveProperty('provider');
            expect(item).not.toHaveProperty('carrier');
            expect(item).not.toHaveProperty('dflCost');
        });

        test('Should fail for invalid api key', async () => {
            const res = await request(app)
                .get('/api/v1/partner/services')
                .set('x-api-key', 'invalid-key');

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
        });

        test('Should fail when account is suspended', async () => {
            await DeveloperAccount.findByIdAndUpdate(devAccountB._id, { accountStatus: 'SUSPENDED' });

            const res = await request(app)
                .get('/api/v1/partner/services')
                .set('x-api-key', apiKeySandboxB);

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);
            expect(res.body.error_code).toBe('ACCOUNT_SUSPENDED');
        });
    });

    describe('Public Bookings List - GET /api/v1/partner/bookings', () => {
        test('Should fetch Live bookings list for Partner A with tenant isolation', async () => {
            const res = await request(app)
                .get('/api/v1/partner/bookings')
                .set('x-api-key', apiKeyLiveA);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.items.length).toBe(1);
            expect(res.body.data.items[0].bookingId).toBe('DFLBK-LIV-001');

            // Internal fields should be stripped
            expect(res.body.data.items[0]).not.toHaveProperty('_id');
            expect(res.body.data.items[0]).not.toHaveProperty('walletReservationId');
        });

        test('Should fetch Sandbox bookings list for Partner A', async () => {
            const res = await request(app)
                .get('/api/v1/partner/bookings')
                .set('x-api-key', apiKeySandboxA);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.items.length).toBe(1);
            expect(res.body.data.items[0].bookingId).toBe('DFLBK-SB-001');
        });
    });

    describe('Session Developer Routes - GET /api/developer/*', () => {
        test('Should deny access for logged-out users', async () => {
            const res = await request(app).get('/api/developer/services');
            expect(res.status).toBe(401);
        });

        test('Should return services list using session token', async () => {
            const res = await request(app)
                .get('/api/developer/services?environment=sandbox')
                .set('Authorization', `Bearer ${tokenA}`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.length).toBeGreaterThan(0);
        });

        test('Should fetch list of bookings via session', async () => {
            const res = await request(app)
                .get('/api/developer/bookings?environment=live')
                .set('Authorization', `Bearer ${tokenA}`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.items.length).toBe(1);
            expect(res.body.data.items[0].bookingId).toBe('DFLBK-LIV-001');
        });

        test('Should fetch detailed booking and deny cross-tenant lookup', async () => {
            // Retrieve own booking
            const res1 = await request(app)
                .get('/api/developer/bookings/DFLBK-LIV-001?environment=live')
                .set('Authorization', `Bearer ${tokenA}`);
            expect(res1.status).toBe(200);
            expect(res1.body.data.bookingId).toBe('DFLBK-LIV-001');

            // Try to retrieve Partner B's booking
            const res2 = await request(app)
                .get('/api/developer/bookings/DFLBK-LIV-002?environment=live')
                .set('Authorization', `Bearer ${tokenA}`);
            expect(res2.status).toBe(404);
            expect(res2.body.success).toBe(false);
            expect(res2.body.error_code).toBe('BOOKING_NOT_FOUND');
        });
    });

    describe('Sanitized Request History - GET /api/developer/history', () => {
        test('Should list logs correctly mapped and tenant isolated', async () => {
            const res = await request(app)
                .get('/api/developer/history')
                .set('Authorization', `Bearer ${tokenA}`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.items.length).toBe(1);

            const log = res.body.data.items[0];
            expect(log.requestId).toBe('DREQ-TEST-001');
            expect(log).not.toHaveProperty('requestMetadata');
            expect(log).not.toHaveProperty('responseMetadata');
        });
    });
});
