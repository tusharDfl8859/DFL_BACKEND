const mongoose = require('mongoose');
const PickupReport = require('../models/PickupReport');
const Shipment = require('../models/Shipment');
const Admin = require('../models/Admin');
const Manifest = require('../models/Manifest');

/**
 * Helper to calculate delay days
 */
const getDelayInfo = (expectedDate, actualDate = new Date()) => {
    if (!expectedDate) return { isDelayed: false, delayDays: 0 };

    const expected = new Date(expectedDate);
    const actual = new Date(actualDate);

    // Normalize dates to midnight for day calculation
    const expectedMidnight = new Date(expected.getFullYear(), expected.getMonth(), expected.getDate());
    const actualMidnight = new Date(actual.getFullYear(), actual.getMonth(), actual.getDate());

    const diffTime = actualMidnight - expectedMidnight;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    return {
        isDelayed: diffDays > 0,
        delayDays: diffDays > 0 ? diffDays : 0
    };
};

/**
 * POST /api/pickup/scan
 * Process barcode scan and record pickup
 */
const scanPickup = async (req, res) => {
    try {
        const { barcode, delayReason, activeManifestId } = req.body;

        if (!barcode || typeof barcode !== 'string' || !barcode.trim()) {
            return res.status(400).json({ success: false, message: 'Barcode or Shipment ID is required' });
        }

        const cleanBarcode = barcode.trim().replace(/^#/, '');

        // 0. Check if cleanBarcode matches a Manifest ID or Manifest AWB Number
        const manifest = await Manifest.findOne({
            $or: [
                { manifestId: cleanBarcode },
                { awbNumber: cleanBarcode }
            ]
        }).populate({
            path: 'shipments',
            select: 'shipmentId trackingId lastMileAWB status pickupStatus pickupDetails shipperDetails createdAt'
        });

        if (manifest) {
            const shipmentsList = (manifest.shipments || []).map(s => {
                const isPicked = (s.pickupDetails && s.pickupDetails.status === 'Picked Up') ||
                                 s.pickupStatus === 'Picked Up' ||
                                 !!s.pickupDetails?.pickedAt;
                return {
                    _id: s._id,
                    shipmentId: s.shipmentId,
                    trackingId: s.trackingId,
                    shipperName: s.shipperDetails?.shipperName || 'N/A',
                    status: s.status,
                    isPickedUp: isPicked
                };
            });

            const isSelfDrop = manifest.pickupType === 'Self-Drop' || manifest.pickupBy === 'Self-Drop' || manifest.pickupType === 'Self Drop' || manifest.pickupBy === 'Self Drop';

            return res.status(200).json({
                success: true,
                isManifest: true,
                manifest: {
                    id: manifest._id,
                    manifestId: manifest.manifestId,
                    awbNumber: manifest.awbNumber,
                    pickupType: manifest.pickupType,
                    pickupBy: manifest.pickupBy,
                    isSelfDrop: isSelfDrop,
                    date: manifest.date,
                    pickupAddress: manifest.pickupAddress,
                    packetCount: manifest.packetCount || shipmentsList.length,
                    shipments: shipmentsList
                },
                message: `Manifest #${manifest.manifestId} loaded (${shipmentsList.length} parcels)`
            });
        }

        // 1. Find shipment by shipmentId or trackingId or lastMileAWB
        const shipment = await Shipment.findOne({
            $or: [
                { shipmentId: cleanBarcode },
                { trackingId: cleanBarcode },
                { lastMileAWB: cleanBarcode }
            ]
        });

        if (!shipment) {
            return res.status(404).json({
                success: false,
                message: `Shipment or Manifest not found for ID: ${cleanBarcode}`
            });
        }

        // Check if shipment belongs to activeManifestId (if provided)
        let inActiveManifest = false;
        if (activeManifestId) {
            const activeManifestDoc = await Manifest.findById(activeManifestId);
            if (activeManifestDoc && Array.isArray(activeManifestDoc.shipments)) {
                inActiveManifest = activeManifestDoc.shipments.some(sId => sId.toString() === shipment._id.toString());
            }
        }

        // 2. Duplicate scan guard & Already Picked Up Check
        const recentScan = await PickupReport.findOne({
            shipmentId: shipment.shipmentId,
            createdAt: { $gte: new Date(Date.now() - 30 * 1000) }
        });

        if (recentScan) {
            return res.status(429).json({
                alreadyPicked: true,
                message: `Duplicate scan! Shipment #${shipment.shipmentId} was scanned ${Math.round((Date.now() - recentScan.createdAt) / 1000)}s ago by ${recentScan.pickedByName}.`
            });
        }

        const existingReport = await PickupReport.findOne({ orderId: shipment._id });
        const PROGRESSED_STATUSES = [
            'Shipment Received at Our Hub',
            'Shipment Dispatched',
            'In Transit',
            'Out for Delivery',
            'Delivered',
            'Received at Destination Hub',
            'Dispute Raised',
            'Dispute Resolved',
            'RTO'
        ];
        const isHubOrFurther = PROGRESSED_STATUSES.includes(shipment.status) || (shipment.hubStatus || '').toLowerCase() === 'received';
        const isAlreadyPickedUp = (shipment.pickupDetails && shipment.pickupDetails.status === 'Picked Up') ||
                                  shipment.pickupStatus === 'Picked Up' ||
                                  !!shipment.pickupDetails?.pickedAt ||
                                  !!existingReport ||
                                  isHubOrFurther;

        if (isAlreadyPickedUp) {
            const pickedBy = existingReport?.pickedByName || shipment.pickupDetails?.rider || shipment.pickupDetails?.pickedByName || 'Agent';
            return res.status(400).json({
                success: false,
                alreadyPicked: true,
                message: `Shipment #${shipment.shipmentId} is ALREADY marked as Picked Up (${pickedBy}).`,
                shipmentId: shipment.shipmentId
            });
        }

        // 3. Check delay condition
        const expectedDate = shipment.shipperDetails?.date || shipment.createdAt;
        const { isDelayed, delayDays } = getDelayInfo(expectedDate);

        // If delayed and delayReason is not provided, prompt frontend for delay reason
        if (isDelayed && !delayReason) {
            return res.status(200).json({
                requiresDelayReason: true,
                shipmentId: shipment.shipmentId,
                customerName: shipment.shipperDetails?.shipperName || shipment.consigneeDetails?.consigneeName || 'N/A',
                expectedPickupDate: expectedDate,
                actualPickupDate: new Date(),
                delayDays: delayDays
            });
        }

        // 4. Create PickupReport entry
        const pickedByName = req.admin ? (req.admin.name || req.admin.email) : 'System Admin';
        const pickedById = req.admin ? req.admin._id : null;

        const pickupReport = await PickupReport.create({
            shipmentId: shipment.shipmentId,
            orderId: shipment._id,
            pickedBy: pickedById,
            pickedByName: pickedByName,
            pickupTime: new Date(),
            expectedPickupDate: expectedDate,
            isDelayed: isDelayed,
            delayDays: delayDays,
            delayReason: delayReason || '',
            location: shipment.shipperDetails?.city || 'Hub',
            syncedAt: new Date()
        });

        // 5. Update Shipment's pickupDetails & trackingHistory
        const actualTimeFormatted = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        shipment.pickupDetails = {
            rider: pickedByName,
            window: '10:00 - 18:00',
            actualTime: actualTimeFormatted,
            status: 'Picked Up',
            delayReason: delayReason || '',
            pickedAt: new Date(),
            pickedBy: pickedById
        };

        if (!Array.isArray(shipment.trackingHistory)) {
            shipment.trackingHistory = [];
        }

        shipment.trackingHistory.push({
            status: 'Shipment Picked Up',
            location: shipment.shipperDetails?.city || 'Hub',
            timestamp: new Date(),
            description: `Picked up by ${pickedByName}${delayReason ? ` (Delay: ${delayDays}d, Reason: ${delayReason})` : ''}`
        });

        await shipment.save();

        // 5.1 Auto-sync parent Manifest status and pickupBy
        const targetManifestId = shipment.manifestId || activeManifestId;
        let parentManifest = null;
        if (targetManifestId) {
            parentManifest = await Manifest.findOne({
                $or: [
                    { _id: mongoose.Types.ObjectId.isValid(targetManifestId) ? targetManifestId : null },
                    { manifestId: targetManifestId }
                ].filter(Boolean)
            }).populate('shipments');
        } else {
            parentManifest = await Manifest.findOne({ shipments: shipment._id }).populate('shipments');
        }

        if (parentManifest) {
            const allManifestShipments = parentManifest.shipments || [];
            const allPickedUp = allManifestShipments.length > 0 && allManifestShipments.every(s => {
                if (s._id.toString() === shipment._id.toString()) return true;
                return (s.pickupDetails && s.pickupDetails.status === 'Picked Up') ||
                       s.pickupStatus === 'Picked Up' ||
                       !!s.pickupDetails?.pickedAt;
            });
            const anyPickedUp = allManifestShipments.some(s => {
                if (s._id.toString() === shipment._id.toString()) return true;
                return (s.pickupDetails && s.pickupDetails.status === 'Picked Up') ||
                       s.pickupStatus === 'Picked Up' ||
                       !!s.pickupDetails?.pickedAt;
            });

            if (allPickedUp) {
                parentManifest.pickupStatus = 'Completed';
            } else if (anyPickedUp) {
                parentManifest.pickupStatus = 'Partially Picked Up';
            }
            if (!parentManifest.pickupBy || parentManifest.pickupBy === 'Self-Drop' || parentManifest.pickupBy === 'DFL Pickup') {
                parentManifest.pickupBy = pickedByName;
                parentManifest.pickupType = 'DFL Pickup';
            }
            await parentManifest.save();
        }

        // 6. Socket.IO Real-time Broadcast
        const io = req.app.get('io');
        if (io) {
            io.emit('pickup_update', {
                action: 'SCAN_SUCCESS',
                report: pickupReport,
                shipmentId: shipment.shipmentId,
                pickupDetails: shipment.pickupDetails,
                manifest: parentManifest ? {
                    id: parentManifest._id,
                    manifestId: parentManifest.manifestId,
                    pickupStatus: parentManifest.pickupStatus,
                    pickupBy: parentManifest.pickupBy
                } : null
            });
        }

        return res.status(200).json({
            success: true,
            inManifest: inActiveManifest,
            message: `Shipment ${shipment.shipmentId} successfully picked up by ${pickedByName}${activeManifestId ? (inActiveManifest ? ' (Verified in Manifest)' : ' (Not in Manifest - Marked Separately)') : ''}`,
            report: pickupReport,
            shipment: {
                shipmentId: shipment.shipmentId,
                customerName: shipment.shipperDetails?.shipperName || 'N/A',
                pickedByName,
                pickupTime: pickupReport.pickupTime,
                isDelayed,
                delayDays,
                delayReason
            }
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to process barcode scan',
            error: error.message
        });
    }
};

/**
 * GET /api/pickup/history
 * Get paginated pickup scan history
 */
const getPickupHistory = async (req, res) => {
    try {
        const {
            from,
            to,
            agentId,
            status,
            search,
            page = 1,
            limit = 20
        } = req.query;

        const query = {};

        // Scope to logged-in user if agent-restricted
        const isSuperAdminOrManager = req.admin && (
            req.admin.role === 'super_admin' ||
            req.admin.role === 'admin' ||
            (req.admin.permissions || []).includes('pickup_reports:manage')
        );

        if (!isSuperAdminOrManager && req.admin) {
            query.pickedBy = req.admin._id;
        } else if (agentId) {
            query.pickedBy = agentId;
        }

        // Date range filter
        if (from || to) {
            query.pickupTime = {};
            if (from) query.pickupTime.$gte = new Date(from);
            if (to) {
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                query.pickupTime.$lte = toDate;
            }
        }

        // Status filter (on-time / delayed)
        if (status === 'delayed') {
            query.isDelayed = true;
        } else if (status === 'on-time' || status === 'ontime') {
            query.isDelayed = false;
        }

        // Search filter by shipment ID or agent name
        if (search && search.trim()) {
            const cleanSearch = search.trim().replace(/^#/, '');
            query.$or = [
                { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                { pickedByName: { $regex: search.trim(), $options: 'i' } }
            ];
        }

        const pageNum = Math.max(1, parseInt(page, 10));
        const limitNum = Math.max(1, parseInt(limit, 10));
        const skip = (pageNum - 1) * limitNum;

        const [history, total] = await Promise.all([
            PickupReport.find(query)
                .populate({
                    path: 'orderId',
                    select: 'shipperDetails consigneeDetails status trackingHistory'
                })
                .sort({ pickupTime: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            PickupReport.countDocuments(query)
        ]);

        return res.status(200).json({
            success: true,
            history,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch pickup history',
            error: error.message
        });
    }
};

/**
 * GET /api/pickup/history/:id
 * Get details of a single pickup scan
 */
const getPickupDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const report = await PickupReport.findById(id)
            .populate('orderId')
            .populate('pickedBy', 'name email designation branch')
            .lean();

        if (!report) {
            return res.status(404).json({ success: false, message: 'Pickup record not found' });
        }

        return res.status(200).json({
            success: true,
            report
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch pickup detail',
            error: error.message
        });
    }
};

/**
 * GET /api/pickup/stats
 * Get pickup statistics (Today's Scans, On Time, Delayed, This Month)
 */
const getPickupStats = async (req, res) => {
    try {
        const now = new Date();

        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const baseQuery = {};
        const isSuperAdminOrManager = req.admin && (
            req.admin.role === 'super_admin' ||
            req.admin.role === 'admin' ||
            (req.admin.permissions || []).includes('pickup_reports:manage')
        );

        if (!isSuperAdminOrManager && req.admin) {
            baseQuery.pickedBy = req.admin._id;
        }

        const [todayTotal, todayOnTime, todayDelayed, thisMonthTotal] = await Promise.all([
            PickupReport.countDocuments({
                ...baseQuery,
                pickupTime: { $gte: startOfToday, $lte: endOfToday }
            }),
            PickupReport.countDocuments({
                ...baseQuery,
                pickupTime: { $gte: startOfToday, $lte: endOfToday },
                isDelayed: false
            }),
            PickupReport.countDocuments({
                ...baseQuery,
                pickupTime: { $gte: startOfToday, $lte: endOfToday },
                isDelayed: true
            }),
            PickupReport.countDocuments({
                ...baseQuery,
                pickupTime: { $gte: startOfMonth }
            })
        ]);

        return res.status(200).json({
            success: true,
            stats: {
                todayScans: todayTotal,
                onTime: todayOnTime,
                delayed: todayDelayed,
                thisMonth: thisMonthTotal
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch pickup stats',
            error: error.message
        });
    }
};

/**
 * POST /api/pickup/manifest-pickup
 * Mark entire manifest and all its constituent orders as Picked Up
 */
const pickupManifestOrders = async (req, res) => {
    try {
        const { manifestId, shipmentIds, delayReason } = req.body;

        if (!manifestId) {
            return res.status(400).json({ success: false, message: 'Manifest ID is required' });
        }

        const cleanManifestId = String(manifestId).trim().replace(/^#/, '');

        const manifest = await Manifest.findOne({
            $or: [
                { _id: mongoose.Types.ObjectId.isValid(cleanManifestId) ? cleanManifestId : null },
                { manifestId: cleanManifestId },
                { awbNumber: cleanManifestId }
            ].filter(Boolean)
        }).populate('shipments');

        if (!manifest) {
            return res.status(404).json({ success: false, message: `Manifest #${cleanManifestId} not found` });
        }

        const pickedByName = req.admin ? (req.admin.name || req.admin.email) : 'System Admin';
        const pickedById = req.admin ? req.admin._id : null;
        const now = new Date();
        const actualTimeFormatted = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        const allShipments = manifest.shipments || [];

        // If shipmentIds array is provided, target only those shipments; otherwise all
        const hasSpecificSelection = Array.isArray(shipmentIds) && shipmentIds.length > 0;
        const targetShipments = hasSpecificSelection
            ? allShipments.filter(s => shipmentIds.includes(s._id.toString()) || shipmentIds.includes(s.shipmentId))
            : allShipments;

        let newlyPickedCount = 0;

        for (const shipment of targetShipments) {
            const isAlreadyPicked = (shipment.pickupDetails && shipment.pickupDetails.status === 'Picked Up') ||
                                    shipment.pickupStatus === 'Picked Up' ||
                                    !!shipment.pickupDetails?.pickedAt;

            if (!isAlreadyPicked) {
                const expectedDate = shipment.shipperDetails?.date || shipment.createdAt;
                const { isDelayed, delayDays } = getDelayInfo(expectedDate, now);

                await PickupReport.create({
                    shipmentId: shipment.shipmentId,
                    orderId: shipment._id,
                    pickedBy: pickedById,
                    pickedByName: pickedByName,
                    pickupTime: now,
                    expectedPickupDate: expectedDate,
                    isDelayed: isDelayed,
                    delayDays: delayDays,
                    delayReason: delayReason || '',
                    location: shipment.shipperDetails?.city || manifest.pickupAddress || 'Hub',
                    syncedAt: now
                });

                shipment.pickupDetails = {
                    rider: pickedByName,
                    window: '10:00 - 18:00',
                    actualTime: actualTimeFormatted,
                    status: 'Picked Up',
                    delayReason: delayReason || '',
                    pickedAt: now,
                    pickedBy: pickedById
                };
                shipment.pickupStatus = 'Picked Up';

                if (!Array.isArray(shipment.trackingHistory)) {
                    shipment.trackingHistory = [];
                }
                shipment.trackingHistory.push({
                    status: 'Shipment Picked Up',
                    location: shipment.shipperDetails?.city || manifest.pickupAddress || 'Hub',
                    timestamp: now,
                    description: `Picked up by ${pickedByName} via Manifest #${manifest.manifestId}${delayReason ? ` (Reason: ${delayReason})` : ''}`
                });

                await shipment.save();
                newlyPickedCount++;
            }
        }

        // Check if all shipments of manifest are now picked up
        const allPickedUp = allShipments.every(s => {
            if (targetShipments.some(ts => ts._id.toString() === s._id.toString())) return true;
            return (s.pickupDetails && s.pickupDetails.status === 'Picked Up') ||
                   s.pickupStatus === 'Picked Up' ||
                   !!s.pickupDetails?.pickedAt;
        });

        // Check if any/all shipments of manifest are picked up
        const anyPickedUp = allShipments.some(s => {
            if (targetShipments.some(ts => ts._id.toString() === s._id.toString())) return true;
            return (s.pickupDetails && s.pickupDetails.status === 'Picked Up') ||
                   s.pickupStatus === 'Picked Up' ||
                   !!s.pickupDetails?.pickedAt;
        });

        if (allPickedUp) {
            manifest.pickupStatus = 'Completed';
            if (!manifest.pickupBy || manifest.pickupBy === 'Self-Drop' || manifest.pickupBy === 'DFL Pickup') {
                manifest.pickupBy = pickedByName;
                manifest.pickupType = 'DFL Pickup';
            }
        } else if (anyPickedUp) {
            manifest.pickupStatus = 'Partially Picked Up';
            if (!manifest.pickupBy || manifest.pickupBy === 'Self-Drop' || manifest.pickupBy === 'DFL Pickup') {
                manifest.pickupBy = pickedByName;
                manifest.pickupType = 'DFL Pickup';
            }
        }
        await manifest.save();

        // Socket.IO Real-time broadcast
        const io = req.app.get('io');
        if (io) {
            io.emit('pickup_update', {
                action: 'MANIFEST_PICKUP_SUCCESS',
                manifestId: manifest.manifestId,
                newlyPickedCount,
                pickedByName,
                manifest: {
                    id: manifest._id,
                    manifestId: manifest.manifestId,
                    pickupStatus: manifest.pickupStatus
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: hasSpecificSelection
                ? `${newlyPickedCount} selected order(s) marked as Picked Up in Manifest #${manifest.manifestId}.`
                : `Manifest #${manifest.manifestId} and all ${allShipments.length} orders marked as Picked Up.`,
            manifest: {
                id: manifest._id,
                manifestId: manifest.manifestId,
                pickupStatus: manifest.pickupStatus,
                totalOrders: allShipments.length,
                newlyPickedOrders: newlyPickedCount,
                allCompleted: allPickedUp
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to complete manifest pickup',
            error: error.message
        });
    }
};

module.exports = {
    scanPickup,
    pickupManifestOrders,
    getPickupHistory,
    getPickupDetail,
    getPickupStats
};
