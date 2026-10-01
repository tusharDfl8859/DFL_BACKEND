process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-6a-test-pepper';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';
process.env.SPEEDBOX_API_URL = '';

const mongoose = require('mongoose');
const request = require('supertest');
const { app } = require('../../server');
const User = require('../../models/User');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const ApiCredential = require('../../models/ApiCredential');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
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
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    SLA_TIERS,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');
const rateCalculator = require('../../utils/rateCalculator');
const carrierBookingService = require('../../services/carriers/CarrierBookingService');
const { processLivePartnerBookingJob } = require('../../workers/livePartnerBookingWorker');
const { processLivePartnerCancellationJob } = require('../../workers/livePartnerCancellationWorker');
const { processCancellationReconciliationJob } = require('../../workers/cancellationReconciliationWorker');
const { processRefundReconciliationJob } = require('../../workers/refundReconciliationWorker');
const { runLivePartnerIntegrityCheck } = require('../../services/openapi/livePartnerIntegrityService');

const liveCarrierConcurrencyService = require('../../services/openapi/liveCarrierConcurrencyService');

let uniqueCounter = 0;
const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Live Admission Customer',
    email: overrides.email || `${nextUnique('live-cancel')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    walletReservedBalance: overrides.walletReservedBalance ?? 0,
    kycVerified: true,
    companyName: overrides.companyName || 'Live Admission Pvt Ltd',
    kycData: {
        status: 'verified',
        panName: overrides.companyName || 'Live Admission Pvt Ltd',
        billingAddress: {
            addressLine1: 'DFL Pickup Address',
            addressLine2: 'Sector 132',
            city: 'Noida',
            state: 'Uttar Pradesh',
            pincode: '201301',
            country: 'IN'
        }
    },
    ...overrides
});

const createDeveloperFixture = async ({ accessLevel = ACCESS_LEVELS.LIVE, environment = DEVELOPER_ENVIRONMENTS.LIVE, userOverrides = {} } = {}) => {
    const user = await createUser(userOverrides);
    const account = await DeveloperAccount.create({
        userId: user._id,
        accessLevel,
        accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
        tier: SLA_TIERS.GOLD,
        sandboxApprovedAt: new Date(),
        liveApprovedAt: accessLevel === ACCESS_LEVELS.LIVE ? new Date() : null
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
        status: accessLevel === ACCESS_LEVELS.LIVE
            ? APPLICATION_STATUSES.LIVE_APPROVED
            : APPLICATION_STATUSES.SANDBOX_APPROVED,
        submittedAt: new Date()
    });

    const generated = generateApiKey(environment);
    const credential = await ApiCredential.create({
        userId: user._id,
        developerAccountId: account._id,
        environment,
        name: `${environment} Test Key`,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        status: CREDENTIAL_STATUSES.ACTIVE,
        isPrimary: true,
        createdBy: user._id,
        createdByModel: 'User'
    });

    return {
        user,
        account,
        credential,
        apiKey: generated.fullApiKey
    };
};

const bookingPayload = (partnerRequestId) => ({
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
        orderId: `ORD-${partnerRequestId}`,
        invoiceNumber: `INV-${partnerRequestId}`
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

const postPartnerBooking = ({ apiKey, partnerRequestId }) => request(app)
    .post('/api/v1/partner/bookings')
    .set('x-api-key', apiKey)
    .set('x-partner-request-id', partnerRequestId)
    .send(bookingPayload(partnerRequestId));

const cancelPartnerBooking = ({ apiKey, bookingId, partnerRequestId, body = { reason: 'Customer requested cancellation.' } }) => request(app)
    .post(`/api/v1/partner/bookings/${bookingId}/cancel`)
    .set('x-api-key', apiKey)
    .set('x-partner-request-id', partnerRequestId)
    .send(body);

const seedAuthoritativeRates = async () => {
    rateCalculator.zones = null;
    rateCalculator.rates = null;
    rateCalculator.serviceMap = null;
    rateCalculator.cache = new Map();
    await Promise.all([
        RateZone.create({ country: 'US', state: 'NY', zone: 'TUS1' }),
        RateTable.create({ weight: 2, rates: { TUS1: 500, UUSPS: 575 } })
    ]);
};

describe('Step 6C Isolated Partner API Cancellation & Refunds Concurrency tests', () => {
    beforeAll(async () => {
        await mongoose.connection.dropDatabase();
        await Promise.all(Object.values(mongoose.models).map(model => model.ensureIndexes()));
        await seedAuthoritativeRates();
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    test('Cancellation validation, tenancy, and isolation checks', async () => {
        const live = await createDeveloperFixture();
        const other = await createDeveloperFixture();
        const sandbox = await createDeveloperFixture({
            accessLevel: ACCESS_LEVELS.SANDBOX,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX
        });
        const createResponse = await postPartnerBooking({
            apiKey: live.apiKey,
            partnerRequestId: nextUnique('live-cancel-validate-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;

        // Validation payload check
        await cancelPartnerBooking({
            apiKey: live.apiKey,
            bookingId,
            partnerRequestId: nextUnique('live-cancel-protected-'),
            body: { reason: 'Cancel this booking.', refundAmount: 500 }
        }).expect(400);

        // Tenancy check (mismatched developer account)
        await cancelPartnerBooking({
            apiKey: other.apiKey,
            bookingId,
            partnerRequestId: nextUnique('live-cancel-cross-')
        }).expect(404);

        // Sandbox isolation check
        await cancelPartnerBooking({
            apiKey: sandbox.apiKey,
            bookingId,
            partnerRequestId: nextUnique('live-cancel-sandbox-')
        }).expect(404);
    });

    test('Cancellation before worker claim (Phase 1 checks CANCELLATION_QUEUED)', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('pre-claim-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });

        // Queue cancellation before claim
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('pre-claim-cancel-'),
            body: { reason: 'Cancel before worker claim.' }
        }).expect(202);

        // Process booking job - should abort because cancellation exists
        const result = await processLivePartnerBookingJob({
            id: 'job-booking-pre-claim',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });

        expect(['CANCELLED_OR_CANCELLATION_PENDING', 'CANCELLED_BEFORE_CARRIER']).toContain(result.status);

        const finalShipment = await Shipment.findById(shipment._id);
        expect(finalShipment.carrierBookingStatus).toBe('PENDING'); // Not claimed
    });

    test('Cancellation during worker claim (Phase 2 fails and skips carrier call)', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('during-claim-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });

        const originalFindOneAndUpdate = Shipment.findOneAndUpdate.bind(Shipment);
        let phase1Completed = {};
        phase1Completed.promise = new Promise(resolve => { phase1Completed.resolve = resolve; });
        let allowPhase2ToProceed;
        const phase2Gate = new Promise(resolve => { allowPhase2ToProceed = resolve; });

        const updateSpy = jest.spyOn(Shipment, 'findOneAndUpdate').mockImplementation(async function(filter, update, options) {
            const isPhase1 = filter.carrierBookingStatus && filter.carrierBookingStatus.$in;
            const res = await originalFindOneAndUpdate(filter, update, options);
            if (isPhase1 && res) {
                phase1Completed.resolve();
                await phase2Gate;
            }
            return res;
        });

        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({ success: true, awb: 'AWB-RACE', carrier: 'TPL' });
        jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);

        // Start booking job asynchronously
        const bookingPromise = processLivePartnerBookingJob({
            id: 'job-booking-race-claim',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });

        // Wait for Phase 1 claim to be recorded in DB
        await phase1Completed.promise;

        // Send cancellation request concurrently
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('during-claim-cancel-'),
            body: { reason: 'Cancel during worker claim.' }
        }).expect(202);

        // Process cancellation job
        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        await processLivePartnerCancellationJob({
            id: 'job-cancel-race',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });

        // Let Phase 2 proceed
        allowPhase2ToProceed();
        const result = await bookingPromise;

        expect(result.status).toBe('SKIPPED_DUE_TO_CANCELLATION');
        expect(carrierSpy).not.toHaveBeenCalled();

        const refreshedShipment = await Shipment.findById(shipment._id);
        expect(refreshedShipment.carrierBookingStatus).toBe('SKIPPED_CANCELLED');
        expect(refreshedShipment.processingStatus).toBe('CANCELLATION_PENDING');

        updateSpy.mockRestore();
        carrierSpy.mockRestore();
    });

    test('Cancellation while carrier call is running (REQUESTED status checks)', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('carrier-run-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });

        let allowCarrierToReturn;
        const carrierGate = new Promise(resolve => { allowCarrierToReturn = resolve; });
        const carrierStarted = {};
        carrierStarted.promise = new Promise(resolve => { carrierStarted.resolve = resolve; });

        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockImplementation(async () => {
            carrierStarted.resolve();
            await carrierGate;
            return { success: true, awb: 'AWB-RUNNING', carrier: 'TPL' };
        });
        jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);

        const bookingPromise = processLivePartnerBookingJob({
            id: 'job-booking-carrier-run',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });

        // Wait for carrier call to start
        await carrierStarted.promise;

        // Cancel while carrier call is running (shipment has REQUESTED status)
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('carrier-run-cancel-'),
            body: { reason: 'Cancel while carrier call is running.' }
        }).expect(202);

        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        const cancelResult = await processLivePartnerCancellationJob({
            id: 'job-cancel-carrier-run',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });

        expect(cancelResult.status).toBe('CANCELLATION_STATUS_UNKNOWN');

        // Allow booking to finish successfully
        allowCarrierToReturn();
        await bookingPromise;

        const finalShipment = await Shipment.findById(shipment._id);
        expect(finalShipment.carrierBookingStatus).toBe('BOOKED'); // Ends up booked

        carrierSpy.mockRestore();
    });

    test('Two concurrent cancellation requests are safe and idempotent', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('multi-cancel-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;

        const cancelRef = nextUnique('multi-cancel-ref-');

        const [res1, res2] = await Promise.all([
            cancelPartnerBooking({
                apiKey: fixture.apiKey,
                bookingId,
                partnerRequestId: cancelRef,
                body: { reason: 'Customer cancellation 1.' }
            }),
            cancelPartnerBooking({
                apiKey: fixture.apiKey,
                bookingId,
                partnerRequestId: cancelRef,
                body: {
                    reason: 'Customer cancellation 1.'
                }
            })
        ]);

        expect(res1.status).toBe(202);
        expect(res2.status).toBe(202); // Idempotent replay success

        const count = await PartnerApiCancellation.countDocuments({ bookingId });
        expect(count).toBe(1);
    });

    test('Database refund uniqueness allows exactly one Transaction and wallet credit', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('refund-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });

        // Complete booking and settle
        jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);
        jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: 'AWB-REFUND-UNIQ',
            carrier: 'TPL'
        });

        await processLivePartnerBookingJob({
            id: 'job-booking-refund-settle',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });

        // Trigger cancellation
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('refund-cancel-'),
            body: { reason: 'Duplicate refund test.' }
        }).expect(202);

        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        jest.spyOn(carrierBookingService, 'cancelByShipment').mockResolvedValue({
            status: 'CANCELLED',
            carrier: 'TPL',
            carrierCancellationReference: 'CX-REFUND-UNIQ'
        });

        // Run refund logic concurrently
        const [r1, r2] = await Promise.all([
            processLivePartnerCancellationJob({
                id: 'refund-job-1',
                data: { cancellationId: cancellation._id },
                attemptsMade: 0
            }),
            processLivePartnerCancellationJob({
                id: 'refund-job-2',
                data: { cancellationId: cancellation._id },
                attemptsMade: 0
            })
        ]);

        expect(r1.status).toBe('CANCELLED');
        expect(r2.status).toBe('CANCELLED');

        // Check wallet and Transactions
        const txns = await Transaction.find({ partnerApiFinancialReference: `PARTNER_API_BOOKING_REFUND:${fixture.account._id}:${bookingId}` }).lean();
        expect(txns).toHaveLength(1);
        const reservation = await WalletReservation.findOne({ bookingId }).lean();
        expect(txns[0].amount).toBe(reservation.amount);

        const finalWallet = await User.findById(fixture.user._id).lean();
        expect(finalWallet.walletBalance).toBe(10000);
    });

    test('Reservation release claiming and validation prevents concurrent release races', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('release-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });

        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('release-cancel-'),
            body: { reason: 'Release concurrency test.' }
        }).expect(202);

        const cancellation = await PartnerApiCancellation.findOne({ bookingId });

        // Concurrent release attempts
        const [r1, r2] = await Promise.all([
            processLivePartnerCancellationJob({
                id: 'release-job-1',
                data: { cancellationId: cancellation._id },
                attemptsMade: 0
            }),
            processLivePartnerCancellationJob({
                id: 'release-job-2',
                data: { cancellationId: cancellation._id },
                attemptsMade: 0
            })
        ]);

        expect(['CANCELLED_PRE_CARRIER', 'ALREADY_FINAL']).toContain(r1.status);
        expect(['CANCELLED_PRE_CARRIER', 'ALREADY_FINAL']).toContain(r2.status);

        const reservation = await WalletReservation.findOne({ bookingId }).lean();
        expect(reservation.status).toBe(WALLET_RESERVATION_STATUSES.RELEASED);
        expect(reservation.unusedReleasedAmount).toBe(reservation.amount);

        const finalWallet = await User.findById(fixture.user._id).lean();
        expect(finalWallet.walletBalance).toBe(10000);
    });

    test('Integrity verifier detects inconsistencies accurately', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('integrity-cancel-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;

        // Force inconsistency: status Cancelled but active reservation exists
        await Shipment.updateOne(
            { partnerApiBookingId: bookingId },
            {
                $set: {
                    status: 'Cancelled',
                    processingStatus: PARTNER_API_PROCESSING_STATUSES.CANCELLED,
                    cancellationStatus: PARTNER_API_CANCELLATION_STATUSES.CANCELLED
                }
            }
        );

        const beforeReservation = await WalletReservation.findOne({ bookingId }).lean();
        const result = await runLivePartnerIntegrityCheck();
        const afterReservation = await WalletReservation.findOne({ bookingId }).lean();

        expect(result.findings.some(item => item.code === 'CANCELLED_WITH_ACTIVE_RESERVATION')).toBe(true);
        expect(afterReservation.status).toBe(beforeReservation.status); // Unmutated
    });
});
