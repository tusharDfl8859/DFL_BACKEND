process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.PARTNER_API_KEY_PEPPER = 'developer-portal-step-6a-test-pepper';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';
process.env.SPEEDBOX_API_URL = '';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const mongoose = require('mongoose');
const request = require('supertest');
const axios = require('axios');

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
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const CarrierConcurrencyLease = require('../../models/CarrierConcurrencyLease');
const RateZone = require('../../models/RateZone');
const RateTable = require('../../models/RateTable');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    CREDENTIAL_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_OUTBOX_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    SLA_TIERS,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { generateApiKey } = require('../../utils/developerCredentialCrypto');
const rateCalculator = require('../../utils/rateCalculator');
const {
    canonicalStringify,
    fingerprintPayload
} = require('../../services/openapi/liveBookingValidationService');
const livePartnerBookingQueue = require('../../queues/livePartnerBookingQueue');
const carrierReconciliationQueue = require('../../queues/carrierReconciliationQueue');
const walletReconciliationQueue = require('../../queues/walletReconciliationQueue');
const {
    publishOutboxEvent,
    publishPendingOutboxEvents
} = require('../../services/openapi/livePartnerBookingOutboxService');
const {
    recoverAdmissionByIdempotencyId
} = require('../../services/openapi/livePartnerBookingRecoveryService');
const {
    requestManualRecovery
} = require('../../services/openapi/livePartnerManualRecoveryService');
const {
    runLivePartnerIntegrityCheck
} = require('../../services/openapi/livePartnerIntegrityService');
const carrierBookingService = require('../../services/carriers/CarrierBookingService');
const serviceConfig = require('../../config/service_config.json');
const {
    processLivePartnerBookingJob
} = require('../../workers/livePartnerBookingWorker');
const {
    processLivePartnerCancellationJob
} = require('../../workers/livePartnerCancellationWorker');
const {
    processCancellationReconciliationJob
} = require('../../workers/cancellationReconciliationWorker');
const {
    processRefundReconciliationJob
} = require('../../workers/refundReconciliationWorker');
const {
    processCarrierReconciliationJob
} = require('../../workers/carrierReconciliationWorker');
const {
    processWalletReconciliationJob
} = require('../../workers/walletReconciliationWorker');
const {
    acquireCarrierPermit,
    releaseCarrierPermit,
    renewCarrierPermit
} = require('../../services/openapi/liveCarrierConcurrencyService');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Live Admission Customer',
    email: overrides.email || `${nextUnique('live-admission')}@example.com`,
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

const bookingPayload = (overrides = {}) => ({
    recipient: {
        name: 'Live Customer',
        phone: '9876543210',
        email: 'customer@example.com',
        addressLine1: 'Production Address',
        city: 'New York',
        state: 'NY',
        postalCode: '10001',
        countryCode: 'US',
        ...(overrides.recipient || {})
    },
    package: {
        weightKg: 1.5,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        declaredValue: 1000,
        currency: 'INR',
        description: 'Live test product',
        ...(overrides.package || {})
    },
    order: {
        orderId: nextUnique('LIVE-ORDER-'),
        invoiceNumber: nextUnique('LIVE-INV-'),
        ...(overrides.order || {})
    },
    ...(overrides.customs === null ? {} : {
        customs: {
            hsnCode: '6109',
            itemDescription: 'Cotton T-shirt',
            quantity: 1,
            unitValue: 1000,
            countryOfOrigin: 'IN',
            csbType: 'CSB4',
            ...(overrides.customs || {})
        }
    }),
    ...(overrides.service === null ? {} : {
        service: {
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            ...(overrides.service || {})
        }
    }),
    ...(overrides.shipper ? { shipper: overrides.shipper } : {})
});

const postPartnerBooking = ({ apiKey, partnerRequestId, payload = bookingPayload(), scenario }) => {
    const http = request(app)
        .post('/api/v1/partner/bookings')
        .set('x-api-key', apiKey)
        .set('x-partner-request-id', partnerRequestId);
    if (scenario) {
        http.set('x-sandbox-scenario', scenario);
    }
    return http.send(payload);
};

const cancelPartnerBooking = ({ apiKey, bookingId, partnerRequestId, body = { reason: 'Customer requested cancellation.' } }) => request(app)
    .post(`/api/v1/partner/bookings/${bookingId}/cancel`)
    .set('x-api-key', apiKey)
    .set('x-partner-request-id', partnerRequestId)
    .send(body);

const waitForApiLog = async (query) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const log = await ApiRequestLog.findOne(query);
        if (log) return log;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
};

const expectNoAdmissionSideEffects = async () => {
    await expect(Shipment.countDocuments()).resolves.toBe(0);
    await expect(WalletReservation.countDocuments()).resolves.toBe(0);
    await expect(PartnerApiIdempotency.countDocuments()).resolves.toBe(0);
    await expect(PartnerApiOutboxEvent.countDocuments()).resolves.toBe(0);
};

