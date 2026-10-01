const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { QueueEvents, Worker } = require('bullmq');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findFreePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const waitForPort = async (port, timeoutMs = 10000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const ok = await new Promise((resolve) => {
            const socket = net.connect({ port, host: '127.0.0.1' });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
        });
        if (ok) return;
        await wait(100);
    }
    throw new Error(`Timed out waiting for port ${port}`);
};

const startRedis = async () => {
    const port = await findFreePort();
    const child = spawn('redis-server', [
        '--bind', '127.0.0.1',
        '--port', String(port),
        '--save', '""',
        '--appendonly', 'no'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForPort(port);
    return { child, port };
};

const stopChild = async (child) => {
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        wait(3000).then(() => {
            if (!child.killed) child.kill('SIGKILL');
        })
    ]);
};

const waitForCondition = async (label, fn, timeoutMs = 15000) => {
    const startedAt = Date.now();
    let lastValue;
    while (Date.now() - startedAt < timeoutMs) {
        lastValue = await fn();
        if (lastValue) return lastValue;
        await wait(250);
    }
    throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
};

const makeReq = ({ partnerAuth, partnerRequestId, payload }) => ({
    partnerAuth,
    body: payload,
    ip: '127.0.0.1',
    is: (type) => type === 'application/json',
    get: (name) => {
        const normalized = String(name).toLowerCase();
        if (normalized === 'x-partner-request-id') return partnerRequestId;
        return undefined;
    }
});

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

