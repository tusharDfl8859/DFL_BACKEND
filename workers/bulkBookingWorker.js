const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const { redisConfig } = require('../config/redisConfig');
const BulkUpload = require('../models/BulkUpload');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const SystemConfig = require('../models/SystemConfig');
const carrierBookingService = require('../services/carriers/CarrierBookingService');
const emailQueue = require('../queues/emailQueue');
const rateCalculator = require('../utils/rateCalculator');
const { calculateRowPrice } = require('../utils/bulkPricingCalculator');
const { mapRowToShipment } = require('../utils/bulkShipmentMapper');
const { sendBookingFailureAlert } = require('../utils/bookingAlertService');

let bulkBookingWorker;

// ─── SOCKET EMIT HELPER ───────────────────────────────────────────────────────
const emitProgress = (targetUserId, data) => {
    try {
        const { getIO } = require('../server');
        const io = getIO();
        if (io) {
            io.emit(`bulk_progress_${targetUserId}`, data);
            io.emit('admin_bulk_progress', data);
        }
    } catch (socketErr) {
        if (data && data.bulkUploadId) {
            const BulkUpload = mongoose.model('BulkUpload');
            BulkUpload.updateOne(
                { _id: data.bulkUploadId },
                { $push: { bookingErrors: { error: `Socket progress emit failed: ${socketErr.message}`, at: new Date() } } }
            ).catch(() => {});
        }
    }
};