describe('Partner API backend Step 6A Live booking admission', () => {
    beforeAll(async () => {
        await Promise.all([
            User.init(),
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            ApiRequestLog.init(),
            DeveloperAuditLog.init(),
            DeveloperConfig.init(),
            SandboxBooking.init(),
            Shipment.init(),
            Transaction.init(),
            PartnerApiIdempotency.init(),
            PartnerApiCancellation.init(),
            WalletReservation.init(),
            PartnerApiOutboxEvent.init(),
            CarrierConcurrencyLease.init(),
            RateZone.init(),
            RateTable.init()
        ]);
    });

    beforeEach(async () => {
        await seedAuthoritativeRates();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('valid Live booking reserves wallet funds, creates pending shipment, idempotency record, and outbox event only', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-create-');
        const walletBefore = await User.findById(fixture.user._id).lean();

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId
        }).expect(202);

        expect(response.headers['x-ratelimit-limit']).toBeTruthy();
        expect(response.body).toMatchObject({
            success: true,
            message: 'Booking request accepted for processing.',
            data: {
                partnerRequestId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                status: 'PROCESSING'
            }
        });
        expect(response.body.data.bookingId).toMatch(/^BKG_/);

        const [walletAfter, shipment, reservation, idempotency, outboxEvent] = await Promise.all([
            User.findById(fixture.user._id).lean(),
            Shipment.findOne({ partnerApiBookingId: response.body.data.bookingId }).lean(),
            WalletReservation.findOne({ partnerRequestId }).lean(),
            PartnerApiIdempotency.findOne({ partnerRequestId }).lean(),
            PartnerApiOutboxEvent.findOne({ partnerRequestId }).lean()
        ]);

        expect(shipment).toMatchObject({
            user: fixture.user._id,
            bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            processingStatus: PARTNER_API_PROCESSING_STATUSES.PROCESSING,
            developerAccountId: fixture.account._id,
            credentialId: fixture.credential._id,
            partnerRequestId,
            status: 'Pending',
            carrierBookingStatus: 'PENDING',
            trackingId: ''
        });
        expect(shipment.serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: '1',
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json'
        });
        expect(shipment.pricingSnapshot).toMatchObject({
            serviceType: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            internalServiceCode: 'TUS1',
            serviceConfigId: 'TPL:DFLS100',
            serviceConfigVersion: 'service_config.json'
        });
        expect(shipment.carrierMerchantReference).toBeNull();
        expect(reservation).toMatchObject({
            userId: fixture.user._id,
            developerAccountId: fixture.account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            bookingId: response.body.data.bookingId,
            partnerRequestId,
            status: WALLET_RESERVATION_STATUSES.ACTIVE,
            currency: 'INR'
        });
        expect(idempotency).toMatchObject({
            developerAccountId: fixture.account._id,
            credentialId: fixture.credential._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId,
            status: PARTNER_API_IDEMPOTENCY_STATUSES.PROCESSING,
            bookingId: response.body.data.bookingId,
            responseStatus: 202
        });
        expect(outboxEvent).toMatchObject({
            developerAccountId: fixture.account._id,
            credentialId: fixture.credential._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId,
            status: PARTNER_API_OUTBOX_STATUSES.PUBLISHED,
            queueJobId: `live-partner-booking-${outboxEvent.outboxEventId}`
        });

        expect(walletAfter.walletBalance).toBeCloseTo(walletBefore.walletBalance - reservation.amount);
        expect(walletAfter.walletReservedBalance).toBeCloseTo((walletBefore.walletReservedBalance || 0) + reservation.amount);
        await expect(Transaction.countDocuments()).resolves.toBe(0);
        await expect(SandboxBooking.countDocuments()).resolves.toBe(0);

        const audits = await DeveloperAuditLog.find({
            developerAccountId: fixture.account._id
        });
        expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining([
            DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_VALIDATED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_IDEMPOTENCY_CLAIMED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_FUNDS_RESERVED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_PENDING_SHIPMENT_CREATED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_OUTBOX_CREATED,
            DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_JOB_PUBLISHED
        ]));

        const apiLog = await waitForApiLog({ partnerRequestId });
        expect(apiLog).toMatchObject({
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            endpoint: '/api/v1/partner/bookings',
            statusCode: 202,
            errorCode: null
        });
        expect(JSON.stringify(apiLog.toJSON())).not.toContain(fixture.apiKey);
    });

    test('same Live partner request id and same canonical payload replays without duplicate reservation or shipment', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-replay-');
        const payload = bookingPayload();

        const first = await postPartnerBooking({ apiKey: fixture.apiKey, partnerRequestId, payload }).expect(202);
        const second = await postPartnerBooking({ apiKey: fixture.apiKey, partnerRequestId, payload }).expect(202);

        expect(second.body.data.bookingId).toBe(first.body.data.bookingId);
        await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiIdempotency.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiOutboxEvent.countDocuments({ partnerRequestId })).resolves.toBe(1);

        const reservation = await WalletReservation.findOne({ partnerRequestId }).lean();
        const wallet = await User.findById(fixture.user._id).lean();
        expect(wallet.walletBalance).toBeCloseTo(25000 - reservation.amount);
        expect(wallet.walletReservedBalance).toBeCloseTo(reservation.amount);
    });

    test('concurrent duplicate Live requests create one reservation, shipment, outbox event, and deterministic job', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-concurrent-');
        const payload = bookingPayload();

        const responses = await Promise.all(
            Array.from({ length: 5 }, () => postPartnerBooking({ apiKey: fixture.apiKey, partnerRequestId, payload }))
        );

        expect(responses.every((response) => response.status === 202)).toBe(true);
        const bookingIds = [...new Set(responses.map((response) => response.body.data.bookingId))];
        expect(bookingIds).toHaveLength(1);
        await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiIdempotency.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiOutboxEvent.countDocuments({ partnerRequestId })).resolves.toBe(1);

        const outboxEvent = await PartnerApiOutboxEvent.findOne({ partnerRequestId }).lean();
        expect(outboxEvent.queueJobId).toBe(`live-partner-booking-${outboxEvent.outboxEventId}`);
    });

    test('same Live partner request id with a different payload is rejected as an idempotency conflict', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-conflict-');

        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const conflict = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({ package: { declaredValue: 1500 } })
        }).expect(409);

        expect(conflict.body.error_code).toBe('IDEMPOTENCY_CONFLICT');
        await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiOutboxEvent.countDocuments({ partnerRequestId })).resolves.toBe(1);
    });

    test('same Live partner request id with a changed service pair is rejected as an idempotency conflict', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-service-conflict-');

        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const conflict = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({
                service: {
                    serviceName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFLS102'
                }
            })
        }).expect(409);

        expect(conflict.body.error_code).toBe('IDEMPOTENCY_CONFLICT');
        await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(PartnerApiOutboxEvent.countDocuments({ partnerRequestId })).resolves.toBe(1);
    });

    test('pricing fails closed when no authoritative production rate is available', async () => {
        await Promise.all([
            RateZone.deleteMany({}),
            RateTable.deleteMany({})
        ]);
        resetRateCalculator();
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-no-rate-');
        const queueSpy = jest.spyOn(livePartnerBookingQueue, 'add');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(503);

        expect(response.body.error_code).toBe('PRICING_UNAVAILABLE');
        expect(queueSpy).not.toHaveBeenCalled();
        await expectNoAdmissionSideEffects();
    });

    test('Live booking requires public DFL service object, service name, and service code', async () => {
        const fixture = await createDeveloperFixture();

        const missingService = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-service-required-'),
            payload: bookingPayload({ service: null })
        }).expect(400);
        expect(missingService.body.error_code).toBe('INVALID_INPUT');
        expect(missingService.body.details).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'service.serviceName' }),
            expect.objectContaining({ field: 'service.serviceCode' })
        ]));

        const missingName = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-service-name-required-'),
            payload: bookingPayload({ service: { serviceName: undefined } })
        }).expect(400);
        expect(missingName.body.error_code).toBe('INVALID_INPUT');
        expect(missingName.body.details).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'service.serviceName' })
        ]));

        const missingCode = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-service-code-required-'),
            payload: bookingPayload({ service: { serviceCode: undefined } })
        }).expect(400);
        expect(missingCode.body.error_code).toBe('INVALID_INPUT');
        expect(missingCode.body.details).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'service.serviceCode' })
        ]));

        await expectNoAdmissionSideEffects();
    });

    test('Live booking rejects public internal carrier routing fields', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-internal-fields-');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({
                service: {
                    provider: 'TPL',
                    carrier: 'TPL',
                    carrierName: 'TPL',
                    carrierCode: 1,
                    carrierAccount: 'internal-account',
                    code: 'TUS1',
                    zone: 'TUS1'
                }
            })
        }).expect(400);

        expect(response.body.error_code).toBe('INVALID_INPUT');
        expect(response.body.details).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'service.provider' }),
            expect.objectContaining({ field: 'service.carrier' }),
            expect.objectContaining({ field: 'service.carrierName' }),
            expect.objectContaining({ field: 'service.carrierCode' }),
            expect.objectContaining({ field: 'service.carrierAccount' }),
            expect.objectContaining({ field: 'service.code' }),
            expect.objectContaining({ field: 'service.zone' })
        ]));
        await expectNoAdmissionSideEffects();
    });

    test('Live booking rejects unknown service pairs before side effects', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-unknown-service-');
        const queueSpy = jest.spyOn(livePartnerBookingQueue, 'add');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({
                service: {
                    serviceName: 'DFL EXPRESS - Not Real',
                    serviceCode: 'DFLX999'
                }
            })
        }).expect(422);

        expect(response.body.error_code).toBe('SERVICE_NOT_AVAILABLE');
        expect(queueSpy).not.toHaveBeenCalled();
        await expectNoAdmissionSideEffects();
    });

    test('Live booking rejects mismatched valid service name and code pairs before side effects', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-invalid-service-');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({
                service: {
                    serviceName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFLS134'
                }
            })
        }).expect(422);

        expect(response.body.error_code).toBe('SERVICE_NOT_AVAILABLE');
        await expectNoAdmissionSideEffects();
    });

    test('Live booking rejects disabled services and unsupported internal carriers before side effects', async () => {
        const fixture = await createDeveloperFixture();
        const tplService = serviceConfig.TPL.services.find((service) => service.serviceCode === 'DFLS100');
        const previousLiveApiEnabled = tplService.liveApiEnabled;
        const queueSpy = jest.spyOn(livePartnerBookingQueue, 'add');

        try {
            tplService.liveApiEnabled = false;
            const disabled = await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId: nextUnique('live-disabled-service-'),
                payload: bookingPayload()
            }).expect(422);
            expect(disabled.body.error_code).toBe('SERVICE_NOT_AVAILABLE');
            expect(queueSpy).not.toHaveBeenCalled();
            await expectNoAdmissionSideEffects();
        } finally {
            if (previousLiveApiEnabled === undefined) {
                delete tplService.liveApiEnabled;
            } else {
                tplService.liveApiEnabled = previousLiveApiEnabled;
            }
        }

        const supportsSpy = jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(false);
        const unsupported = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-unsupported-carrier-'),
            payload: bookingPayload()
        }).expect(422);

        expect(unsupported.body.error_code).toBe('SERVICE_NOT_AVAILABLE');
        expect(supportsSpy).toHaveBeenCalledWith('TPL');
        expect(queueSpy).not.toHaveBeenCalled();
        await expectNoAdmissionSideEffects();
    });

    test('Live booking does not select a cheaper wrong-service rate when exact service is unavailable', async () => {
        await Promise.all([
            RateZone.deleteMany({}),
            RateTable.deleteMany({})
        ]);
        resetRateCalculator();
        await Promise.all([
            RateZone.create({ country: 'US', state: 'NY', zone: 'TUS2' }),
            RateTable.create({
                weight: 2,
                rates: {
                    TUS1: 1
                }
            })
        ]);
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-no-fallback-');
        const queueSpy = jest.spyOn(livePartnerBookingQueue, 'add');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({
                service: {
                    serviceName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFLS102'
                }
            })
        }).expect(503);

        expect(response.body.error_code).toBe('PRICING_UNAVAILABLE');
        expect(queueSpy).not.toHaveBeenCalled();
        await expectNoAdmissionSideEffects();
    });

    test('insufficient wallet balance fails before reservation, shipment, outbox, transaction, or sandbox side effects', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10 } });
        const partnerRequestId = nextUnique('live-low-wallet-');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(402);

        expect(response.body.error_code).toBe('INSUFFICIENT_WALLET_BALANCE');
        const wallet = await User.findById(fixture.user._id).lean();
        expect(wallet.walletBalance).toBe(10);
        expect(wallet.walletReservedBalance).toBe(0);
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
        await expect(PartnerApiIdempotency.countDocuments()).resolves.toBe(0);
        await expect(PartnerApiOutboxEvent.countDocuments()).resolves.toBe(0);
        await expect(Transaction.countDocuments()).resolves.toBe(0);
        await expect(SandboxBooking.countDocuments()).resolves.toBe(0);
    });

    test('Redis publication failure leaves a retryable outbox event and publisher recovery republishes it', async () => {
        const originalAdd = livePartnerBookingQueue.add;
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-redis-retry-');
        let addCalls = 0;
        livePartnerBookingQueue.add = jest.fn(async () => {
            addCalls += 1;
            if (addCalls === 1) {
                throw new Error('Redis unavailable in test');
            }
            return { id: 'mock-recovered-job' };
        });

        try {
            const response = await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId,
                payload: bookingPayload()
            }).expect(202);

            const failedOutbox = await PartnerApiOutboxEvent.findOne({ partnerRequestId });
            expect(failedOutbox).toMatchObject({
                bookingId: response.body.data.bookingId,
                status: PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE,
                lastErrorCode: 'QUEUE_UNAVAILABLE'
            });

            failedOutbox.availableAt = new Date(Date.now() - 1000);
            await failedOutbox.save();

            const recovered = await publishPendingOutboxEvents();
            expect(recovered).toHaveLength(1);
            expect(recovered[0].toObject()).toMatchObject({
                status: PARTNER_API_OUTBOX_STATUSES.PUBLISHED,
                queueJobId: `live-partner-booking-${failedOutbox.outboxEventId}`
            });
            expect(livePartnerBookingQueue.add).toHaveBeenCalledTimes(2);
        } finally {
            livePartnerBookingQueue.add = originalAdd;
        }
    });

    test('stale outbox processing lock is reclaimed after the configured lease timeout', async () => {
        const originalAdd = livePartnerBookingQueue.add;
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-stale-lock-');
        await DeveloperConfig.findOneAndUpdate(
            { configKey: 'DEVELOPER_PORTAL' },
            { liveOutboxLockTimeoutSeconds: 30 },
            { upsert: true }
        );

        const created = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);
        const outboxEvent = await PartnerApiOutboxEvent.findOne({ partnerRequestId });
        await PartnerApiOutboxEvent.updateOne(
            { _id: outboxEvent._id },
            {
                status: PARTNER_API_OUTBOX_STATUSES.PROCESSING,
                lockedAt: new Date(Date.now() - 60000),
                lockedBy: 'crashed-publisher',
                queueJobId: null,
                publishedAt: null
            }
        );
        livePartnerBookingQueue.add = jest.fn(async () => ({ id: 'mock-stale-recovered-job' }));

        try {
            const recovered = await publishPendingOutboxEvents();
            expect(recovered).toHaveLength(1);
            expect(recovered[0].toObject()).toMatchObject({
                bookingId: created.body.data.bookingId,
                status: PARTNER_API_OUTBOX_STATUSES.PUBLISHED,
                lockedAt: null,
                lockedBy: null,
                queueJobId: `live-partner-booking-${outboxEvent.outboxEventId}`
            });
            expect(livePartnerBookingQueue.add).toHaveBeenCalledTimes(1);
        } finally {
            livePartnerBookingQueue.add = originalAdd;
        }
    });

    test('queue backpressure rejects before wallet reservation and shipment creation', async () => {
        const fixture = await createDeveloperFixture();
        await DeveloperConfig.findOneAndUpdate(
            { configKey: 'DEVELOPER_PORTAL' },
            { liveOutboxMaxPending: 1 },
            { upsert: true }
        );
        await PartnerApiOutboxEvent.create({
            eventType: 'LIVE_PARTNER_BOOKING_REQUESTED',
            aggregateType: 'SHIPMENT',
            aggregateId: new mongoose.Types.ObjectId(),
            bookingId: 'BKG_BACKPRESSURE',
            shipmentId: new mongoose.Types.ObjectId(),
            developerAccountId: fixture.account._id,
            credentialId: fixture.credential._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId: nextUnique('existing-pending-'),
            walletReservationId: new mongoose.Types.ObjectId(),
            idempotencyRecordId: new mongoose.Types.ObjectId(),
            status: PARTNER_API_OUTBOX_STATUSES.PENDING,
            availableAt: new Date()
        });

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-backpressure-'),
            payload: bookingPayload()
        }).expect(503);

        expect(response.body.error_code).toBe('QUEUE_BACKPRESSURE');
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(PartnerApiIdempotency.countDocuments()).resolves.toBe(0);
    });

    test('orphan recovery releases reservation only when queue and carrier processing definitively never began', async () => {
        const originalAdd = livePartnerBookingQueue.add;
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-orphan-release-');
        livePartnerBookingQueue.add = jest.fn(async () => {
            throw new Error('Queue unavailable before worker start');
        });

        try {
            await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId,
                payload: bookingPayload()
            }).expect(202);
        } finally {
            livePartnerBookingQueue.add = originalAdd;
        }

        const [idempotency, reservation, outboxEvent] = await Promise.all([
            PartnerApiIdempotency.findOne({ partnerRequestId }),
            WalletReservation.findOne({ partnerRequestId }),
            PartnerApiOutboxEvent.findOne({ partnerRequestId })
        ]);
        const walletAfterReservation = await User.findById(fixture.user._id).lean();

        await PartnerApiOutboxEvent.updateOne(
            { _id: outboxEvent._id },
            {
                status: PARTNER_API_OUTBOX_STATUSES.FAILED_FINAL,
                queueJobId: null,
                publishedAt: null,
                lockedAt: null,
                lockedBy: null,
                lastErrorCode: 'QUEUE_UNAVAILABLE'
            }
        );

        const recovered = await recoverAdmissionByIdempotencyId(idempotency._id);
        expect(recovered).toMatchObject({
            recovered: true,
            released: true,
            reason: 'RESERVATION_RELEASED',
            walletReservationId: reservation.walletReservationId
        });

        const [walletAfterRelease, releasedReservation, finalIdempotency, shipment] = await Promise.all([
            User.findById(fixture.user._id).lean(),
            WalletReservation.findById(reservation._id).lean(),
            PartnerApiIdempotency.findById(idempotency._id).lean(),
            Shipment.findOne({ partnerRequestId }).lean()
        ]);
        expect(walletAfterRelease.walletBalance).toBeCloseTo(walletAfterReservation.walletBalance + reservation.amount);
        expect(walletAfterRelease.walletReservedBalance).toBeCloseTo(walletAfterReservation.walletReservedBalance - reservation.amount);
        expect(releasedReservation.status).toBe(WALLET_RESERVATION_STATUSES.RELEASED);
        expect(finalIdempotency.status).toBe(PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL);
        expect(shipment).toMatchObject({
            processingStatus: PARTNER_API_PROCESSING_STATUSES.FAILED_FINAL,
            carrierBookingStatus: 'FAILED',
            status: 'Pending'
        });
    });

    test('dashboard-style atomic wallet debit racing Live API reservation allows only one spender', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 150 } });
        const partnerRequestId = nextUnique('live-dashboard-race-');

        const dashboardDebit = User.findOneAndUpdate(
            {
                _id: fixture.user._id,
                walletBalance: { $gte: 100 }
            },
            { $inc: { walletBalance: -100 } },
            { new: true }
        );
        const liveAdmission = postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        });

        const [dashboardResult, liveResult] = await Promise.all([dashboardDebit, liveAdmission]);
        const dashboardSucceeded = Boolean(dashboardResult);
        const liveSucceeded = liveResult.status === 202;

        expect(Number(dashboardSucceeded) + Number(liveSucceeded)).toBe(1);
        expect([202, 402]).toContain(liveResult.status);

        const wallet = await User.findById(fixture.user._id).lean();
        expect(wallet.walletBalance).toBeGreaterThanOrEqual(0);

        if (liveSucceeded) {
            await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(1);
            await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(1);
        } else {
            expect(liveResult.body.error_code).toBe('INSUFFICIENT_WALLET_BALANCE');
            await expect(WalletReservation.countDocuments({ partnerRequestId })).resolves.toBe(0);
            await expect(Shipment.countDocuments({ partnerRequestId })).resolves.toBe(0);
        }
        await expect(Transaction.countDocuments()).resolves.toBe(0);
    });

    test('non-active Live developer account is rejected before admission side effects', async () => {
        const fixture = await createDeveloperFixture();
        await DeveloperAccount.updateOne(
            { _id: fixture.account._id },
            { accountStatus: DEVELOPER_ACCOUNT_STATUSES.SUSPENDED, suspendedAt: new Date(), suspensionReason: 'Compliance hold' }
        );

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-suspended-'),
            payload: bookingPayload()
        }).expect(403);

        expect(response.body.error_code).toBe('ACCOUNT_SUSPENDED');
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
        await expect(PartnerApiOutboxEvent.countDocuments()).resolves.toBe(0);
    });

    test('production rate limiting rejects before wallet reservation and pending shipment creation', async () => {
        const previousLimit = process.env.PARTNER_LIVE_RATE_LIMIT_PER_MINUTE;
        process.env.PARTNER_LIVE_RATE_LIMIT_PER_MINUTE = '1';
        const fixture = await createDeveloperFixture();

        try {
            await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId: nextUnique('live-rate-ok-'),
                payload: bookingPayload()
            }).expect(202);

            const limited = await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId: nextUnique('live-rate-limited-'),
                payload: bookingPayload()
            }).expect(429);
            expect(limited.body.error_code).toBe('RATE_LIMIT_EXCEEDED');
            expect(limited.headers['retry-after']).toBeTruthy();
            await expect(WalletReservation.countDocuments()).resolves.toBe(1);
            await expect(Shipment.countDocuments()).resolves.toBe(1);
        } finally {
            if (previousLimit === undefined) {
                delete process.env.PARTNER_LIVE_RATE_LIMIT_PER_MINUTE;
            } else {
                process.env.PARTNER_LIVE_RATE_LIMIT_PER_MINUTE = previousLimit;
            }
        }
    });

    test('Live booking lookup is scoped to the authenticated developer account', async () => {
        const owner = await createDeveloperFixture();
        const other = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-scope-');

        const created = await postPartnerBooking({
            apiKey: owner.apiKey,
            partnerRequestId
        }).expect(202);

        const allowed = await request(app)
            .get(`/api/v1/partner/bookings/${created.body.data.bookingId}`)
            .set('x-api-key', owner.apiKey)
            .expect(200);
        expect(allowed.body.data).toMatchObject({
            bookingId: created.body.data.bookingId,
            partnerRequestId,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            status: PARTNER_API_PROCESSING_STATUSES.PROCESSING
        });

        const denied = await request(app)
            .get(`/api/v1/partner/bookings/${created.body.data.bookingId}`)
            .set('x-api-key', other.apiKey)
            .expect(404);
        expect(denied.body.error_code).toBe('BOOKING_NOT_FOUND');
    });

    test('Live validator rejects customer-supplied price/status/wallet identifiers and unsafe object keys', async () => {
        const fixture = await createDeveloperFixture();
        const unsupported = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-unsupported-'),
            payload: {
                ...bookingPayload(),
                price: 1,
                walletReservationId: 'external-reservation',
                status: 'Delivered'
            }
        }).expect(400);
        expect(unsupported.body.error_code).toBe('INVALID_INPUT');
        expect(unsupported.body.details.map((detail) => detail.field)).toEqual(expect.arrayContaining([
            'price',
            'walletReservationId',
            'status'
        ]));

        const mongoOperator = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-operator-'),
            payload: {
                ...bookingPayload(),
                recipient: {
                    ...bookingPayload().recipient,
                    $where: 'this.walletBalance > 0'
                }
            }
        }).expect(400);
        expect(mongoOperator.body.error_code).toBe('INVALID_INPUT');
        expect(mongoOperator.body.details.map((detail) => detail.field)).toContain('recipient.$where');
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
    });

    test('Live validator rejects invalid weight, invalid phone, and missing international customs fields', async () => {
        const fixture = await createDeveloperFixture();

        const invalidWeight = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-invalid-weight-'),
            payload: bookingPayload({ package: { weightKg: 0 } })
        }).expect(400);
        expect(invalidWeight.body.error_code).toBe('INVALID_INPUT');
        expect(invalidWeight.body.details.map((detail) => detail.field)).toContain('package.weightKg');

        const invalidPhone = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-invalid-phone-'),
            payload: bookingPayload({ recipient: { phone: 'abc' } })
        }).expect(400);
        expect(invalidPhone.body.details.map((detail) => detail.field)).toContain('recipient.phone');

        const missingCustoms = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-missing-customs-'),
            payload: bookingPayload({ customs: null })
        }).expect(400);
        expect(missingCustoms.body.details.map((detail) => detail.field)).toEqual(expect.arrayContaining([
            'customs.hsnCode',
            'customs.itemDescription',
            'customs.quantity',
            'customs.unitValue',
            'customs.countryOfOrigin',
            'customs.csbType'
        ]));
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
    });

    test('Sandbox credential still creates only sandbox simulated records on the shared Partner API route', async () => {
        const fixture = await createDeveloperFixture({
            accessLevel: ACCESS_LEVELS.SANDBOX,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX
        });
        const partnerRequestId = nextUnique('sandbox-route-');

        const response = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload({ service: null }),
            scenario: 'success'
        }).expect(201);

        expect(response.body.data.environment).toBe(DEVELOPER_ENVIRONMENTS.SANDBOX);
        await expect(SandboxBooking.countDocuments({ partnerRequestId })).resolves.toBe(1);
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
        await expect(PartnerApiOutboxEvent.countDocuments()).resolves.toBe(0);
    });

    test('payload fingerprinting is stable for canonical key ordering', () => {
        const first = {
            recipient: { name: 'A', countryCode: 'IN' },
            package: { weightKg: 1 },
            partnerRequestId: 'REQ-100'
        };
        const second = {
            partnerRequestId: 'REQ-100',
            package: { weightKg: 1 },
            recipient: { countryCode: 'IN', name: 'A' }
        };

        expect(canonicalStringify(first)).toBe(canonicalStringify(second));
        expect(fingerprintPayload(first)).toBe(fingerprintPayload(second));
    });

    test('Live pricing admission does not write debug_rates.log unless explicitly enabled', async () => {
        const debugPath = path.join(__dirname, '../../debug_rates.log');
        const beforeStat = fs.existsSync(debugPath) ? fs.statSync(debugPath).mtimeMs : null;
        const fixture = await createDeveloperFixture();

        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-debug-log-'),
            payload: bookingPayload()
        }).expect(202);

        const afterStat = fs.existsSync(debugPath) ? fs.statSync(debugPath).mtimeMs : null;
        expect(afterStat).toBe(beforeStat);
    });

    test('Step 6B worker books carrier once, settles reservation once, and exposes scoped tracking and label', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-worker-');
        const bookingResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const shipment = await Shipment.findOne({ partnerRequestId });
        const idempotency = await PartnerApiIdempotency.findOne({ partnerRequestId });
        const reservation = await WalletReservation.findOne({ partnerRequestId });

        const supportsSpy = jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);
        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: `AWB-${partnerRequestId}`,
            carrierRef: `CREF-${partnerRequestId}`,
            labelUrl: 'https://labels.example.test/short-lived.pdf',
            carrier: 'SKYNET'
        });

        const job = {
            id: `test-job-${partnerRequestId}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: idempotency._id,
                walletReservationId: reservation._id
            },
            attemptsMade: 0
        };

        await processLivePartnerBookingJob(job);
        await processLivePartnerBookingJob(job);

        const [updatedShipment, updatedReservation, updatedIdempotency, wallet] = await Promise.all([
            Shipment.findById(shipment._id).lean(),
            WalletReservation.findById(reservation._id).lean(),
            PartnerApiIdempotency.findById(idempotency._id).lean(),
            User.findById(fixture.user._id).lean()
        ]);

        expect(carrierSpy).toHaveBeenCalledTimes(1);
        expect(updatedShipment).toMatchObject({
            carrierBookingStatus: 'BOOKED',
            carrierBookingId: `CREF-${partnerRequestId}`,
            trackingId: `AWB-${partnerRequestId}`,
            labelStatus: 'LABEL_READY',
            walletSettlementStatus: 'SETTLED',
            processingStatus: PARTNER_API_PROCESSING_STATUSES.COMPLETED
        });
        expect(updatedShipment.carrierMerchantReference).toContain('DFL-');
        expect(updatedReservation).toMatchObject({
            status: WALLET_RESERVATION_STATUSES.SETTLED,
            settledAmount: reservation.amount
        });
        expect(updatedReservation.settlementTransactionId).toBeTruthy();
        expect(updatedIdempotency.status).toBe(PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED);
        expect(updatedIdempotency.responseStatus).toBe(200);
        await expect(Transaction.countDocuments({ referenceId: updatedReservation.settlementReference })).resolves.toBe(1);
        expect(wallet.walletBalance).toBeCloseTo(25000 - reservation.amount);
        expect(wallet.walletReservedBalance).toBeCloseTo(0);

        const trackingResponse = await request(app)
            .get(`/api/v1/partner/tracking/${updatedShipment.trackingId}`)
            .set('x-api-key', fixture.apiKey)
            .expect(200);
        expect(trackingResponse.body.data.bookingId).toBe(bookingResponse.body.data.bookingId);
        expect(JSON.stringify(trackingResponse.body)).not.toContain('secret');

        const labelResponse = await request(app)
            .get(`/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label`)
            .set('x-api-key', fixture.apiKey)
            .expect(200);
        expect(labelResponse.body.data.labelStatus).toBe('LABEL_READY');
        expect(labelResponse.body.data.downloadUrl).toBe(`/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label/download`);
        expect(JSON.stringify(labelResponse.body)).not.toContain('https://labels.example.test/short-lived.pdf');

        carrierSpy.mockRestore();
        supportsSpy.mockRestore();
    });

    test('Step 6B worker uses persisted Shipment routing snapshot when service config changes after admission', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-config-snapshot-');

        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const shipment = await Shipment.findOne({ partnerRequestId });
        const idempotency = await PartnerApiIdempotency.findOne({ partnerRequestId });
        const reservation = await WalletReservation.findOne({ partnerRequestId });

        expect(shipment.serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: '1',
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json'
        });

        const tplService = serviceConfig.TPL.services.find((service) => service.serviceCode === 'DFLS100');
        const originalCarrierCode = tplService.carrierCode;
        const originalCode = tplService.code;
        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: `AWB-${partnerRequestId}`,
            carrierRef: `CREF-${partnerRequestId}`,
            labelUrl: 'https://labels.example.test/config-snapshot.pdf',
            carrier: 'TPL'
        });

        try {
            tplService.carrierCode = 999;
            tplService.code = 'CHANGED-IN-CONFIG';
            await processLivePartnerBookingJob({
                id: `test-job-${partnerRequestId}`,
                data: {
                    shipmentId: shipment._id,
                    idempotencyRecordId: idempotency._id,
                    walletReservationId: reservation._id
                },
                attemptsMade: 0
            });
        } finally {
            tplService.carrierCode = originalCarrierCode;
            tplService.code = originalCode;
        }

        expect(carrierSpy).toHaveBeenCalledTimes(1);
        expect(carrierSpy.mock.calls[0][2]).toBe('TPL');

        const updatedShipment = await Shipment.findById(shipment._id).lean();
        expect(updatedShipment.serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: '1',
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json'
        });

        carrierSpy.mockRestore();
    });

    test('Step 6B label delivery uses authenticated stream and does not expose permanent carrier URLs', async () => {
        const fixture = await createDeveloperFixture();
        const otherFixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-label-');
        const bookingResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);
        const shipment = await Shipment.findOne({ partnerRequestId });

        shipment.carrierBookingStatus = 'BOOKED';
        shipment.carrierBookingId = 'carrier-label-ref';
        shipment.trackingId = 'carrier-label-awb';
        shipment.labelStatus = 'LABEL_READY';
        shipment.carrierLabelUrl = 'https://carrier.example.test/permanent-label.pdf';
        shipment.carrierLabel = Buffer.from('%PDF-1.4 test label').toString('base64');
        await shipment.save();

        const metadata = await request(app)
            .get(`/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label`)
            .set('x-api-key', fixture.apiKey)
            .expect(200);
        expect(metadata.body.data).toMatchObject({
            delivery: 'AUTHENTICATED_STREAM',
            downloadUrl: `/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label/download`
        });
        expect(JSON.stringify(metadata.body)).not.toContain('carrier.example.test');

        const download = await request(app)
            .get(`/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label/download`)
            .set('x-api-key', fixture.apiKey)
            .expect(200);
        expect(download.headers['cache-control']).toContain('no-store');

        await request(app)
            .get(`/api/v1/partner/bookings/${bookingResponse.body.data.bookingId}/label/download`)
            .set('x-api-key', otherFixture.apiKey)
            .expect(404);
    });

    test('Step 6B label streaming blocks SSRF, oversized content, invalid MIME, invalid signature, traversal, and Sandbox access', async () => {
        const originalAllowlist = process.env.PARTNER_API_LABEL_HOST_ALLOWLIST;
        const originalMaxBytes = process.env.PARTNER_API_LABEL_MAX_BYTES;
        process.env.PARTNER_API_LABEL_HOST_ALLOWLIST = '127.0.0.1,labels.allowed.test';
        process.env.PARTNER_API_LABEL_MAX_BYTES = '32';

        const fixture = await createDeveloperFixture();
        const sandboxFixture = await createDeveloperFixture({
            accessLevel: ACCESS_LEVELS.SANDBOX,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX
        });

        const createLabelReadyBooking = async (labelFields) => {
            const partnerRequestId = nextUnique('live-label-security-');
            const bookingResponse = await postPartnerBooking({
                apiKey: fixture.apiKey,
                partnerRequestId,
                payload: bookingPayload()
            }).expect(202);
            await Shipment.findOneAndUpdate(
                { partnerRequestId },
                {
                    $set: {
                        carrierBookingStatus: 'BOOKED',
                        carrierBookingId: `CREF-${partnerRequestId}`,
                        trackingId: `AWB-${partnerRequestId}`,
                        labelStatus: 'LABEL_READY',
                        ...labelFields
                    }
                }
            );
            return bookingResponse.body.data.bookingId;
        };

        const lookupSpy = jest.spyOn(dns, 'lookup');
        const axiosSpy = jest.spyOn(axios, 'get');

        try {
            lookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
            const ssrfBookingId = await createLabelReadyBooking({ carrierLabelUrl: 'http://127.0.0.1/private.pdf' });
            await request(app)
                .get(`/api/v1/partner/bookings/${ssrfBookingId}/label/download`)
                .set('x-api-key', fixture.apiKey)
                .expect(409);
            expect(axiosSpy).not.toHaveBeenCalled();

            lookupSpy.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
            axiosSpy.mockResolvedValueOnce({
                status: 200,
                headers: {
                    'content-type': 'application/pdf',
                    'content-length': '33'
                },
                data: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(40)])
            });
            const oversizedBookingId = await createLabelReadyBooking({ carrierLabelUrl: 'https://labels.allowed.test/oversized.pdf' });
            await request(app)
                .get(`/api/v1/partner/bookings/${oversizedBookingId}/label/download`)
                .set('x-api-key', fixture.apiKey)
                .expect(409);

            axiosSpy.mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'text/html' },
                data: Buffer.from('%PDF-1.4')
            });
            const invalidMimeBookingId = await createLabelReadyBooking({ carrierLabelUrl: 'https://labels.allowed.test/html.pdf' });
            await request(app)
                .get(`/api/v1/partner/bookings/${invalidMimeBookingId}/label/download`)
                .set('x-api-key', fixture.apiKey)
                .expect(409);

            axiosSpy.mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'application/pdf' },
                data: Buffer.from('not-a-pdf')
            });
            const invalidSignatureBookingId = await createLabelReadyBooking({ carrierLabelUrl: 'https://labels.allowed.test/not-pdf.pdf' });
            await request(app)
                .get(`/api/v1/partner/bookings/${invalidSignatureBookingId}/label/download`)
                .set('x-api-key', fixture.apiKey)
                .expect(409);

            const traversalBookingId = await createLabelReadyBooking({ lastMileSticker: '/../secret.pdf' });
            await request(app)
                .get(`/api/v1/partner/bookings/${traversalBookingId}/label/download`)
                .set('x-api-key', fixture.apiKey)
                .expect(409);

            const sandboxBooking = await postPartnerBooking({
                apiKey: sandboxFixture.apiKey,
                partnerRequestId: nextUnique('sandbox-label-download-'),
                payload: bookingPayload({ service: null }),
                scenario: 'success'
            }).expect(201);
            await request(app)
                .get(`/api/v1/partner/bookings/${sandboxBooking.body.data.bookingId}/label/download`)
                .set('x-api-key', sandboxFixture.apiKey)
                .expect(501);
        } finally {
            lookupSpy.mockRestore();
            axiosSpy.mockRestore();
            if (originalAllowlist === undefined) {
                delete process.env.PARTNER_API_LABEL_HOST_ALLOWLIST;
            } else {
                process.env.PARTNER_API_LABEL_HOST_ALLOWLIST = originalAllowlist;
            }
            if (originalMaxBytes === undefined) {
                delete process.env.PARTNER_API_LABEL_MAX_BYTES;
            } else {
                process.env.PARTNER_API_LABEL_MAX_BYTES = originalMaxBytes;
            }
        }
    });

    test('Step 6B carrier concurrency lease enforces configured per-carrier limits independently', async () => {
        await DeveloperConfig.findOneAndUpdate(
            { configKey: 'DEVELOPER_PORTAL' },
            {
                $set: {
                    liveCarrierWorkerConcurrency: 10,
                    liveCarrierConcurrencyByCarrier: {
                        SKYNET: 1,
                        TPL: 2
                    }
                }
            },
            { upsert: true, setDefaultsOnInsert: true }
        );

        const firstSkynet = await acquireCarrierPermit('SKYNET', { leaseMs: 60000 });
        const secondSkynet = await acquireCarrierPermit('SKYNET', { leaseMs: 60000 });
        const firstTpl = await acquireCarrierPermit('TPL', { leaseMs: 60000 });
        const secondTpl = await acquireCarrierPermit('TPL', { leaseMs: 60000 });
        const thirdTpl = await acquireCarrierPermit('TPL', { leaseMs: 60000 });

        expect(firstSkynet.acquired).toBe(true);
        expect(secondSkynet.acquired).toBe(false);
        expect(firstTpl.acquired).toBe(true);
        expect(secondTpl.acquired).toBe(true);
        expect(thirdTpl.acquired).toBe(false);

        await releaseCarrierPermit(firstSkynet);
        const afterRelease = await acquireCarrierPermit('SKYNET', { leaseMs: 60000 });
        expect(afterRelease.acquired).toBe(true);

        const concurrent = await Promise.all(
            Array.from({ length: 5 }, () => acquireCarrierPermit('DHL', { limit: 2, leaseMs: 60000 }))
        );
        expect(concurrent.filter((permit) => permit.acquired)).toHaveLength(2);
        await Promise.all(concurrent.map((permit) => releaseCarrierPermit(permit)));

        const expiring = await acquireCarrierPermit('CRASHY', { limit: 1, leaseMs: 60000 });
        expect(expiring.acquired).toBe(true);
        await CarrierConcurrencyLease.updateOne(
            { carrier: 'CRASHY', 'leases.token': expiring.token },
            {
                $set: {
                    'leases.$.expiresAt': new Date(Date.now() - 1000),
                    leaseExpiresAt: new Date(Date.now() - 1000)
                }
            }
        );
        const reclaimed = await acquireCarrierPermit('CRASHY', { limit: 1, leaseMs: 60000 });
        expect(reclaimed.acquired).toBe(true);
        await releaseCarrierPermit(reclaimed);

        const renewable = await acquireCarrierPermit('RENEWABLE', { limit: 1, leaseMs: 1000 });
        const originalExpiry = renewable.expiresAt.getTime();
        const renewed = await renewCarrierPermit(renewable, { leaseMs: 60000 });
        expect(renewed.expiresAt.getTime()).toBeGreaterThan(originalExpiry);
        await releaseCarrierPermit(renewed);
    });

    test('Step 6B carrier reconciliation completes lost carrier success without duplicate booking', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-carrier-recon-');
        const bookingResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const shipment = await Shipment.findOne({ partnerRequestId });
        const idempotency = await PartnerApiIdempotency.findOne({ partnerRequestId });
        const reservation = await WalletReservation.findOne({ partnerRequestId });

        const supportsSpy = jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);
        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: false,
            statusUnknown: true,
            error: 'Carrier timeout after create request.',
            carrier: 'SKYNET'
        });
        const lookupSpy = jest.spyOn(carrierBookingService, 'findByMerchantReference').mockResolvedValue({
            found: true,
            awb: `AWB-${partnerRequestId}`,
            carrierRef: `CREF-${partnerRequestId}`,
            encodedLabel: Buffer.from('%PDF-1.4 reconciled label').toString('base64'),
            carrier: 'SKYNET'
        });

        await processLivePartnerBookingJob({
            id: `timeout-job-${partnerRequestId}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: idempotency._id,
                walletReservationId: reservation._id
            },
            attemptsMade: 0
        });

        const unknownShipment = await Shipment.findById(shipment._id);
        expect(unknownShipment.carrierBookingStatus).toBe('STATUS_UNKNOWN');
        expect(unknownShipment.processingStatus).toBe(PARTNER_API_PROCESSING_STATUSES.CARRIER_STATUS_UNKNOWN);

        await processCarrierReconciliationJob({
            id: `carrier-recon-${partnerRequestId}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: idempotency._id,
                walletReservationId: reservation._id
            },
            attemptsMade: 0
        });

        const [updatedShipment, updatedIdempotency, updatedReservation] = await Promise.all([
            Shipment.findById(shipment._id).lean(),
            PartnerApiIdempotency.findById(idempotency._id).lean(),
            WalletReservation.findById(reservation._id).lean()
        ]);

        expect(carrierSpy).toHaveBeenCalledTimes(1);
        expect(lookupSpy).toHaveBeenCalledTimes(1);
        expect(updatedShipment.carrierBookingStatus).toBe('BOOKED');
        expect(updatedShipment.trackingId).toBe(`AWB-${partnerRequestId}`);
        expect(updatedIdempotency.status).toBe(PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED);
        expect(updatedReservation.status).toBe(WALLET_RESERVATION_STATUSES.SETTLED);
        await expect(Transaction.countDocuments({ referenceId: updatedReservation.settlementReference })).resolves.toBe(1);
        expect(bookingResponse.body.data.status).toBe('PROCESSING');

        carrierSpy.mockRestore();
        lookupSpy.mockRestore();
        supportsSpy.mockRestore();
    });

    test('Step 6B wallet reconciliation settles booked carrier shipment once without another carrier call', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-wallet-recon-');
        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const shipment = await Shipment.findOne({ partnerRequestId });
        const idempotency = await PartnerApiIdempotency.findOne({ partnerRequestId });
        const reservation = await WalletReservation.findOne({ partnerRequestId });
        shipment.carrierBookingStatus = 'BOOKED';
        shipment.carrierBookingId = `CREF-${partnerRequestId}`;
        shipment.trackingId = `AWB-${partnerRequestId}`;
        shipment.labelStatus = 'LABEL_READY';
        shipment.carrierLabel = Buffer.from('%PDF-1.4 wallet label').toString('base64');
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.WALLET_RECONCILIATION_REQUIRED;
        shipment.walletSettlementStatus = 'RECONCILIATION_REQUIRED';
        await shipment.save();

        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: 'should-not-be-called'
        });

        await processWalletReconciliationJob({
            id: `wallet-recon-${partnerRequestId}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: idempotency._id,
                walletReservationId: reservation._id
            },
            attemptsMade: 0
        });
        await processWalletReconciliationJob({
            id: `wallet-recon-repeat-${partnerRequestId}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: idempotency._id,
                walletReservationId: reservation._id
            },
            attemptsMade: 1
        });

        const [updatedShipment, updatedReservation, updatedIdempotency, wallet] = await Promise.all([
            Shipment.findById(shipment._id).lean(),
            WalletReservation.findById(reservation._id).lean(),
            PartnerApiIdempotency.findById(idempotency._id).lean(),
            User.findById(fixture.user._id).lean()
        ]);

        expect(carrierSpy).not.toHaveBeenCalled();
        expect(updatedShipment.walletSettlementStatus).toBe('SETTLED');
        expect(updatedReservation.status).toBe(WALLET_RESERVATION_STATUSES.SETTLED);
        expect(updatedIdempotency.status).toBe(PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED);
        expect(wallet.walletReservedBalance).toBeCloseTo(0);
        await expect(Transaction.countDocuments({
            referenceId: updatedReservation.settlementReference,
            isPartnerApiSettlement: true
        })).resolves.toBe(1);

        carrierSpy.mockRestore();
    });

    test('Step 6B manual recovery queues reconciliation actions and blocks unsafe unknown-state requeue', async () => {
        const fixture = await createDeveloperFixture();
        const partnerRequestId = nextUnique('live-manual-recovery-');
        await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId,
            payload: bookingPayload()
        }).expect(202);

        const shipment = await Shipment.findOne({ partnerRequestId });
        shipment.carrierBookingStatus = 'STATUS_UNKNOWN';
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.CARRIER_STATUS_UNKNOWN;
        shipment.carrierMerchantReference = `DFL-${fixture.account._id}-${partnerRequestId}`;
        await shipment.save();

        await expect(requestManualRecovery({
            bookingId: shipment.partnerApiBookingId,
            action: 'REQUEUE_CARRIER_EXECUTION',
            reason: 'Carrier state is unknown after timeout.',
            admin: { _id: new mongoose.Types.ObjectId() }
        })).rejects.toMatchObject({ code: 'MANUAL_RECOVERY_NOT_ALLOWED' });

        const carrierQueueSpy = jest.spyOn(carrierReconciliationQueue, 'add');
        const carrierRecovery = await requestManualRecovery({
            bookingId: shipment.partnerApiBookingId,
            action: 'QUEUE_CARRIER_RECONCILIATION',
            reason: 'Carrier state is unknown after timeout.',
            admin: { _id: new mongoose.Types.ObjectId() }
        });
        expect(carrierRecovery.action).toBe('QUEUE_CARRIER_RECONCILIATION');
        expect(carrierQueueSpy).toHaveBeenCalledWith(
            'carrier-reconciliation-requested',
            expect.objectContaining({
                bookingId: shipment.partnerApiBookingId,
                carrierMerchantReference: shipment.carrierMerchantReference
            }),
            expect.objectContaining({ removeOnComplete: false, removeOnFail: false })
        );

        shipment.carrierBookingStatus = 'BOOKED';
        shipment.trackingId = `AWB-${partnerRequestId}`;
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.WALLET_RECONCILIATION_REQUIRED;
        shipment.walletSettlementStatus = 'RECONCILIATION_REQUIRED';
        await shipment.save();

        const walletQueueSpy = jest.spyOn(walletReconciliationQueue, 'add');
        const walletRecovery = await requestManualRecovery({
            bookingId: shipment.partnerApiBookingId,
            action: 'QUEUE_WALLET_RECONCILIATION',
            reason: 'Wallet settlement needs retry.',
            admin: { _id: new mongoose.Types.ObjectId() }
        });
        expect(walletRecovery.action).toBe('QUEUE_WALLET_RECONCILIATION');
        expect(walletQueueSpy).toHaveBeenCalledWith(
            'wallet-reconciliation-requested',
            expect.objectContaining({
                bookingId: shipment.partnerApiBookingId,
                settlementReference: shipment.walletSettlementReference
            }),
            expect.objectContaining({ removeOnComplete: false, removeOnFail: false })
        );

        await expect(DeveloperAuditLog.countDocuments({
            targetId: shipment.partnerApiBookingId,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED
        })).resolves.toBe(2);

        carrierQueueSpy.mockRestore();
        walletQueueSpy.mockRestore();
    });

    test('Step 6B Partner API settlement references are database-unique without affecting legacy transactions', async () => {
        const referenceId = 'PARTNER_API_BOOKING_DEBIT:account:request';
        await Transaction.create({
            user: new mongoose.Types.ObjectId(),
            walletOwnerId: new mongoose.Types.ObjectId(),
            walletOwnerType: 'User',
            amount: -100,
            type: 'debit',
            description: 'Partner API settlement',
            referenceId,
            isPartnerApiSettlement: true,
            performedByModel: 'System'
        });
        await expect(Transaction.create({
            user: new mongoose.Types.ObjectId(),
            walletOwnerId: new mongoose.Types.ObjectId(),
            walletOwnerType: 'User',
            amount: -100,
            type: 'debit',
            description: 'Duplicate Partner API settlement',
            referenceId,
            isPartnerApiSettlement: true,
            performedByModel: 'System'
        })).rejects.toMatchObject({ code: 11000 });

        await Transaction.create({
            user: new mongoose.Types.ObjectId(),
            walletOwnerId: new mongoose.Types.ObjectId(),
            walletOwnerType: 'User',
            amount: -100,
            type: 'debit',
            description: 'Legacy transaction one',
            referenceId: 'legacy-duplicate',
            performedByModel: 'System'
        });
        await Transaction.create({
            user: new mongoose.Types.ObjectId(),
            walletOwnerId: new mongoose.Types.ObjectId(),
            walletOwnerType: 'User',
            amount: -100,
            type: 'debit',
            description: 'Legacy transaction two',
            referenceId: 'legacy-duplicate',
            performedByModel: 'System'
        });
        await expect(Transaction.countDocuments({ referenceId: 'legacy-duplicate' })).resolves.toBe(2);
    });

    test('Step 6C Live cancellation validates tenancy, protected fields, and Sandbox credential isolation', async () => {
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

        await cancelPartnerBooking({
            apiKey: live.apiKey,
            bookingId: createResponse.body.data.bookingId,
            partnerRequestId: nextUnique('live-cancel-protected-'),
            body: { reason: 'Cancel this booking.', refundAmount: 500 }
        }).expect(400);

        await cancelPartnerBooking({
            apiKey: other.apiKey,
            bookingId: createResponse.body.data.bookingId,
            partnerRequestId: nextUnique('live-cancel-cross-')
        }).expect(404);

        await cancelPartnerBooking({
            apiKey: sandbox.apiKey,
            bookingId: createResponse.body.data.bookingId,
            partnerRequestId: nextUnique('live-cancel-sandbox-')
        }).expect(404);
    });

    test('Step 6C pre-carrier cancellation is idempotent, releases reservation once, and blocks carrier execution', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createPartnerRequestId = nextUnique('live-cancel-pre-create-');
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: createPartnerRequestId
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const cancelPartnerRequestId = nextUnique('live-cancel-pre-');

        const cancelResponse = await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: cancelPartnerRequestId,
            body: { reason: 'Customer requested cancellation before pickup.' }
        }).expect(202);
        expect(cancelResponse.body.data.cancellation.status).toBe(PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED);

        const replay = await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: cancelPartnerRequestId,
            body: { reason: 'Customer requested cancellation before pickup.' }
        }).expect(202);
        expect(replay.body.data.bookingId).toBe(bookingId);

        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: cancelPartnerRequestId,
            body: { reason: 'Changed reason should conflict.' }
        }).expect(409);

        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        expect(cancellation).toBeTruthy();
        await expect(PartnerApiCancellation.countDocuments({ bookingId })).resolves.toBe(1);
        await expect(PartnerApiOutboxEvent.countDocuments({
            bookingId,
            eventType: 'LIVE_PARTNER_BOOKING_CANCELLATION_REQUESTED'
        })).resolves.toBe(1);

        await processLivePartnerCancellationJob({
            id: 'test-cancel-pre-carrier',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });

        const [shipment, reservation, wallet] = await Promise.all([
            Shipment.findOne({ partnerApiBookingId: bookingId }).lean(),
            WalletReservation.findOne({ bookingId }).lean(),
            User.findById(fixture.user._id).lean()
        ]);
        expect(shipment.status).toBe('Cancelled');
        expect(shipment.processingStatus).toBe(PARTNER_API_PROCESSING_STATUSES.CANCELLED);
        expect(shipment.cancellationStatus).toBe(PARTNER_API_CANCELLATION_STATUSES.CANCELLED);
        expect(shipment.refundStatus).toBe(PARTNER_API_REFUND_STATUSES.RESERVATION_RELEASED);
        expect(reservation.status).toBe(WALLET_RESERVATION_STATUSES.RELEASED);
        expect(wallet.walletReservedBalance).toBe(0);
        expect(wallet.walletBalance).toBe(10000);

        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({ success: true, awb: 'SHOULD-NOT-CALL' });
        const workerResult = await processLivePartnerBookingJob({
            id: 'test-booking-after-cancel',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });
        expect(workerResult.status).toBe('ALREADY_COMPLETE');
        expect(carrierSpy).not.toHaveBeenCalled();
        carrierSpy.mockRestore();
    });

    test('Step 6C settled booking cancellation confirms carrier cancellation and refunds actual debit once', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-cancel-settled-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });
        const carrierSpy = jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: `AWB-${bookingId}`,
            carrierRef: `CREF-${bookingId}`,
            label: Buffer.from('%PDF-1.4 test').toString('base64'),
            carrier: 'TPL'
        });
        jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);

        await processLivePartnerBookingJob({
            id: 'test-booking-before-settled-cancel',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });
        const settledShipment = await Shipment.findById(shipment._id);
        expect(settledShipment.walletSettlementStatus).toBe('SETTLED');

        const cancelSpy = jest.spyOn(carrierBookingService, 'cancelByShipment').mockResolvedValue({
            status: 'CANCELLED',
            carrier: 'TPL',
            carrierCancellationReference: `CXL-${bookingId}`
        });
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('live-cancel-settled-')
        }).expect(202);
        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        await processLivePartnerCancellationJob({
            id: 'test-cancel-settled',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });
        await processLivePartnerCancellationJob({
            id: 'test-cancel-settled-duplicate',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });

        const [cancelledShipment, refundTxns, wallet, reservation] = await Promise.all([
            Shipment.findById(shipment._id).lean(),
            Transaction.find({ referenceId: new RegExp(`PARTNER_API_BOOKING_REFUND:.*:${bookingId}$`) }).lean(),
            User.findById(fixture.user._id).lean(),
            WalletReservation.findOne({ bookingId }).lean()
        ]);
        expect(cancelledShipment.status).toBe('Cancelled');
        expect(cancelledShipment.refundStatus).toBe(PARTNER_API_REFUND_STATUSES.REFUNDED);
        expect(refundTxns).toHaveLength(1);
        expect(refundTxns[0].type).toBe('credit');
        expect(refundTxns[0].amount).toBe(reservation.amount);
        expect(wallet.walletBalance).toBe(10000);
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        carrierSpy.mockRestore();
        cancelSpy.mockRestore();
    });

    test('Step 6C cancellation and refund reconciliation workers complete unresolved states', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-cancel-recon-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
        const shipment = await Shipment.findOne({ partnerApiBookingId: bookingId });
        jest.spyOn(carrierBookingService, 'supportsApiBooking').mockReturnValue(true);
        jest.spyOn(carrierBookingService, 'book').mockResolvedValue({
            success: true,
            awb: `AWB-${bookingId}`,
            carrierRef: `CREF-${bookingId}`,
            carrier: 'TPL'
        });
        await processLivePartnerBookingJob({
            id: 'test-recon-booking',
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });

        jest.spyOn(carrierBookingService, 'cancelByShipment').mockResolvedValue({
            status: 'STATUS_UNKNOWN',
            carrier: 'TPL',
            message: 'Unknown cancellation result.'
        });
        await cancelPartnerBooking({
            apiKey: fixture.apiKey,
            bookingId,
            partnerRequestId: nextUnique('live-cancel-recon-'),
            body: { reason: 'Customer requested cancellation.' }
        }).expect(202);
        const cancellation = await PartnerApiCancellation.findOne({ bookingId });
        await processLivePartnerCancellationJob({
            id: 'test-cancel-unknown',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });
        await expect(Shipment.findById(shipment._id).then(doc => doc.cancellationStatus)).resolves.toBe(PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_STATUS_UNKNOWN);

        jest.spyOn(carrierBookingService, 'findCancellationByReference').mockResolvedValue({
            found: true,
            status: 'CANCELLED',
            carrier: 'TPL'
        });
        await processCancellationReconciliationJob({
            id: 'test-cancel-reconciliation',
            data: { cancellationId: cancellation._id },
            attemptsMade: 0
        });
        await processRefundReconciliationJob({
            id: 'test-refund-reconciliation-duplicate',
            data: { cancellationId: cancellation._id, shipmentId: shipment._id },
            attemptsMade: 0
        });
        await expect(Shipment.findById(shipment._id).then(doc => doc.refundStatus)).resolves.toBe(PARTNER_API_REFUND_STATUSES.REFUNDED);
    });

    test('Step 6C integrity verifier detects cancelled bookings with active reservations without mutating records', async () => {
        const fixture = await createDeveloperFixture({ userOverrides: { walletBalance: 10000 } });
        const createResponse = await postPartnerBooking({
            apiKey: fixture.apiKey,
            partnerRequestId: nextUnique('live-cancel-integrity-create-')
        }).expect(202);
        const bookingId = createResponse.body.data.bookingId;
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
        expect(afterReservation.status).toBe(beforeReservation.status);
    });
});