const main = async () => {
    const evidence = {
        approved: false,
        infrastructure: {},
        scenarios: {},
        warnings: [],
        totals: {}
    };

    const redis = await startRedis();
    let mongo;
    let closeRedisConnection;
    let bookingWorkerModule;
    let cancellationWorkerModule;
    let cancellationReconWorkerModule;
    let refundReconWorkerModule;

    try {
        process.env.NODE_ENV = 'step6c-verification';
        process.env.BYPASS_REDIS = 'false';
        process.env.REDIS_HOST = '127.0.0.1';
        process.env.REDIS_PORT = String(redis.port);
        process.env.PARTNER_API_KEY_PEPPER = 'step-6c-real-redis-verification-pepper';
        process.env.JWT_SECRET = 'step-6c-real-redis-verification-jwt';
        process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';

        mongo = await MongoMemoryReplSet.create({
            instanceOpts: [{ ip: '127.0.0.1' }],
            replSet: { count: 1, storageEngine: 'wiredTiger' }
        });
        await mongoose.connect(mongo.getUri());
        evidence.infrastructure.mongodb = 'MongoMemoryReplSet wiredTiger transaction-capable';
        evidence.infrastructure.redis = `redis-server 127.0.0.1:${redis.port}`;
        evidence.infrastructure.bypassRedis = process.env.BYPASS_REDIS;

        const User = require('../models/User');
        const DeveloperAccount = require('../models/DeveloperAccount');
        const DeveloperApplication = require('../models/DeveloperApplication');
        const ApiCredential = require('../models/ApiCredential');
        const DeveloperConfig = require('../models/DeveloperConfig');
        const RateZone = require('../models/RateZone');
        const RateTable = require('../models/RateTable');
        const Shipment = require('../models/Shipment');
        const WalletReservation = require('../models/WalletReservation');
        const PartnerApiCancellation = require('../models/PartnerApiCancellation');
        const PartnerApiIdempotency = require('../models/PartnerApiIdempotency');
        const PartnerApiOutboxEvent = require('../models/PartnerApiOutboxEvent');
        const Transaction = require('../models/Transaction');
        const InactiveCustomerAlert = require('../models/InactiveCustomerAlert');
        const {
            ACCESS_LEVELS,
            APPLICATION_STATUSES,
            CREDENTIAL_STATUSES,
            DEVELOPER_ACCOUNT_STATUSES,
            DEVELOPER_ENVIRONMENTS,
            PARTNER_API_IDEMPOTENCY_STATUSES,
            PARTNER_API_PROCESSING_STATUSES,
            PARTNER_API_REFUND_STATUSES,
            SLA_TIERS,
            WALLET_RESERVATION_STATUSES
        } = require('../constants/developerPortal');
        ({ closeRedisConnection } = require('../config/redisConfig'));

        const { createLiveBooking } = require('../services/openapi/livePartnerBookingService');
        const { createLiveCancellation } = require('../services/openapi/livePartnerCancellationService');
        const carrierBookingService = require('../services/carriers/CarrierBookingService');
        const rateCalculator = require('../utils/rateCalculator');
        const { generateApiKey } = require('../utils/developerCredentialCrypto');

        await Promise.all([
            User.init(),
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            ApiCredential.init(),
            DeveloperConfig.init(),
            RateZone.init(),
            RateTable.init(),
            Shipment.init(),
            WalletReservation.init(),
            PartnerApiCancellation.init(),
            PartnerApiIdempotency.init(),
            PartnerApiOutboxEvent.init(),
            Transaction.init(),
            InactiveCustomerAlert.init()
        ]);

        rateCalculator.zones = null;
        rateCalculator.rates = null;
        rateCalculator.serviceMap = null;
        rateCalculator.cache = new Map();
        await Promise.all([
            RateZone.create({ country: 'US', state: 'NY', zone: 'TUS1' }),
            RateTable.create({ weight: 2, rates: { TUS1: 500, UUSPS: 575 } })
        ]);

        await DeveloperConfig.findOneAndUpdate(
            { configKey: 'DEVELOPER_PORTAL' },
            {
                $setOnInsert: { configKey: 'DEVELOPER_PORTAL' },
                $set: {
                    liveCarrierMaxAttempts: 2,
                    liveCarrierRetryBackoffSeconds: [1],
                    liveCarrierWorkerConcurrency: 2,
                    liveCarrierConcurrencyByCarrier: { UNITED: 2, SKYNET: 1, TPL: 1, RSA: 1 }
                }
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        // Mock external carrier APIs
        const state = { calls: [], cancels: [] };
        carrierBookingService.supportsApiBooking = () => true;
        carrierBookingService.book = async (shipment, user, carrierIdentifier) => {
            state.calls.push({ partnerRequestId: shipment.partnerRequestId, carrierIdentifier });
            return {
                success: true,
                awb: `AWB-${shipment.partnerRequestId}`,
                carrierRef: `CREF-${shipment.partnerRequestId}`,
                label: Buffer.from('%PDF-1.4 verification').toString('base64'),
                carrier: carrierIdentifier
            };
        };
        carrierBookingService.cancelByShipment = async (shipment, cancellation, executionSource) => {
            state.cancels.push({ bookingId: shipment.partnerApiBookingId });
            return {
                status: 'CANCELLED',
                carrier: 'TPL',
                carrierCancellationReference: `CX-${shipment.partnerApiBookingId}`
            };
        };

        // Start workers
        bookingWorkerModule = require('../workers/livePartnerBookingWorker');
        cancellationWorkerModule = require('../workers/livePartnerCancellationWorker');
        cancellationReconWorkerModule = require('../workers/cancellationReconciliationWorker');
        refundReconWorkerModule = require('../workers/refundReconciliationWorker');

        await Promise.all([
            bookingWorkerModule.startLivePartnerBookingWorker(),
            cancellationWorkerModule.startLivePartnerCancellationWorker(),
            cancellationReconWorkerModule.startCancellationReconciliationWorker(),
            refundReconWorkerModule.startRefundReconciliationWorker()
        ]);

        const createFixture = async () => {
            const suffix = crypto.randomBytes(4).toString('hex');
            const user = await User.create({
                name: 'Step 6C Verification User',
                email: `step6c-${suffix}@example.com`,
                phone: '+919999999999',
                password: 'Password123!',
                customerId: `CUST${suffix}`,
                walletBalance: 25000,
                walletReservedBalance: 0,
                kycVerified: true,
                companyName: 'Step 6C Verification Pvt Ltd',
                kycData: {
                    status: 'verified',
                    panName: 'Step 6C Verification Pvt Ltd',
                    billingAddress: {
                        addressLine1: 'DFL Address',
                        addressLine2: 'Noida',
                        city: 'Noida',
                        state: 'Uttar Pradesh',
                        pincode: '201301',
                        country: 'IN'
                    }
                }
            });
            const account = await DeveloperAccount.create({
                userId: user._id,
                accessLevel: ACCESS_LEVELS.LIVE,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                tier: SLA_TIERS.GOLD,
                sandboxApprovedAt: new Date(),
                liveApprovedAt: new Date()
            });
            const generated = generateApiKey(DEVELOPER_ENVIRONMENTS.LIVE);
            const credential = await ApiCredential.create({
                userId: user._id,
                developerAccountId: account._id,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                name: 'Step 6C Verification Live Key',
                prefix: generated.prefix,
                secretHash: generated.secretHash,
                status: CREDENTIAL_STATUSES.ACTIVE,
                isPrimary: true,
                createdBy: user._id,
                createdByModel: 'User'
            });
            return { user, account, credential, apiKey: generated.fullApiKey };
        };

        const postBookingReq = ({ fixture, partnerRequestId }) => {
            const partnerAuth = {
                userId: fixture.user._id,
                developerAccountObjectId: fixture.account._id,
                developerAccountId: fixture.account.developerAccountId,
                credentialObjectId: fixture.credential._id,
                credentialId: fixture.credential.credentialId,
                credentialPrefix: fixture.credential.prefix,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                accessLevel: ACCESS_LEVELS.LIVE,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                requestId: `REQ-B-${partnerRequestId}`
            };
            return makeReq({ partnerAuth, partnerRequestId, payload: bookingPayload(partnerRequestId) });
        };

        const postCancelReq = ({ fixture, bookingId, partnerRequestId, body = { reason: 'Test cancel.' } }) => {
            const partnerAuth = {
                userId: fixture.user._id,
                developerAccountObjectId: fixture.account._id,
                developerAccountId: fixture.account.developerAccountId,
                credentialObjectId: fixture.credential._id,
                credentialId: fixture.credential.credentialId,
                credentialPrefix: fixture.credential.prefix,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                accessLevel: ACCESS_LEVELS.LIVE,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                requestId: `REQ-C-${partnerRequestId}`
            };
            return makeReq({ partnerAuth, partnerRequestId, payload: body });
        };

        // Scenario 1: Post-settlement cancellation + refund
        const reqId1 = `req-post-settled-${Date.now()}`;
        const fixture1 = await createFixture();
        const bookingReq1 = postBookingReq({ fixture: fixture1, partnerRequestId: reqId1 });
        const bookingResponse = await createLiveBooking(bookingReq1, bookingReq1.partnerAuth.requestId);

        const bookingId = bookingResponse.body.data.bookingId;

        // Wait for booking worker to complete settlement
        const shipment1 = await waitForCondition(
            `${reqId1} completed`,
            async () => {
                const doc = await Shipment.findOne({ partnerApiBookingId: bookingId }).lean();
                return doc && doc.walletSettlementStatus === 'SETTLED' ? doc : null;
            },
            15000
        );

        // Cancel
        const cancelReq1 = postCancelReq({ fixture: fixture1, bookingId, partnerRequestId: `cancel-${reqId1}` });
        const cancelResponse = await createLiveCancellation(
            {
                ...cancelReq1,
                params: { bookingId },
                is: cancelReq1.is,
                get: cancelReq1.get
            },
            cancelReq1.partnerAuth.requestId
        );

        // Wait for cancellation worker to process and refund
        const finalShipment1 = await waitForCondition(
            `${reqId1} cancelled & refunded`,
            async () => {
                const doc = await Shipment.findOne({ partnerApiBookingId: bookingId }).lean();
                if (doc) {
                    const PartnerApiCancellation = mongoose.model('PartnerApiCancellation');
                    const PartnerApiOutboxEvent = mongoose.model('PartnerApiOutboxEvent');
                    const cancelDoc = await PartnerApiCancellation.findOne({ bookingId }).lean();
                    const outboxDoc = doc.cancellationOutboxEventId
                        ? await PartnerApiOutboxEvent.findById(doc.cancellationOutboxEventId).lean()
                        : null;
                    console.log(`[WAITING DEBUG] shipment status=${doc.status}, carrierBookingStatus=${doc.carrierBookingStatus}, cancellationStatus=${doc.cancellationStatus}, refundStatus=${doc.refundStatus}`);
                    if (cancelDoc) {
                        console.log(`[WAITING DEBUG] cancellation status=${cancelDoc.status}, refundStatus=${cancelDoc.refundStatus}, queueJobId=${cancelDoc.queueJobId}`);
                    }
                    if (outboxDoc) {
                        console.log(`[WAITING DEBUG] outbox status=${outboxDoc.status}, queueJobId=${outboxDoc.queueJobId}, attempts=${outboxDoc.attempts}, lastErrorMessage=${outboxDoc.lastErrorMessage}`);
                    }
                } else {
                    console.log(`[WAITING DEBUG] shipment not found`);
                }
                return doc && doc.refundStatus === PARTNER_API_REFUND_STATUSES.REFUNDED ? doc : null;
            },
            15000
        );

        const refundTxns = await Transaction.find({ partnerApiFinancialReference: `PARTNER_API_BOOKING_REFUND:${fixture1.account._id}:${bookingId}` }).lean();
        const finalWallet1 = await User.findById(fixture1.user._id).lean();

        evidence.scenarios.postSettlementRefund = {
            shipmentStatus: finalShipment1.status,
            refundStatus: finalShipment1.refundStatus,
            carrierCancellationCalls: state.cancels.filter(c => c.bookingId === bookingId).length,
            refundTxnsCount: refundTxns.length,
            walletBalance: finalWallet1.walletBalance
        };

        evidence.approved = true;
        console.log(JSON.stringify(evidence, null, 2));

    } finally {
        await Promise.all([
            bookingWorkerModule ? bookingWorkerModule.stopLivePartnerBookingWorker() : Promise.resolve(),
            cancellationWorkerModule ? cancellationWorkerModule.stopLivePartnerCancellationWorker() : Promise.resolve(),
            cancellationReconWorkerModule ? cancellationReconWorkerModule.stopCancellationReconciliationWorker() : Promise.resolve(),
            refundReconWorkerModule ? refundReconWorkerModule.stopRefundReconciliationWorker() : Promise.resolve()
        ].map(p => Promise.resolve(p).catch(() => {})));

        if (closeRedisConnection) await closeRedisConnection().catch(() => {});
        await mongoose.disconnect().catch(() => {});
        if (mongo) await mongo.stop().catch(() => {});
        await stopChild(redis.child);
    }
};

main().catch((error) => {
    console.error(JSON.stringify({
        approved: false,
        error: error.message,
        stack: error.stack
    }, null, 2));
    process.exitCode = 1;
});
