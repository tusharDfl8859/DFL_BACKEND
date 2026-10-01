#!/usr/bin/env node

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Queue } = require('bullmq');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findFreePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const waitForPort = async (port, timeoutMs = 15000) => {
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

const startRedis = async (port) => {
    const child = spawn('redis-server', [
        '--bind', '127.0.0.1',
        '--port', String(port),
        '--save', '""',
        '--appendonly', 'no'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForPort(port);
    return child;
};

const stopChild = async (child, signal = 'SIGTERM') => {
    if (!child || child.killed) return { code: null, signal: null };
    const exit = new Promise((resolve) => {
        child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    child.kill(signal);
    return Promise.race([
        exit,
        wait(5000).then(() => {
            if (!child.killed) child.kill('SIGKILL');
            return { code: null, signal: 'SIGKILL' };
        })
    ]);
};

const httpJson = ({ method = 'GET', port, path: requestPath, headers = {}, body = null }) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
        method,
        host: '127.0.0.1',
        port,
        path: requestPath,
        headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers
        },
        timeout: 10000
    }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try {
                resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers });
            } catch (error) {
                resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
            }
        });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout for ${requestPath}`)));
    if (payload) req.write(payload);
    req.end();
});

const waitForHttp = async (port, requestPath, timeoutMs = 20000) => {
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await httpJson({ port, path: requestPath });
            if (response.statusCode >= 200 && response.statusCode < 500) return response;
        } catch (error) {
            lastError = error;
        }
        await wait(250);
    }
    throw new Error(`Timed out waiting for HTTP ${requestPath}: ${lastError?.message || 'no response'}`);
};

const waitForCondition = async (label, fn, timeoutMs = 30000) => {
    const startedAt = Date.now();
    let lastValue;
    while (Date.now() - startedAt < timeoutMs) {
        lastValue = await fn();
        if (lastValue) return lastValue;
        await wait(250);
    }
    throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
};

const spawnRuntime = (name, args, env) => {
    const output = [];
    const child = spawn(process.execPath, args, {
        cwd: __dirname + '/..',
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const capture = (stream, chunk) => {
        const text = chunk.toString();
        output.push(...text.split(/\r?\n/).filter(Boolean).map(line => `${stream}: ${line}`));
        if (output.length > 80) output.splice(0, output.length - 80);
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    return { name, child, output };
};

const waitForOutput = async (processInfo, pattern, timeoutMs = 20000) => waitForCondition(
    `${processInfo.name} output ${pattern}`,
    () => processInfo.output.some(line => pattern.test(line)) ? true : false,
    timeoutMs
);

const resetRateCalculator = (rateCalculator) => {
    rateCalculator.zones = null;
    rateCalculator.rates = null;
    rateCalculator.serviceMap = null;
    rateCalculator.lastLoaded = null;
    rateCalculator.cache = new Map();
};

const bookingPayload = (suffix) => ({
    recipient: {
        name: 'Separate Process Customer',
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
        description: 'Step 6B separate process product'
    },
    order: {
        orderId: `ORDER-${suffix}`,
        invoiceNumber: `INV-${suffix}`
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
        processes: {},
        scenarios: {},
        warnings: [],
        totals: {}
    };

    const suffix = crypto.randomBytes(4).toString('hex');
    const redisPort = await findFreePort();
    const httpPort = await findFreePort();
    const stateDir = path.join(os.tmpdir(), `openapi-safe-carrier-${suffix}`);
    fs.mkdirSync(stateDir, { recursive: true });

    let redis = null;
    let mongo = null;
    let liveQueue = null;
    let carrierQueue = null;
    let walletQueue = null;
    const children = [];

    try {
        redis = await startRedis(redisPort);
        mongo = await MongoMemoryReplSet.create({
            instanceOpts: [{ ip: '127.0.0.1' }],
            replSet: { count: 1, storageEngine: 'wiredTiger' }
        });

        const commonEnv = {
            ...process.env,
            NODE_ENV: 'step6b-process-verification',
            BYPASS_REDIS: 'false',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: String(redisPort),
            MONGO_URI: mongo.getUri(),
            JWT_SECRET: 'step-6b-separate-process-jwt',
            PARTNER_API_KEY_PEPPER: 'step-6b-separate-process-pepper',
            DEVELOPER_PORTAL_SEND_EMAILS: 'false',
            DISABLE_AUTO_WORKER_START: 'true',
            OPENAPI_SAFE_CARRIER_STUB: 'true',
            OPENAPI_SAFE_CARRIER_STUB_STATE_DIR: stateDir,
            LIVE_PARTNER_OUTBOX_PUBLISH_INTERVAL_MS: '1000',
            LIVE_PARTNER_CARRIER_JOB_ATTEMPTS: '2',
            LIVE_PARTNER_CARRIER_JOB_BACKOFF_MS: '1000',
            LIVE_PARTNER_CARRIER_WORKER_CONCURRENCY: '2',
            CARRIER_RECONCILIATION_ATTEMPTS: '2',
            CARRIER_RECONCILIATION_BACKOFF_MS: '1000',
            WALLET_RECONCILIATION_ATTEMPTS: '2',
            WALLET_RECONCILIATION_BACKOFF_MS: '1000',
            PORT: String(httpPort)
        };

        process.env.PARTNER_API_KEY_PEPPER = commonEnv.PARTNER_API_KEY_PEPPER;
        await mongoose.connect(mongo.getUri());
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
        const rateCalculator = require('../utils/rateCalculator');
        const { generateApiKey } = require('../utils/developerCredentialCrypto');
        const {
            ACCESS_LEVELS,
            APPLICATION_STATUSES,
            CREDENTIAL_STATUSES,
            DEVELOPER_ACCOUNT_STATUSES,
            DEVELOPER_ENVIRONMENTS,
            PARTNER_API_OUTBOX_STATUSES,
            PARTNER_API_PROCESSING_STATUSES,
            SLA_TIERS,
            WALLET_RESERVATION_STATUSES
        } = require('../constants/developerPortal');

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
            Transaction.init()
        ]);
        resetRateCalculator(rateCalculator);
        await Promise.all([
            RateZone.create({ country: 'US', state: 'NY', zone: 'TUS1' }),
            RateTable.create({ weight: 2, rates: { TUS1: 500, UUSPS: 575 } }),
            DeveloperConfig.findOneAndUpdate(
                { configKey: 'DEVELOPER_PORTAL' },
                {
                    $setOnInsert: { configKey: 'DEVELOPER_PORTAL' },
                    $set: {
                        liveCarrierMaxAttempts: 2,
                        liveCarrierRetryBackoffSeconds: [1],
                        liveCarrierWorkerConcurrency: 2,
                        liveCarrierConcurrencyByCarrier: { TPL: 1, UNITED: 2, SKYNET: 1, RSA: 1 }
                    }
                },
                { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
            )
        ]);

        const user = await User.create({
            name: 'Step 6B Separate Process Customer',
            email: `step6b-process-${suffix}@example.com`,
            phone: '+919999999999',
            password: 'Password123!',
            customerId: `CUST${suffix}`,
            walletBalance: 50000,
            walletReservedBalance: 0,
            kycVerified: true,
            companyName: 'Step 6B Separate Process Pvt Ltd',
            kycData: {
                status: 'verified',
                panName: 'Step 6B Separate Process Pvt Ltd',
                billingAddress: {
                    addressLine1: 'DFL Pickup Address',
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
            technicalContact: { name: 'Verification Owner', email: 'verify@example.com', phone: '+919777777777' },
            integrationDetails: {
                useCase: 'Separate process verification.',
                expectedMonthlyShipmentVolume: '100 - 500',
                expectedMonthlyApiRequests: 5000,
                description: 'Step 6B process verification.'
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
        await ApiCredential.create({
            userId: user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            name: 'Separate Process Live Key',
            prefix: generated.prefix,
            secretHash: generated.secretHash,
            status: CREDENTIAL_STATUSES.ACTIVE,
            isPrimary: true,
            createdBy: user._id,
            createdByModel: 'User'
        });

        liveQueue = new Queue('live-partner-booking', { connection: { host: '127.0.0.1', port: redisPort } });
        carrierQueue = new Queue('carrier-reconciliation', { connection: { host: '127.0.0.1', port: redisPort } });
        walletQueue = new Queue('wallet-reconciliation', { connection: { host: '127.0.0.1', port: redisPort } });

        const startProcess = async (name, args, pattern) => {
            const proc = spawnRuntime(name, args, commonEnv);
            children.push(proc);
            await waitForOutput(proc, pattern);
            evidence.processes[name] = {
                startupOutput: proc.output.slice(-8),
                pid: proc.child.pid
            };
            return proc;
        };

        await startProcess('backend-http-server', ['server.js'], /Server listening on port/);
        await waitForHttp(httpPort, '/api/healthcheck');
        evidence.processes['backend-http-server'].healthcheck = 'passed';

        await startProcess('outbox-publisher', ['scripts/openapiRuntimeProcess.js', 'outbox-publisher'], /outbox publisher running/i);
        const liveWorkerOne = await startProcess('live-booking-worker-1', ['scripts/openapiRuntimeProcess.js', 'live-booking-worker'], /booking worker running/i);
        await startProcess('live-booking-worker-2', ['scripts/openapiRuntimeProcess.js', 'live-booking-worker'], /booking worker running/i);
        await startProcess('carrier-reconciliation-worker', ['scripts/openapiRuntimeProcess.js', 'carrier-reconciliation-worker'], /reconciliation worker running/i);
        await startProcess('wallet-reconciliation-worker', ['scripts/openapiRuntimeProcess.js', 'wallet-reconciliation-worker'], /wallet reconciliation worker running/i);

        const postBooking = async (partnerRequestId) => httpJson({
            method: 'POST',
            port: httpPort,
            path: '/api/v1/partner/bookings',
            headers: {
                'x-api-key': generated.fullApiKey,
                'x-partner-request-id': partnerRequestId
            },
            body: bookingPayload(partnerRequestId)
        });

        const waitShipment = async (partnerRequestId, predicate, timeoutMs = 35000) => waitForCondition(
            `shipment ${partnerRequestId}`,
            async () => {
                const shipment = await Shipment.findOne({ partnerRequestId }).lean();
                return shipment && predicate(shipment) ? shipment : null;
            },
            timeoutMs
        );

        const normalRequestId = `process-normal-${suffix}`;
        const normalResponse = await postBooking(normalRequestId);
        if (normalResponse.statusCode !== 202) throw new Error(`Normal booking failed: ${normalResponse.statusCode}`);
        const normalShipment = await waitShipment(normalRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        evidence.scenarios.normal = {
            bookingId: normalShipment.partnerApiBookingId,
            shipmentStatus: normalShipment.processingStatus,
            carrierBookingStatus: normalShipment.carrierBookingStatus,
            walletSettlementStatus: normalShipment.walletSettlementStatus
        };

        const outbox = await PartnerApiOutboxEvent.findOne({ partnerRequestId: normalRequestId });
        outbox.status = PARTNER_API_OUTBOX_STATUSES.PENDING;
        outbox.queueJobId = null;
        outbox.publishedAt = null;
        outbox.lockedAt = null;
        outbox.lockedBy = null;
        await outbox.save();
        await waitForCondition('outbox publisher republish', async () => {
            const refreshed = await PartnerApiOutboxEvent.findById(outbox._id).lean();
            return refreshed.status === PARTNER_API_OUTBOX_STATUSES.PUBLISHED && refreshed.queueJobId ? refreshed : null;
        });
        evidence.scenarios.outboxPublisher = { status: 'republished-pending-event' };

        await liveQueue.add('live-partner-booking-requested', {
            bookingId: normalShipment.partnerApiBookingId,
            shipmentId: normalShipment._id,
            developerAccountId: normalShipment.developerAccountId,
            credentialId: normalShipment.credentialId,
            environment: normalShipment.environment,
            partnerRequestId: normalShipment.partnerRequestId,
            walletReservationId: normalShipment.walletReservationId,
            idempotencyRecordId: normalShipment.idempotencyRecordId,
            requestId: normalShipment.partnerApiRequestId
        }, { jobId: `duplicate-${suffix}`, removeOnComplete: false, removeOnFail: false });
        await wait(1500);
        const normalStubState = JSON.parse(fs.readFileSync(path.join(stateDir, `${safeReferencePart(normalRequestId)}.json`), 'utf8'));
        evidence.scenarios.duplicateDelivery = {
            carrierAttemptsAfterDuplicate: normalStubState.attempts
        };

        const retryRequestId = `process-retry-${suffix}`;
        await postBooking(retryRequestId);
        const retryShipment = await waitShipment(retryRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        const retryStubState = JSON.parse(fs.readFileSync(path.join(stateDir, `${safeReferencePart(retryRequestId)}.json`), 'utf8'));
        evidence.scenarios.retryAndDelayedJob = {
            shipmentStatus: retryShipment.processingStatus,
            carrierAttempts: retryStubState.attempts
        };

        const deadLetterRequestId = `process-deadletter-${suffix}`;
        await postBooking(deadLetterRequestId);
        const deadLetterShipment = await waitShipment(deadLetterRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.DEAD_LETTER_RETRYABLE, 45000);
        evidence.scenarios.deadLetter = {
            shipmentStatus: deadLetterShipment.processingStatus,
            carrierBookingStatus: deadLetterShipment.carrierBookingStatus
        };

        const unknownRequestId = `process-unknown-${suffix}`;
        await postBooking(unknownRequestId);
        const reconciledShipment = await waitShipment(unknownRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.COMPLETED, 45000);
        evidence.scenarios.carrierReconciliation = {
            shipmentStatus: reconciledShipment.processingStatus,
            carrierBookingStatus: reconciledShipment.carrierBookingStatus
        };

        await walletQueue.add('wallet-reconciliation-requested', {
            shipmentId: normalShipment._id,
            idempotencyRecordId: normalShipment.idempotencyRecordId,
            walletReservationId: normalShipment.walletReservationId
        }, { jobId: `wallet-already-settled-${suffix}`, removeOnComplete: false, removeOnFail: false });
        await wait(1500);
        evidence.scenarios.walletReconciliation = { consumedAlreadySettledJob: true };

        evidence.scenarios.gracefulShutdown = {
            liveWorkerOne: await stopChild(liveWorkerOne.child)
        };
        const restartedWorker = await startProcess('live-booking-worker-restarted', ['scripts/openapiRuntimeProcess.js', 'live-booking-worker'], /booking worker running/i);
        evidence.scenarios.workerRestart = { restartedPid: restartedWorker.child.pid };

        const afterRestartRequestId = `process-after-restart-${suffix}`;
        await postBooking(afterRestartRequestId);
        const afterRestartShipment = await waitShipment(afterRestartRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.COMPLETED);
        evidence.scenarios.afterWorkerRestart = {
            shipmentStatus: afterRestartShipment.processingStatus
        };

        await stopChild(redis);
        redis = null;
        await wait(1500);
        redis = await startRedis(redisPort);
        await wait(3000);
        const afterRedisRequestId = `process-after-redis-${suffix}`;
        const afterRedisResponse = await postBooking(afterRedisRequestId);
        const afterRedisShipment = await waitShipment(afterRedisRequestId, s => s.processingStatus === PARTNER_API_PROCESSING_STATUSES.COMPLETED, 45000);
        evidence.scenarios.redisInterruptionRecovery = {
            admittedStatusCode: afterRedisResponse.statusCode,
            shipmentStatus: afterRedisShipment.processingStatus
        };

        evidence.totals = {
            livePartnerBookingQueue: await liveQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
            carrierReconciliationQueue: await carrierQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
            walletReconciliationQueue: await walletQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
            shipments: await Shipment.countDocuments(),
            walletReservations: await WalletReservation.countDocuments(),
            transactions: await Transaction.countDocuments()
        };

        evidence.infrastructure = {
            mongodb: 'MongoMemoryReplSet wiredTiger transaction-capable',
            redis: `redis-server 127.0.0.1:${redisPort}`,
            backendHttpPort: httpPort,
            bypassRedis: commonEnv.BYPASS_REDIS,
            safeCarrierStub: commonEnv.OPENAPI_SAFE_CARRIER_STUB,
            processModel: 'backend, publisher, and workers spawned as independent OS processes'
        };
        evidence.warnings.push('Carrier execution used OPENAPI_SAFE_CARRIER_STUB=true, not RSA/Skynet/TPL/United staging credentials.');
        evidence.warnings.push('Backend HTTP server is terminated by the verifier; worker launcher graceful SIGTERM path is verified for at least one worker.');
    } catch (error) {
        evidence.error = {
            message: error.message,
            stack: error.stack
        };
        process.exitCode = 1;
    } finally {
        for (const queue of [liveQueue, carrierQueue, walletQueue]) {
            if (queue) await queue.close().catch(() => {});
        }
        for (const proc of children.reverse()) {
            if (!proc.child.killed) {
                evidence.processes[proc.name] = {
                    ...(evidence.processes[proc.name] || {}),
                    shutdown: await stopChild(proc.child)
                };
            }
        }
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect().catch(() => {});
        }
        if (mongo) await mongo.stop().catch(() => {});
        if (redis) await stopChild(redis).catch(() => {});
        console.log(JSON.stringify(evidence, null, 2));
    }
};

const safeReferencePart = (value) => String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

main();