// ─── CARRIER API / RSA BOOKING HELPER ───────────────────────────────────────
const executeCarrierBooking = async (shipment, targetUser, provider) => {
    const carrierBookingService = require('../services/carriers/CarrierBookingService');
    const mongoose = require('mongoose');
    const SystemConfig = require('../models/SystemConfig');

    if (!targetUser.kycVerified) {
        shipment.carrierBookingStatus = 'FAILED';
        shipment.carrierBookingError = 'User KYC is pending. Auto-booking blocked.';
        shipment.status = 'Action Required';
        shipment.trackingHistory.push({
            status: 'Action Required',
            location: 'System',
            description: 'Booking blocked. Manual booking required due to pending KYC.',
            timestamp: new Date()
        });
        await shipment.save();
        return;
    }

    // --- UK RSA AUTO-BOOKING LOGIC ---
    if (provider === 'UK-ECONOMY' || provider === 'UK-PRIORITY' || provider === 'RSA' || provider === 'RSAXB') {
        const isUKPriority = provider === 'UK-PRIORITY' || provider === 'RSAXB' || (shipment.serviceDetails?.serviceName || '').toUpperCase().includes('PRIORITY');
        const configKey = isUKPriority ? 'ukPriorityConfig' : 'ukEconomyConfig';
        const configDoc = await SystemConfig.findOne({ key: configKey });
        const rsaEnabled = configDoc ? (configDoc.value.rsaApiEnabled !== false) : true;

        if (rsaEnabled) {
            const startTime = Date.now();
            try {
                const rsaService = require('../services/rsaService');
                const bookingResult = await rsaService.createShipment(shipment);
                const durationMs = Date.now() - startTime;

                shipment.trackingCarrier = bookingResult.carrierName || 'RSA';
                if (shipment.serviceDetails) {
                    shipment.serviceDetails.carrierName = bookingResult.carrierName || 'RSA';
                }
                shipment.carrierBookingId = bookingResult.awbNumber;
                shipment.trackingId = bookingResult.awbNumber;
                if (bookingResult.barcode) {
                    shipment.lastMileAWB = bookingResult.barcode;
                }
                shipment.carrierBookingStatus = 'BOOKED';
                shipment.carrierBookedAt = new Date();

                // Upload label to Cloudinary
                try {
                    const cloudinary = require('cloudinary').v2;
                    const uploadResponse = await cloudinary.uploader.upload(
                        `data:application/pdf;base64,${bookingResult.encodedLabel}`,
                        {
                            folder: 'labels',
                            resource_type: 'raw',
                            public_id: `label_${shipment.shipmentId}_${Date.now()}.pdf`
                        }
                    );
                    shipment.carrierLabelUrl = uploadResponse.secure_url;
                    shipment.lastMileSticker = uploadResponse.secure_url;
                } catch (uploadError) {
                    console.error(`Failed to upload bulk booking label for shipment ${shipment?.shipmentId}:`, uploadError);
                }

                shipment.trackingHistory.unshift({
                    status: 'Shipment Created',
                    location: shipment.shipperDetails?.city || 'Origin',
                    timestamp: new Date(),
                    description: `Tracking ID assigned: ${bookingResult.awbNumber}`
                });

                const CarrierBookingLog = mongoose.model('CarrierBookingLog');
                await CarrierBookingLog.create({
                    shipment: shipment._id,
                    carrier: 'RSA (DIRECT)',
                    action: 'BOOK',
                    success: true,
                    httpStatus: 200,
                    awbNo: bookingResult.awbNumber,
                    request: bookingResult.requestPayload || {},
                    response: bookingResult.responsePayload || { awb: bookingResult.awbNumber, carrier: bookingResult.carrierName },
                    durationMs
                }).catch(e => console.error('Failed to log CarrierBookingLog:', e.message));

                await shipment.save();
                return;
            } catch (rsaError) {
                const durationMs = Date.now() - startTime;
                shipment.carrierBookingStatus = 'FAILED';
                shipment.carrierBookingError = rsaError.message;
                shipment.status = 'Action Required';
                shipment.trackingHistory.push({
                    status: 'Action Required',
                    location: 'System',
                    description: 'RSA Auto-booking failed. Manual booking required.',
                    timestamp: new Date()
                });
                await shipment.save();

                // Send alert email
                sendBookingFailureAlert(
                    shipment.shipmentId,
                    'RSA (DIRECT)',
                    rsaError.message,
                    { request: rsaError.requestPayload, response: rsaError.responsePayload }
                );

                // [BYPASSED] Carrier booking failures should not fail the bulk upload row.
                // The shipment itself has been created successfully in DFL.
                /*
                if (shipment.bulkUploadId) {
                    await BulkUpload.updateOne(
                        { _id: shipment.bulkUploadId, "uploadedData.invoice_no": shipment.shipmentDetails?.invoiceNumber },
                        { 
                            $set: { 
                                "uploadedData.$.status": "Failed",
                                "uploadedData.$.error": rsaError.message
                            },
                            $inc: { 
                                "progress.completed": -1,
                                "progress.failed": 1
                            }
                        }
                    );
                }
                */

                const CarrierBookingLog = mongoose.model('CarrierBookingLog');
                await CarrierBookingLog.create({
                    shipment: shipment._id,
                    carrier: 'RSA (DIRECT)',
                    action: 'BOOK',
                    success: false,
                    httpStatus: rsaError.status || 500,
                    errorMessage: rsaError.message,
                    request: rsaError.requestPayload || {},
                    response: rsaError.responsePayload || {},
                    durationMs
                }).catch(e => console.error('Failed to log CarrierBookingLog:', e.message));
                return;
            }
        }
    }

    // --- OTHER API CARRIERS ---
    if (carrierBookingService.supportsApiBooking(provider)) {
        try {
            const bookingResult = await carrierBookingService.book(shipment, targetUser, provider);
            if (bookingResult.success) {
                shipment.trackingId = bookingResult.awb || shipment.shipmentId;
                shipment.carrierBookingId = bookingResult.awb;
                shipment.carrierBookingStatus = 'BOOKED';
                shipment.carrierLabel = bookingResult.label;
                shipment.carrierLabelUrl = bookingResult.labelUrl;
                shipment.lastMileSticker = bookingResult.labelUrl;
                if (bookingResult.forwardingNo) {
                    shipment.lastMileAWB = bookingResult.forwardingNo;
                }
            } else {
                shipment.carrierBookingStatus = 'FAILED';
                shipment.carrierBookingError = bookingResult.error;
                shipment.status = 'Action Required';
                shipment.trackingHistory.push({
                    status: 'Action Required',
                    location: 'System',
                    description: `API Booking failed: ${bookingResult.error}`,
                    timestamp: new Date()
                });

                // Send alert email
                sendBookingFailureAlert(
                    shipment.shipmentId,
                    provider,
                    bookingResult.error,
                    { request: bookingResult.requestPayload, response: bookingResult.responsePayload }
                );
            }
            await shipment.save();
        } catch (error) {
            shipment.carrierBookingStatus = 'FAILED';
            shipment.carrierBookingError = error.message;
            shipment.status = 'Action Required';
            shipment.trackingHistory.push({
                status: 'Action Required',
                location: 'System',
                description: `API Booking crashed: ${error.message}`,
                timestamp: new Date()
            });
            await shipment.save();

            // Send alert email
            sendBookingFailureAlert(
                shipment.shipmentId,
                provider,
                error.message,
                { request: error.requestPayload, response: error.responseData }
            );

            // Create a CarrierBookingLog to capture the crash details in DB
            try {
                const CarrierBookingLog = mongoose.model('CarrierBookingLog');
                await CarrierBookingLog.create({
                    shipment: shipment._id,
                    carrier: provider,
                    action: 'BOOK',
                    success: false,
                    httpStatus: error.statusCode || error.status || 500,
                    errorMessage: error.message,
                    request: {},
                    response: error.responseData || { message: error.message },
                    durationMs: 0
                });
            } catch (logErr) {
                console.error(`Failed to create carrier booking log for bulk shipment ${shipment?.shipmentId}:`, logErr);
            }
        }
    }
};

