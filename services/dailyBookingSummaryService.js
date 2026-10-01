const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { getWhatsappConfig } = require('../config/whatsappConfig');
const { sendDailyBookingSummaryNotification } = require('./whatsappService');
const logger = require('../utils/logger');

/**
 * Calculates start (00:00:00.000) and end (23:59:59.999) Date objects in UTC
 * for a target date in the specified IANA timezone.
 */
const getTodayDateBounds = (referenceDate = new Date(), timezone = 'Asia/Kolkata') => {
    const tz = String(timezone || 'Asia/Kolkata').trim();
    
    // Format YYYY-MM-DD in the target timezone
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const businessDateStr = formatter.format(referenceDate);

    // Calculate start and end UTC dates for businessDateStr in target timezone
    const getUtcDate = (dateStr, timeStr) => {
        const utcDate = new Date(`${dateStr}T${timeStr}Z`);
        const localTimeInTz = new Date(utcDate.toLocaleString('en-US', { timeZone: tz }));
        const diffMs = localTimeInTz.getTime() - utcDate.getTime();
        return new Date(utcDate.getTime() - diffMs);
    };

    const start = getUtcDate(businessDateStr, '00:00:00.000');
    const end = getUtcDate(businessDateStr, '23:59:59.999');

    return {
        start,
        end,
        businessDateStr,
        timezone: tz,
    };
};

/**
 * Splits array of booking ID strings into chunked string arrays,
 * where each chunk joined with ", " is <= maxLength chars (default: 900).
 */
const chunkBookingIds = (bookingIds = [], maxLength = 900) => {
    if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
        return [];
    }

    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const rawId of bookingIds) {
        const id = String(rawId || '').trim();
        if (!id) continue;

        const addLength = currentChunk.length === 0 ? id.length : id.length + 2; // +2 for ", "

        if (currentLength + addLength <= maxLength) {
            currentChunk.push(id);
            currentLength += addLength;
        } else {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.join(', '));
            }
            currentChunk = [id];
            currentLength = id.length;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(', '));
    }

    return chunks;
};

/**
 * Core processor for Daily Booking Summary WhatsApp event.
 * Queries today's eligible shipments, groups by customer, and sends summaries.
 */
