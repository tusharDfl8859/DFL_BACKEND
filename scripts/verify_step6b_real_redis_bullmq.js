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
    throw new Error(`Timed out waiting for Redis on port ${port}`);
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
        if (normalized === 'user-agent') return 'step-6b-real-redis-verifier';
        return undefined;
    }
});

const resetRateCalculator = (rateCalculator) => {
    rateCalculator.zones = null;
    rateCalculator.rates = null;
    rateCalculator.serviceMap = null;
    rateCalculator.lastLoaded = null;
    rateCalculator.cache = new Map();
};

const bookingPayload = (partnerRequestId) => ({
    recipient: {
        name: 'Live Verification Customer',
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
        description: 'Step 6B verification product'
    },
    order: {
        orderId: `ORDER-${partnerRequestId}`,
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
    let queueEvents;
    let extraWorker;
    let stopLivePartnerBookingWorker;
    let stopCarrierReconciliationWorker;
    let stopWalletReconciliationWorker;
    let livePartnerBookingQueue;
    let carrierReconciliationQueue;
    let walletReconciliationQueue;
    let closeRedisConnection;

    try {
        process.env.NODE_ENV = 'step6b-verification';
        process.env.BYPASS_REDIS = 'false';
        process.env.REDIS_HOST = '127.0.0.1';
        process.env.REDIS_PORT = String(redis.port);
        process.env.PARTNER_API_KEY_PEPPER = 'step-6b-real-redis-verification-pepper';
        process.env.JWT_SECRET = 'step-6b-real-redis-verification-jwt';
        process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';
        process.env.LIVE_PARTNER_CARRIER_WORKER_CONCURRENCY = '2';
        process.env.LIVE_CARRIER_LEASE_MS = '3000';

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
        const PartnerApiIdempotency = require('../models/PartnerApiIdempotency');
        const PartnerApiOutboxEvent = require('../models/PartnerApiOutboxEvent');
        const Transaction = require('../models/Transaction');
        const CarrierConcurrencyLease = require('../models/CarrierConcurrencyLease');
        const InactiveCustomerAlert = require('../models/InactiveCustomerAlert');
        const rateCalculator = require('../utils/rateCalculator');
        const { generateApiKey } = require('../utils/developerCredentialCrypto');
        const {
            ACCESS_LEVELS,
            APPLICATION_STATUSES,
            CREDENTIAL_STATUSES,
            DEVELOPER_ACCOUNT_STATUSES,
            DEVELOPER_ENVIRONMENTS,
            PARTNER_API_IDEMPOTENCY_STATUSES,
            PARTNER_API_OUTBOX_STATUSES,
            PARTNER_API_PROCESSING_STATUSES,
            SLA_TIERS
        } = require('../constants/developerPortal');
        ({ closeRedisConnection } = require('../config/redisConfig'));
        const { createLiveBooking } = require('../services/openapi/livePartnerBookingService');
        const { makeDeterministicJobId } = require('../services/openapi/livePartnerBookingOutboxService');
        livePartnerBookingQueue = require('../queues/livePartnerBookingQueue');
        carrierReconciliationQueue = require('../queues/carrierReconciliationQueue');
        walletReconciliationQueue = require('../queues/walletReconciliationQueue');
        const carrierBookingService = require('../services/carriers/CarrierBookingService');
        const {
            acquireCarrierPermit,
            releaseCarrierPermit,
            renewCarrierPermit
        } = require('../services/openapi/liveCarrierConcurrencyService');

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
            PartnerApiIdempotency.init(),
            PartnerApiOutboxEvent.init(),
            Transaction.init(),
            CarrierConcurrencyLease.init(),
            InactiveCustomerAlert.init()
        ]);

        resetRateCalculator(rateCalculator);
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
                    liveCarrierConcurrencyByCarrier: {
                        UNITED: 2,
                        SKYNET: 1,
                        TPL: 1,
                        RSA: 1
                    }
                }
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        const state = {
            calls: [],
            lookups: [],
            behaviorByRequest: new Map()
        };
        carrierBookingService.supportsApiBooking = () => true;
        carrierBookingService.book = async (shipment, user, carrierIdentifier) => {
            const partnerRequestId = shipment.partnerRequestId;
            const behavior = state.behaviorByRequest.get(partnerRequestId) || ['success'];
            const attempt = state.calls.filter((call) => call.partnerRequestId === partnerRequestId).length + 1;
            state.calls.push({ partnerRequestId, carrierIdentifier, attempt, at: new Date().toISOString() });
            const next = behavior[Math.min(attempt - 1, behavior.length - 1)];
            if (next === 'retryable') {
                return {
                    success: false,
                    error: 'Verification carrier retryable service unavailable.',
                    status: 503,
                    carrier: carrierIdentifier,
                    isRetryable: true
                };
            }
            if (next === 'unknown') {
                return {
                    success: false,
                    statusUnknown: true,
                    error: 'Verification carrier response lost after create.',
                    carrier: carrierIdentifier
                };
            }
            return {
                success: true,
                awb: `AWB-${partnerRequestId}`,
                carrierRef: `CREF-${partnerRequestId}`,
                label: Buffer.from('%PDF-1.4 step 6b verification label').toString('base64'),
                carrier: carrierIdentifier
            };
        };
        carrierBookingService.findByMerchantReference = async (carrierIdentifier, merchantReference) => {
            state.lookups.push({ carrierIdentifier, merchantReference, at: new Date().toISOString() });
            const partnerRequestId = String(merchantReference).split('-').slice(-1)[0];
            return {
                found: true,
                awb: `AWB-${partnerRequestId}`,
                carrierRef: `CREF-${partnerRequestId}`,
                label: Buffer.from('%PDF-1.4 reconciled verification label').toString('base64'),
                carrier: carrierIdentifier
            };
        };

        const runtimeNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        const livePartnerWorkerModule = require('../workers/livePartnerBookingWorker');
        const carrierReconciliationWorkerModule = require('../workers/carrierReconciliationWorker');
        const walletReconciliationWorkerModule = require('../workers/walletReconciliationWorker');
        process.env.NODE_ENV = runtimeNodeEnv;

        const {
            handleLivePartnerBookingJobFailure,
            processLivePartnerBookingJob,
            startLivePartnerBookingWorker
        } = livePartnerWorkerModule;
        ({
            stopLivePartnerBookingWorker
        } = livePartnerWorkerModule);
        const {
            startCarrierReconciliationWorker
        } = carrierReconciliationWorkerModule;
        ({
            stopCarrierReconciliationWorker
        } = carrierReconciliationWorkerModule);
        const {
            startWalletReconciliationWorker
        } = walletReconciliationWorkerModule;
        ({
            stopWalletReconciliationWorker
        } = walletReconciliationWorkerModule);

        const startedWorkers = await Promise.all([
            startLivePartnerBookingWorker(),
            startCarrierReconciliationWorker(),
            startWalletReconciliationWorker()
        ]);
        await Promise.all(startedWorkers
            .filter(Boolean)
            .map((worker) => worker.waitUntilReady ? worker.waitUntilReady() : undefined));
        extraWorker = new Worker('live-partner-booking', processLivePartnerBookingJob, {
            connection: { host: '127.0.0.1', port: redis.port, maxRetriesPerRequest: null },
            concurrency: 1
        });
        extraWorker.on('failed', handleLivePartnerBookingJobFailure);
        await extraWorker.waitUntilReady();
        queueEvents = new QueueEvents('live-partner-booking', {
            connection: { host: '127.0.0.1', port: redis.port, maxRetriesPerRequest: null }
        });
        await queueEvents.waitUntilReady();
        evidence.infrastructure.workers = [
            'livePartnerBookingWorker',
            'carrierReconciliationWorker',
            'walletReconciliationWorker',
            'second live-partner-booking Worker instance'
        ];

        const createFixture = async () => {
            const suffix = crypto.randomBytes(4).toString('hex');
            const user = await User.create({
                name: 'Step 6B Verification Customer',
                email: `step6b-${suffix}@example.com`,
                phone: '+919999999999',
                password: 'Password123!',
                customerId: `CUST${suffix}`,
                walletBalance: 25000,
                walletReservedBalance: 0,
                kycVerified: true,
                companyName: 'Step 6B Verification Pvt Ltd',
                kycData: {
                    status: 'verified',
                    panName: 'Step 6B Verification Pvt Ltd',
                    billingAddress: {
                        addressLine1: 'DFL Pickup Address',
                        addressLine2: 'Sector 132',
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
                    description: 'Step 6B verification flow.'
                },
                agreements: {
                    termsAccepted: true,
                    walletBillingAccepted: true,
                    rateLimitAccepted: true,
                    customsComplianceAccepted: true,
                    agreementVersion: '1.0',
                    acceptedAt: new Date()
                },
                status: APPLICATION_STATUSES.LIVE_APPROVED,
                submittedAt: new Date()
            });
            const generated = generateApiKey(DEVELOPER_ENVIRONMENTS.LIVE);
            const credential = await ApiCredential.create({
                userId: user._id,
                developerAccountId: account._id,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                name: 'Step 6B Verification Live Key',
                prefix: generated.prefix,
                secretHash: generated.secretHash,
                status: CREDENTIAL_STATUSES.ACTIVE,
                isPrimary: true,
                createdBy: user._id,
                createdByModel: 'User'
            });
            return { user, account, credential };
        };

        const admit = async (partnerRequestId) => {
            const fixture = await createFixture();
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
                requestId: `REQ-${partnerRequestId}`
            };
            const payload = bookingPayload(partnerRequestId);
            const response = await createLiveBooking(
                makeReq({ partnerAuth, partnerRequestId, payload }),
                partnerAuth.requestId
            );
            return { fixture, partnerAuth, payload, response };
        };

        const describeRequestState = async (partnerRequestId) => {
            const findQueueJobsForRequest = async (queue) => {
                if (!queue || !queue.getJobs) return [];
                const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'], 0, 25);
                return Promise.all(jobs
                    .filter((job) => job?.data?.partnerRequestId === partnerRequestId)
                    .map(async (job) => ({
                        id: job.id,
                        name: job.name,
                        state: job.getState ? await job.getState() : null,
                        attemptsMade: job.attemptsMade,
                        failedReason: job.failedReason,
                        stacktrace: job.stacktrace
                    })));
            };
            const shipment = await Shipment.findOne({ partnerRequestId }).lean();
            const outbox = shipment?.outboxEventId
                ? await PartnerApiOutboxEvent.findById(shipment.outboxEventId).lean()
                : null;
            const queueCounts = livePartnerBookingQueue
                ? await livePartnerBookingQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
                : null;
            const carrierQueueCounts = carrierReconciliationQueue
                ? await carrierReconciliationQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
                : null;
            const walletQueueCounts = walletReconciliationQueue
                ? await walletReconciliationQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')
                : null;
            const job = outbox?.queueJobId && livePartnerBookingQueue
                ? await livePartnerBookingQueue.getJob(outbox.queueJobId)
                : null;
            return {
                shipment: shipment ? {
                    processingStatus: shipment.processingStatus,
                    carrierBookingStatus: shipment.carrierBookingStatus,
                    carrierBookingError: shipment.carrierBookingError,
                    walletSettlementStatus: shipment.walletSettlementStatus,
                    outboxEventId: shipment.outboxEventId,
                    idempotencyRecordId: shipment.idempotencyRecordId,
                    walletReservationId: shipment.walletReservationId
                } : null,
                outbox: outbox ? {
                    status: outbox.status,
                    queueJobId: outbox.queueJobId,
                    lastErrorCode: outbox.lastErrorCode,
                    lastErrorMessage: outbox.lastErrorMessage,
                    errorMessage: outbox.errorMessage
                } : null,
                queueCounts,
                carrierQueueCounts,
                walletQueueCounts,
                job: job ? {
                    id: job.id,
                    name: job.name,
                    attemptsMade: job.attemptsMade,
                    failedReason: job.failedReason,
                    stacktrace: job.stacktrace
                } : null,
                carrierJobs: await findQueueJobsForRequest(carrierReconciliationQueue),
                walletJobs: await findQueueJobsForRequest(walletReconciliationQueue)
            };
        };

        const waitForShipmentStatus = async (partnerRequestId, expected) => {
            try {
                return await waitForCondition(
                    `${partnerRequestId} -> ${expected}`,
                    async () => {
                        const shipment = await Shipment.findOne({ partnerRequestId }).lean();
                        return shipment && shipment.processingStatus === expected ? shipment : null;
                    },
                    20000
                );
            } catch (error) {
                const stateSnapshot = await describeRequestState(partnerRequestId);
                error.message = `${error.message}. State: ${JSON.stringify(stateSnapshot)}`;
                throw error;
            }
        };

        const normalRequestId = `normal-${Date.now()}`;
        state.behaviorByRequest.set(normalRequestId, ['success']);
        const normal = await admit(normalRequestId);
        const normalShipment = await waitForShipmentStatus(normalRequestId, PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        const normalOutbox = await PartnerApiOutboxEvent.findById(normalShipment.outboxEventId).lean();
        const normalReservation = await WalletReservation.findById(normalShipment.walletReservationId).lean();
        const normalIdempotency = await PartnerApiIdempotency.findById(normalShipment.idempotencyRecordId).lean();
        evidence.scenarios.normalJobProcessing = {
            admittedStatusCode: normal.response.statusCode,
            outboxStatus: normalOutbox.status,
            queueJobId: normalOutbox.queueJobId,
            shipmentProcessingStatus: normalShipment.processingStatus,
            walletReservationStatus: normalReservation.status,
            idempotencyStatus: normalIdempotency.status,
            carrierCalls: state.calls.filter((call) => call.partnerRequestId === normalRequestId).length,
            transactions: await Transaction.countDocuments({ referenceId: normalReservation.settlementReference })
        };

        const duplicateJob = await livePartnerBookingQueue.add(
            'live-partner-booking-requested',
            {
                bookingId: normalShipment.partnerApiBookingId,
                shipmentId: normalShipment._id,
                developerAccountId: normalShipment.developerAccountId,
                credentialId: normalShipment.credentialId,
                environment: normalShipment.environment,
                partnerRequestId: normalShipment.partnerRequestId,
                walletReservationId: normalShipment.walletReservationId,
                idempotencyRecordId: normalShipment.idempotencyRecordId,
                requestId: normalShipment.partnerApiRequestId
            },
            { jobId: `duplicate-delivery-${normalShipment.partnerApiBookingId}`, removeOnComplete: false, removeOnFail: false }
        );
        const duplicateResult = await duplicateJob.waitUntilFinished(queueEvents, 15000);
        const normalCallsAfterDuplicate = state.calls.filter((call) => call.partnerRequestId === normalRequestId).length;
        evidence.scenarios.duplicateDelivery = {
            duplicateJobResult: duplicateResult,
            carrierCallsAfterDuplicate: normalCallsAfterDuplicate,
            transactionCountAfterDuplicate: await Transaction.countDocuments({ referenceId: normalReservation.settlementReference })
        };

        const retryRequestId = `retry-${Date.now()}`;
        state.behaviorByRequest.set(retryRequestId, ['retryable', 'success']);
        await admit(retryRequestId);
        const retryShipment = await waitForShipmentStatus(retryRequestId, PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        const retryJob = await livePartnerBookingQueue.getJob(
            makeDeterministicJobId(await PartnerApiOutboxEvent.findById(retryShipment.outboxEventId))
        );
        evidence.scenarios.delayedRetry = {
            shipmentProcessingStatus: retryShipment.processingStatus,
            carrierCalls: state.calls.filter((call) => call.partnerRequestId === retryRequestId).length,
            jobAttemptsMade: retryJob ? retryJob.attemptsMade : null
        };

        const deadLetterRequestId = `dead-${Date.now()}`;
        state.behaviorByRequest.set(deadLetterRequestId, ['retryable', 'retryable']);
        await admit(deadLetterRequestId);
        let deadShipment;
        try {
            deadShipment = await waitForCondition(
                `${deadLetterRequestId} dead letter`,
                async () => {
                    const shipment = await Shipment.findOne({ partnerRequestId: deadLetterRequestId }).lean();
                    return shipment && shipment.carrierBookingStatus === 'DEAD_LETTER' ? shipment : null;
                },
                25000
            );
        } catch (error) {
            const stateSnapshot = await describeRequestState(deadLetterRequestId);
            error.message = `${error.message}. State: ${JSON.stringify(stateSnapshot)}`;
            throw error;
        }
        evidence.scenarios.deadLetter = {
            shipmentProcessingStatus: deadShipment.processingStatus,
            carrierBookingStatus: deadShipment.carrierBookingStatus,
            carrierCalls: state.calls.filter((call) => call.partnerRequestId === deadLetterRequestId).length
        };

        await stopLivePartnerBookingWorker();
        if (extraWorker) {
            await extraWorker.close();
            extraWorker = null;
        }
        const restartRequestId = `restart-${Date.now()}`;
        state.behaviorByRequest.set(restartRequestId, ['success']);
        await admit(restartRequestId);
        await wait(1000);
        const restartBefore = await Shipment.findOne({ partnerRequestId: restartRequestId }).lean();
        await startLivePartnerBookingWorker();
        const restartAfter = await waitForShipmentStatus(restartRequestId, PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        evidence.scenarios.workerRestart = {
            statusBeforeRestart: restartBefore.processingStatus,
            statusAfterRestart: restartAfter.processingStatus,
            carrierCalls: state.calls.filter((call) => call.partnerRequestId === restartRequestId).length
        };

        const unknownRequestId = `unknown-${Date.now()}`;
        state.behaviorByRequest.set(unknownRequestId, ['unknown']);
        await admit(unknownRequestId);
        const reconciledShipment = await waitForShipmentStatus(unknownRequestId, PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        evidence.scenarios.carrierReconciliation = {
            shipmentProcessingStatus: reconciledShipment.processingStatus,
            carrierLookups: state.lookups.filter((lookup) => (
                lookup.merchantReference
                && String(lookup.merchantReference).toLowerCase().includes(unknownRequestId.toLowerCase())
            )).length,
            carrierCalls: state.calls.filter((call) => call.partnerRequestId === unknownRequestId).length
        };

        const concurrency = await Promise.all(
            Array.from({ length: 5 }, () => acquireCarrierPermit('UNITED', { limit: 2, leaseMs: 3000 }))
        );
        const acquired = concurrency.filter((permit) => permit.acquired);
        await Promise.all(concurrency.map((permit) => releaseCarrierPermit(permit)));
        const crashPermit = await acquireCarrierPermit('SKYNET', { limit: 1, leaseMs: 3000 });
        await CarrierConcurrencyLease.updateOne(
            { carrier: 'SKYNET', 'leases.token': crashPermit.token },
            {
                $set: {
                    'leases.$.expiresAt': new Date(Date.now() - 1000),
                    leaseExpiresAt: new Date(Date.now() - 1000)
                }
            }
        );
        const reclaimedPermit = await acquireCarrierPermit('SKYNET', { limit: 1, leaseMs: 3000 });
        const renewable = await acquireCarrierPermit('TPL', { limit: 1, leaseMs: 1000 });
        const renewed = await renewCarrierPermit(renewable, { leaseMs: 5000 });
        await Promise.all([releaseCarrierPermit(reclaimedPermit), releaseCarrierPermit(renewed)]);
        evidence.scenarios.carrierConcurrency = {
            leaseModel: 'single carrier document with individual token leases',
            unitedConfiguredLimit: 2,
            unitedConcurrentAcquired: acquired.length,
            expiredSkynetLeaseReclaimed: reclaimedPermit.acquired,
            tplLeaseRenewed: Boolean(renewed && renewed.expiresAt > renewable.expiresAt)
        };

        const queueCounts = await livePartnerBookingQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
        evidence.totals = {
            livePartnerBookingQueue: queueCounts,
            carrierCalls: state.calls.length,
            carrierLookups: state.lookups.length,
            shipments: await Shipment.countDocuments(),
            walletReservations: await WalletReservation.countDocuments(),
            outboxEvents: await PartnerApiOutboxEvent.countDocuments(),
            transactions: await Transaction.countDocuments()
        };
        evidence.approved = false;
        evidence.warnings.push('Verification uses a safe in-process carrier stub; real RSA, Skynet, TPL, and United staging credentials were not exercised.');
        evidence.warnings.push('HTTP backend server process was not started by this script; the script verifies service, outbox, Redis, BullMQ, and worker paths directly.');

        console.log(JSON.stringify(evidence, null, 2));
    } finally {
        if (extraWorker) await extraWorker.close().catch(() => {});
        if (queueEvents) await queueEvents.close().catch(() => {});
        await Promise.all([
            stopLivePartnerBookingWorker ? stopLivePartnerBookingWorker() : undefined,
            stopCarrierReconciliationWorker ? stopCarrierReconciliationWorker() : undefined,
            stopWalletReconciliationWorker ? stopWalletReconciliationWorker() : undefined
        ].filter(Boolean)).catch(() => {});
        await Promise.all([
            livePartnerBookingQueue && !livePartnerBookingQueue.isMock ? livePartnerBookingQueue.close() : undefined,
            carrierReconciliationQueue && !carrierReconciliationQueue.isMock ? carrierReconciliationQueue.close() : undefined,
            walletReconciliationQueue && !walletReconciliationQueue.isMock ? walletReconciliationQueue.close() : undefined
        ].filter(Boolean)).catch(() => {});
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