// ─── BATCH FLUSH HELPER ────────────────────────────────────────────────────
const flushBatch = async (bulkUploadId, bulkWriteOps, shipmentDocs, transactionDocs, batchDeductAmount, targetUser) => {
    try {
        if (batchDeductAmount > 0) {
            const updatedUser = await User.findOneAndUpdate(
                { _id: targetUser._id, walletBalance: { $gte: batchDeductAmount } },
                { $inc: { walletBalance: -batchDeductAmount } },
                { new: true, runValidators: false }
            );
            if (!updatedUser) {
                bulkWriteOps.length = 0;
                shipmentDocs.length = 0;
                transactionDocs.length = 0;
                return false;
            }
            targetUser.walletBalance = updatedUser.walletBalance;
        }

        if (shipmentDocs.length > 0) {
            await Shipment.insertMany(shipmentDocs, { ordered: false });
        }
        if (transactionDocs.length > 0) {
            await Transaction.insertMany(transactionDocs, { ordered: false });
        }
        if (bulkWriteOps.length > 0) {
            await BulkUpload.bulkWrite(bulkWriteOps);
        }

        bulkWriteOps.length = 0;
        shipmentDocs.length = 0;
        transactionDocs.length = 0;
        return true;

    } catch (error) {
        bulkWriteOps.length = 0;
        shipmentDocs.length = 0;
        transactionDocs.length = 0;
        return false;
    }
};