const processDailyBookingSummaries = async ({ referenceDate = new Date(), timezone = null } = {}) => {
    const config = getWhatsappConfig();
    const targetTz = timezone || config.dailyBookingSummaryTimezone || 'Asia/Kolkata';
    const bounds = getTodayDateBounds(referenceDate, targetTz);

    console.log(`\n[DailyBookingSummary] Starting processing for Date: ${bounds.businessDateStr} (${bounds.timezone})`);
    console.log(`[DailyBookingSummary] UTC Window: ${bounds.start.toISOString()} -> ${bounds.end.toISOString()}`);
    console.log(`[DailyBookingSummary] Config Enabled: ${config.enabled}, Daily Summary Enabled: ${config.dailyBookingSummaryEnabled}`);

    if (!config.enabled || !config.dailyBookingSummaryEnabled) {
        console.log('[DailyBookingSummary] WhatsApp daily summary is DISABLED in config.');
        logger.info('[DailyBookingSummary] WhatsApp daily summary is disabled via configuration.');
        return {
            success: false,
            skipped: true,
            reason: 'WhatsApp daily booking summary notifications are disabled.',
            businessDate: bounds.businessDateStr,
            processedCount: 0,
        };
    }

    // Query eligible shipments created today in configured business timezone
    const eligibleShipments = await Shipment.find({
        status: { $ne: 'Cancelled' },
        cancellationStatus: { $nin: ['CANCELLED', 'REQUESTED'] },
        createdAt: { $gte: bounds.start, $lte: bounds.end },
        user: { $ne: null },
    })
        .populate('user', 'name phone customerId')
        .sort({ createdAt: 1 })
        .lean();

    console.log(`[DailyBookingSummary] Found ${eligibleShipments ? eligibleShipments.length : 0} eligible shipment records created today.`);

    if (!eligibleShipments || eligibleShipments.length === 0) {
        console.log(`[DailyBookingSummary] No eligible bookings found for ${bounds.businessDateStr}. Skipping dispatch.`);
        logger.info(`[DailyBookingSummary] No eligible bookings found for ${bounds.businessDateStr}. Skipping dispatch.`);
        return {
            success: true,
            skipped: false,
            reason: 'No eligible bookings found today.',
            businessDate: bounds.businessDateStr,
            processedCount: 0,
            sentCount: 0,
        };
    }

    // Group bookings by user
    const userBookingMap = new Map();

    for (const shipment of eligibleShipments) {
        if (!shipment.user) continue;

        const userIdStr = String(shipment.user._id || shipment.user);
        const bookingId = String(shipment.shipmentId || '').trim();
        if (!bookingId) continue;

        if (!userBookingMap.has(userIdStr)) {
            userBookingMap.set(userIdStr, {
                user: shipment.user,
                userId: userIdStr,
                bookingIds: [],
            });
        }

        userBookingMap.get(userIdStr).bookingIds.push(bookingId);
    }

    console.log(`[DailyBookingSummary] Grouped bookings into ${userBookingMap.size} unique customer(s).`);

    const results = [];
    let sentCount = 0;

    for (const entry of userBookingMap.values()) {
        const { user, userId, bookingIds } = entry;
        const totalCount = bookingIds.length;
        if (totalCount === 0) continue;

        const customerName = typeof user === 'object' && user?.name ? user.name : 'Customer';
        const phone = typeof user === 'object' && user?.phone ? user.phone : null;

        console.log(`\n[DailyBookingSummary] Processing Customer: ${customerName} (User ID: ${userId}, Phone: ${phone || 'N/A'})`);
        console.log(`[DailyBookingSummary] Total Bookings Today: ${totalCount} -> IDs: ${bookingIds.join(', ')}`);

        const chunks = chunkBookingIds(bookingIds, 900);

        try {
            if (chunks.length <= 1) {
                const formattedIds = chunks[0] || '';
                console.log(`[DailyBookingSummary] Sending single WhatsApp summary message to customer...`);
                const result = await sendDailyBookingSummaryNotification({
                    userId,
                    name: customerName,
                    phone,
                    bookingIdsFormatted: formattedIds,
                    totalCount,
                    businessDate: bounds.businessDateStr,
                    idempotencyKey: `daily-booking-summary:${userId}:${bounds.businessDateStr}`,
                });
                console.log(`[DailyBookingSummary] Dispatch Result for ${customerName}:`, JSON.stringify(result));
                results.push({ userId, totalCount, chunksCount: 1, result });
                if (result?.success) sentCount++;
            } else {
                console.log(`[DailyBookingSummary] Large booking list chunked into ${chunks.length} payload(s). Sending chunked WhatsApp messages...`);
                for (let i = 0; i < chunks.length; i++) {
                    const chunkStr = chunks[i];
                    const result = await sendDailyBookingSummaryNotification({
                        userId,
                        name: customerName,
                        phone,
                        bookingIdsFormatted: chunkStr,
                        totalCount,
                        businessDate: bounds.businessDateStr,
                        idempotencyKey: `daily-booking-summary:${userId}:${bounds.businessDateStr}:${i + 1}`,
                    });
                    console.log(`[DailyBookingSummary] Chunk ${i + 1}/${chunks.length} Dispatch Result for ${customerName}:`, JSON.stringify(result));
                    results.push({ userId, totalCount, chunkIndex: i + 1, chunksCount: chunks.length, result });
                    if (result?.success) sentCount++;
                }
            }
        } catch (customerError) {
            console.error(`[DailyBookingSummary] Exception sending WhatsApp to ${customerName}:`, customerError.message);
            logger.error(`[DailyBookingSummary] Error processing customer ${userId}: ${customerError.message}`);
            results.push({
                userId,
                totalCount,
                error: customerError.message,
            });
        }
    }

    console.log(`\n[DailyBookingSummary] Completed. Processed: ${userBookingMap.size} customer(s), Sent: ${sentCount} message(s).\n`);

    return {
        success: true,
        skipped: false,
        businessDate: bounds.businessDateStr,
        processedCount: userBookingMap.size,
        sentCount,
        results,
    };
};

module.exports = {
    getTodayDateBounds,
    chunkBookingIds,
    processDailyBookingSummaries,
};