// ─── MAIN PROCESS FUNCTION ───────────────────────────────────────────────────
const processBulkBooking = async (job) => {
    const { bulkUploadId, adminId } = job?.data || {};

    // 1. Load bulk upload
    const bulkUpload = await BulkUpload.findById(bulkUploadId).populate('user');
    if (!bulkUpload) return;

    // 2. Safety check for user
    let targetUser = bulkUpload.user;
    if (!targetUser || typeof targetUser?.walletBalance === 'undefined' || !(targetUser instanceof mongoose.Model)) {
        const userId = (targetUser && targetUser._id) ? targetUser._id : bulkUpload.user;
        targetUser = await User.findById(userId);
        if (!targetUser) {
            bulkUpload.bookingStatus = 'Failed';
            bulkUpload.bookingErrors.push({ error: 'Associated user could not be found or loaded.', at: new Date() });
            await bulkUpload.save();
            throw new Error('User data inaccessible');
        }
        bulkUpload.user = targetUser;
    }

    const rows = bulkUpload.uploadedData;

    // 3. Init stats
    bulkUpload.bookingStatus = 'In Progress';
    bulkUpload.progress.total = rows.length;
    bulkUpload.progress.completed = 0;
    bulkUpload.progress.failed = 0;
    bulkUpload.bookingErrors = [];
    await bulkUpload.save();

    // 4. Pre-load shared data
    await rateCalculator.loadData();

    let surchargeConfig = null;
    try {
        const config = await SystemConfig.findOne({ key: 'surchargeConfig' });
        if (config) surchargeConfig = config.value;
    } catch (err) {
        bulkUpload.bookingErrors.push({
            error: `Failed to load surchargeConfig from database: ${err.message}`,
            at: new Date()
        });
        await bulkUpload.save().catch(() => {});
    }

    // ─── PHASE 1: FAST LOOP — Pricing + Wallet + Shipment Save ───────────────
    const CONCURRENCY = 7;
    const BATCH_FLUSH_SIZE = 10;

    // Step A: Parallel pricing
    const pricingPromises = rows.map(async (row, i) => {
        if (row.status === 'Rejected' || row.status === 'Success') {
            return { skip: true, i };
        }
        if (row.status === 'Processing') {
            const invVal = row.invoice_no;
            const queryInv = [invVal, String(invVal)];
            const num = Number(invVal);
            if (!isNaN(num)) queryInv.push(num);

            const existingShipment = await Shipment.findOne({
                'shipmentDetails.invoiceNumber': { $in: queryInv },
                user: targetUser._id
            });
            if (existingShipment) return { skip: true, i };
        }
        if (row.validationError) {
            return { skip: false, i, validationError: row.validationError };
        }
        try {
            const pricingResult = await calculateRowPrice(row, targetUser, surchargeConfig, bulkUpload.bulkType || 'DFL');
            return { skip: false, i, pricingResult, row };
        } catch (err) {
            return { skip: false, i, pricingError: err.message, row };
        }
    });

    const allPricingResults = [];
    for (let start = 0; start < pricingPromises.length; start += CONCURRENCY) {
        const batch = await Promise.all(pricingPromises.slice(start, start + CONCURRENCY));
        allPricingResults.push(...batch);
    }

    // Calculate total required balance for valid orders
    let totalRequiredAmount = 0;
    for (const result of allPricingResults) {
        if (!result.skip && !result.validationError && !result.pricingError && result.pricingResult) {
            totalRequiredAmount += result.pricingResult.finalPrice;
        }
    }

    // Step B: Upfront wallet balance reservation or crash recovery skip
    if (bulkUpload.reservedAmount && bulkUpload.reservedAmount > 0) {
        // [CRASH RECOVERY] Skip balance deduction if funds were already reserved in a previous attempt
        totalRequiredAmount = bulkUpload.reservedAmount;
    } else if (totalRequiredAmount > 0) {
        const isInsufficient = targetUser.walletBalance < totalRequiredAmount;
        const proceedPartial = bulkUpload.proceedWithAvailableBalance && isInsufficient;

        // If we proceed with available balance, we reserve whatever the user has (up to totalRequiredAmount)
        const reserveAmount = proceedPartial
            ? Math.max(0, targetUser.walletBalance)
            : totalRequiredAmount;

        // If reserveAmount is 0 (user has no money), or we are NOT in proceedPartial and balance is insufficient
        if (reserveAmount <= 0 || (!proceedPartial && isInsufficient)) {
            const errorMsg = `Insufficient wallet balance. This bulk upload requires ₹${totalRequiredAmount.toFixed(2)}, but your current balance is ₹${targetUser.walletBalance.toFixed(2)}.`;
            const failOps = rows.map((row, i) => {
                if (row.status === 'Rejected' || row.status === 'Success') return null;
                const rowIndex = i + 2;
                return {
                    updateOne: {
                        filter: { _id: bulkUploadId },
                        update: {
                            $set: {
                                [`uploadedData.${i}.status`]: 'Failed',
                                [`uploadedData.${i}.error`]: errorMsg
                            },
                            $inc: { 'progress.failed': 1 },
                            $push: {
                                bookingErrors: {
                                    rowIndex,
                                    invoiceNo: row?.invoice_no,
                                    error: errorMsg,
                                    at: new Date()
                                }
                            }
                        }
                    }
                };
            }).filter(Boolean);

            if (failOps.length > 0) {
                await BulkUpload.bulkWrite(failOps);
            }

            await BulkUpload.updateOne(
                { _id: bulkUploadId },
                { $set: { bookingStatus: 'Failed', processedAt: new Date() } }
            );

            emitProgress(targetUser._id, {
                bulkUploadId: bulkUpload._id,
                bulkOrderId: bulkUpload.bulkOrderId,
                progress: {
                    total: rows.length,
                    completed: 0,
                    failed: rows.length
                },
                bookingStatus: 'Failed',
                processedAt: new Date()
            });

            return;
        }

        // [UPFRONT RESERVATION] Atomically reserve the calculated reserveAmount
        const updatedUser = await User.findOneAndUpdate(
            { _id: targetUser._id, walletBalance: { $gte: reserveAmount } },
            { $inc: { walletBalance: -reserveAmount } },
            { new: true, runValidators: false }
        );
        if (!updatedUser) {
            const errorMsg = `Wallet reservation failed. Please check your balance and try again.`;
            const failOps = rows.map((row, i) => {
                if (row.status === 'Rejected' || row.status === 'Success') return null;
                const rowIndex = i + 2;
                return {
                    updateOne: {
                        filter: { _id: bulkUploadId },
                        update: {
                            $set: {
                                [`uploadedData.${i}.status`]: 'Failed',
                                [`uploadedData.${i}.error`]: errorMsg
                            },
                            $inc: { 'progress.failed': 1 },
                            $push: {
                                bookingErrors: {
                                    rowIndex,
                                    invoiceNo: row?.invoice_no,
                                    error: errorMsg,
                                    at: new Date()
                                }
                            }
                        }
                    }
                };
            }).filter(Boolean);

            if (failOps.length > 0) {
                await BulkUpload.bulkWrite(failOps);
            }

            await BulkUpload.updateOne(
                { _id: bulkUploadId },
                { $set: { bookingStatus: 'Failed', processedAt: new Date() } }
            );

            emitProgress(targetUser._id, {
                bulkUploadId: bulkUpload._id,
                bulkOrderId: bulkUpload.bulkOrderId,
                progress: {
                    total: rows.length,
                    completed: 0,
                    failed: rows.length
                },
                bookingStatus: 'Failed',
                processedAt: new Date()
            });

            return;
        }

        // Store the reserved amount in the bulk upload document for crash safety
        await BulkUpload.updateOne(
            { _id: bulkUpload._id },
            { $set: { reservedAmount: reserveAmount } }
        );
        bulkUpload.reservedAmount = reserveAmount;
        targetUser.walletBalance = updatedUser.walletBalance;
    }

        // Pre-fetch all existing shipments for the uploaded invoices to save 99 separate database queries
        const invoiceNos = rows.map(r => r.invoice_no).filter(Boolean);
        // Map to both string and number representations to handle type differences in MongoDB queries
        const queryInvoiceNos = [];
        invoiceNos.forEach(inv => {
            queryInvoiceNos.push(inv);
            queryInvoiceNos.push(String(inv));
            const num = Number(inv);
            if (!isNaN(num)) {
                queryInvoiceNos.push(num);
            }
        });

        const existingShipments = await Shipment.find({
            'shipmentDetails.invoiceNumber': { $in: queryInvoiceNos },
            user: targetUser._id
        });
        const existingInvoiceSet = new Set(existingShipments.map(s => String(s.shipmentDetails?.invoiceNumber || '').trim()));

        // Batch accumulators
        let bulkWriteOps = [];
        let shipmentDocs = [];
        let transactionDocs = [];
        let processedSinceFlush = 0;
        let carrierJobs = [];

        // [VIRTUAL BALANCE] Local variable to track virtual balance (user balance before reservation hold)
        let cachedBalance = targetUser.walletBalance + (bulkUpload.reservedAmount || 0);
        let batchDeductAmount = 0;

        for (const result of allPricingResults) {
            const { i, skip, row, pricingResult, pricingError, validationError } = result;
            const rowIndex = i + 2;

            if (skip) continue;

            if (validationError) {
                bulkWriteOps.push({
                    updateOne: {
                        filter: { _id: bulkUploadId },
                        update: {
                            $set: {
                                [`uploadedData.${i}.status`]: 'Failed',
                                [`uploadedData.${i}.error`]: validationError
                            },
                            $inc: { 'progress.failed': 1 },
                            $push: {
                                bookingErrors: {
                                    rowIndex,
                                    invoiceNo: row?.invoice_no,
                                    error: validationError,
                                    at: new Date()
                                }
                            }
                        }
                    }
                });
                bulkUpload.progress.failed += 1;
                rows[i].status = 'Failed';
                processedSinceFlush++;

            } else if (pricingError) {
                bulkWriteOps.push({
                    updateOne: {
                        filter: { _id: bulkUploadId },
                        update: {
                            $set: {
                                [`uploadedData.${i}.status`]: 'Failed',
                                [`uploadedData.${i}.error`]: pricingError
                            },
                            $inc: { 'progress.failed': 1 },
                            $push: {
                                bookingErrors: {
                                    rowIndex,
                                    invoiceNo: row?.invoice_no,
                                    error: pricingError,
                                    at: new Date()
                                }
                            }
                        }
                    }
                });
                bulkUpload.progress.failed += 1;
                rows[i].status = 'Failed';
                processedSinceFlush++;

            } else {
                try {
                    const { finalPrice, chargeableWeight } = pricingResult;

                    row.shipping_price = finalPrice;
                    row.package_weight = row.package_weight || 0;
                    row.chargeable_weight = chargeableWeight;

                    // Check in-memory Set to avoid sequential database queries
                    /*
                    if (existingInvoiceSet.has(String(row.invoice_no || '').trim())) {
                        rows[i].status = 'Success';
                        bulkUpload.progress.completed += 1;
                        bulkWriteOps.push({
                            updateOne: {
                                filter: { _id: bulkUploadId },
                                update: {
                                    $set: {
                                        [`uploadedData.${i}.status`]: 'Success'
                                    },
                                    $inc: { 'progress.completed': 1 }
                                }
                            }
                        });
                        continue;
                    }
                    */


                const shipmentData = mapRowToShipment(row, targetUser, bulkUpload, pricingResult);
                const priceValue = finalPrice;
                const provider = shipmentData?.serviceDetails?.provider;

                // Row-by-row balance validation
                if (cachedBalance < priceValue) {
                    throw new Error(`Insufficient wallet balance. This shipment costs ₹${priceValue.toFixed(2)}, but remaining bulk balance is ₹${cachedBalance.toFixed(2)}.`);
                }

                    bulkUpload.markModified('uploadedData');

                    // Virtual calculation: already reserved, tracking local availability for order logic
                    cachedBalance -= priceValue;

                    transactionDocs.push({
                        user: targetUser._id,
                        amount: -priceValue,
                        type: 'debit',
                        description: `Bulk Booking: ${shipmentData.shipmentId}`,
                        referenceId: shipmentData.shipmentId,
                        status: 'success',
                        balanceAfter: cachedBalance
                    });

                    shipmentDocs.push(shipmentData);
                    carrierJobs.push({ shipmentId: shipmentData.shipmentId, provider });

                    bulkWriteOps.push({
                        updateOne: {
                            filter: { _id: bulkUploadId },
                            update: {
                                $set: {
                                    [`uploadedData.${i}.status`]: 'Success',
                                    [`uploadedData.${i}.shipping_price`]: finalPrice,
                                    [`uploadedData.${i}.chargeable_weight`]: chargeableWeight
                                },
                                $inc: { 'progress.completed': 1 }
                            }
                        }
                    });

                    rows[i].status = 'Success';
                    bulkUpload.progress.completed += 1;
                    processedSinceFlush++;

                } catch (err) {
                    bulkUpload.progress.failed += 1;

                    bulkWriteOps.push({
                        updateOne: {
                            filter: { _id: bulkUploadId },
                            update: {
                                $set: {
                                    [`uploadedData.${i}.status`]: 'Failed',
                                    [`uploadedData.${i}.error`]: err.message
                                },
                                $inc: { 'progress.failed': 1 },
                                $push: {
                                    bookingErrors: {
                                        rowIndex,
                                        invoiceNo: row?.invoice_no,
                                        error: err.message,
                                        at: new Date()
                                    }
                                }
                            }
                        }
                    });

                    rows[i].status = 'Failed';
                    rows[i].error = err.message;
                    processedSinceFlush++;
                }
            }

            // Flush every BATCH_FLUSH_SIZE rows
            if (processedSinceFlush >= BATCH_FLUSH_SIZE) {
                // [BATCH DATABASE SAVE] Save shipments and transactions without double-deducting from wallet
                const flushSuccess = await flushBatch(bulkUploadId, bulkWriteOps, shipmentDocs, transactionDocs, 0, targetUser);
                batchDeductAmount = 0;
                if (!flushSuccess) {
                    throw new Error('Wallet deduction failed. Job stopped.');
                }
                processedSinceFlush = 0;

                const jobsToFire = carrierJobs.splice(0, carrierJobs.length);
                if (jobsToFire.length > 0) {
                    setImmediate(async () => {
                        // Process API calls sequentially to avoid Skynet rate limit / WAF blocking (HTTP 403)
                        for (const job of jobsToFire) {
                            try {
                                const shipment = await Shipment.findOne({ shipmentId: job.shipmentId });
                                if (shipment) {
                                    await executeCarrierBooking(shipment, targetUser, job.provider);
                                }
                                // Small sleep between calls to prevent rate limit triggers
                                await new Promise(resolve => setTimeout(resolve, 500));
                            } catch (carrierErr) {
                                const BulkUpload = mongoose.model('BulkUpload');
                                await BulkUpload.updateOne(
                                    { _id: bulkUploadId },
                                    { $push: { bookingErrors: { error: `Background carrier booking failed for shipment ${job.shipmentId}: ${carrierErr.message}`, at: new Date() } } }
                                ).catch(() => {});
                            }
                        }
                    });
                }

                emitProgress(targetUser._id, {
                    bulkUploadId: bulkUpload._id,
                    bulkOrderId: bulkUpload.bulkOrderId,
                    progress: bulkUpload.progress,
                    bookingStatus: 'In Progress',
                    lastRowIndex: allPricingResults.indexOf(result) + 1,
                    totalRows: rows.length
                });
            }
        }

        // Final flush for remaining rows
        if (processedSinceFlush > 0 || bulkWriteOps.length > 0) {
            // [FINAL DATABASE SAVE] Flush any remaining processed rows without wallet deduction
            const flushSuccess = await flushBatch(bulkUploadId, bulkWriteOps, shipmentDocs, transactionDocs, 0, targetUser);
            batchDeductAmount = 0;
            if (!flushSuccess) {
                throw new Error('Wallet deduction failed. Job stopped.');
            }

            const jobsToFire = carrierJobs.splice(0, carrierJobs.length);
            if (jobsToFire.length > 0) {
                setImmediate(async () => {
                    // Process API calls sequentially to avoid Skynet rate limit / WAF blocking (HTTP 403)
                    for (const job of jobsToFire) {
                        try {
                            const shipment = await Shipment.findOne({ shipmentId: job.shipmentId });
                            if (shipment) {
                                await executeCarrierBooking(shipment, targetUser, job.provider);
                            }
                            // Small sleep between calls to prevent rate limit triggers
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (carrierErr) {
                            const BulkUpload = mongoose.model('BulkUpload');
                            await BulkUpload.updateOne(
                                { _id: bulkUploadId },
                                { $push: { bookingErrors: { error: `Background carrier booking failed for shipment ${job.shipmentId}: ${carrierErr.message}`, at: new Date() } } }
                            ).catch(() => {});
                        }
                    }
                });
            }
        }

        // [UNRESERVED REFUND] Calculate the final success costs and refund any remaining balance
        const finalBulkUpload = await BulkUpload.findById(bulkUploadId);
        let totalSuccessfulPrice = 0;
        if (finalBulkUpload && finalBulkUpload.uploadedData) {
            for (const r of finalBulkUpload.uploadedData) {
                if (r.status === 'Success') {
                    totalSuccessfulPrice += parseFloat(r.shipping_price) || 0;
                }
            }
        }

        if (finalBulkUpload && finalBulkUpload.reservedAmount > 0) {
            const refundAmount = finalBulkUpload.reservedAmount - totalSuccessfulPrice;
            if (refundAmount > 0) {
                const updatedUser = await User.findOneAndUpdate(
                    { _id: targetUser._id },
                    { $inc: { walletBalance: refundAmount } },
                    { new: true }
                );
                if (updatedUser) {
                    targetUser.walletBalance = updatedUser.walletBalance;
                }

                // Create a refund ledger transaction entry
                await Transaction.create({
                    user: targetUser._id,
                    amount: refundAmount,
                    type: 'credit',
                    description: `Bulk Booking Refund: Failed shipments for ${finalBulkUpload.bulkOrderId}`,
                    referenceId: finalBulkUpload.bulkOrderId,
                    status: 'success',
                    balanceAfter: targetUser.walletBalance
                });
            }

            // Reset the reserved amount tracking field in DB
            await BulkUpload.updateOne(
                { _id: bulkUploadId },
                { $set: { reservedAmount: 0 } }
            );
        }

        // ─── FINAL STATUS ────────────────────────────────────────────────────────
        const finalStatus = bulkUpload.progress.failed > 0
            ? (bulkUpload.progress.completed > 0 ? 'Partial Success' : 'Failed')
            : 'Completed';

        await BulkUpload.updateOne(
            { _id: bulkUploadId },
            {
                $set: {
                    bookingStatus: finalStatus,
                    processedAt: new Date()
                }
            }
        );

        bulkUpload.bookingStatus = finalStatus;
        bulkUpload.processedAt = new Date();

        emitProgress(targetUser._id, {
            bulkUploadId: bulkUpload._id,
            bulkOrderId: bulkUpload.bulkOrderId,
            progress: bulkUpload.progress,
            bookingStatus: finalStatus,
            processedAt: new Date()
        });

        // Single summary email after entire batch finishes
        try {
            await emailQueue.add('send-bulk-summary', {
                type: 'bulk-summary',
                email: targetUser.email,
                bulkOrderId: bulkUpload.bulkOrderId,
                total: bulkUpload.progress.total,
                completed: bulkUpload.progress.completed,
                failed: bulkUpload.progress.failed,
                bookingStatus: finalStatus
            });
        } catch (summaryEmailErr) {
            const BulkUpload = mongoose.model('BulkUpload');
            await BulkUpload.updateOne(
                { _id: bulkUploadId },
                { $push: { bookingErrors: { error: `Failed to queue summary email: ${summaryEmailErr.message}`, at: new Date() } } }
            ).catch(() => {});
        }
    };

    // ─── WORKER INIT ─────────────────────────────────────────────────────────────
    if (process.env.BYPASS_REDIS === 'true') {
        bulkBookingWorker = { on: () => { } };
    } else {
        try {
            bulkBookingWorker = new Worker('bulk-booking', processBulkBooking, {
                connection: redisConfig,
                concurrency: 10
            });

            bulkBookingWorker.on('failed', (job, err) => {
                // Job failed — error stored in BullMQ job record
            });

        } catch (err) {
            throw new Error(`[Bulk Worker Init Failed] Redis connection/worker startup crashed: ${err.message}`);
        }
    }

    module.exports = {
        bulkBookingWorker,
        processBulkBooking
    };