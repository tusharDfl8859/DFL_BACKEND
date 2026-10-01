const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const Announcement = require('../../models/Announcement');
const ActivityLog = require('../../models/ActivityLog');
const CarrierBookingLog = require('../../models/CarrierBookingLog');
const { logActivity } = require('../../utils/activityLogger');
const { getISTDateRange } = require('../../utils/dateUtils');

// @desc    Get Admin Dashboard Stats
// @route   GET /api/admin/dashboard/stats
// @access  Private/Admin
const cacheService = require('../../utils/cacheService');
const rateCalculator = require('../../utils/rateCalculator');

// @desc    Force Refresh Rate Cache
// @route   POST /api/admin/refresh-rates
// @access  Private/Admin
const forceRefreshRates = async (req, res) => {
    try {
        await rateCalculator.forceReload();

        await logActivity(req, {
            action: 'REFRESH_RATES',
            target: 'rate-cache',
            targetModel: 'System',
            details: { triggeredBy: req.admin._id }
        });

        res.json({ message: 'Rate cache refreshed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Admin Dashboard Stats
// @route   GET /api/admin/dashboard/stats
// @access  Private/Admin
const getDashboardStats = async (req, res) => {
    try {
        const { startDate, endDate, date, range, source, excludeSource, isAutoBooking, failedBookings, carrier, shipperCity, consigneeCity, consigneeCountry, destinations, userId, shipmentCategory, carrierBookingStatus } = req.query;

        // --- CACHE CHECK ---
        const destParam = destinations || consigneeCountry || 'none';
        const cacheKey = `dashboard_stats_${range || 'default'}_${startDate || 'default'}_${endDate || 'default'}_${date || 'default'}_${source || 'all'}_${excludeSource || 'none'}_${isAutoBooking || 'false'}_${failedBookings || 'false'}_${carrier || 'all'}_${shipperCity || 'none'}_${consigneeCity || 'none'}_${destParam}_${userId || 'none'}_${shipmentCategory || 'all'}_${carrierBookingStatus || 'all'}_${req.admin._id}_${req.admin.branch || 'default'}`;
        const cachedData = cacheService.get(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        let dateQuery = {};

        if (date) {
            const { start, end } = getISTDateRange(date, date);
            dateQuery.createdAt = {
                $gte: start,
                $lte: end
            };
        } else if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            dateQuery.createdAt = {
                $gte: start,
                $lte: end
            };
        } else if (range) {
            const now = new Date();
            let start = new Date();
            let end = new Date();

            switch (range) {
                case '24h':
                    start.setHours(start.getHours() - 24);
                    dateQuery.createdAt = { $gte: start };
                    break;
                case '7d':
                    start.setDate(start.getDate() - 7);
                    dateQuery.createdAt = { $gte: start };
                    break;
                case '30d':
                    start.setDate(start.getDate() - 30);
                    dateQuery.createdAt = { $gte: start };
                    break;
                case 'this_month':
                    start = new Date(now.getFullYear(), now.getMonth(), 1);
                    dateQuery.createdAt = { $gte: start };
                    break;
                case 'last_month':
                    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    end = new Date(now.getFullYear(), now.getMonth(), 0);
                    end.setHours(23, 59, 59, 999);
                    dateQuery.createdAt = { $gte: start, $lte: end };
                    break;
                case 'all':
                default:
                    break;
            }
        }

        // Role-based filtering
        let shipmentFilter = { ...dateQuery };
        let userFilter = { ...dateQuery };

        if (source && source !== 'All') {
            if (!shipmentFilter.$and) shipmentFilter.$and = [];
            if (source === 'Amazon') {
                shipmentFilter.$and.push({
                    $or: [
                        { source: 'Amazon' },
                        { trackingCarrier: 'Amazon' }
                    ]
                });
            } else {
                shipmentFilter.$and.push({ source: source });
            }
        }

        if (excludeSource) {
            if (!shipmentFilter.$and) shipmentFilter.$and = [];
            shipmentFilter.$and.push({ source: { $ne: excludeSource } });
            shipmentFilter.$and.push({ trackingCarrier: { $ne: 'Amazon' } });
        }

        if (isAutoBooking === 'true') {
            shipmentFilter.carrierBookingStatus = { $in: ['BOOKED', 'FAILED'] };
        }

        if (failedBookings === 'true') {
            shipmentFilter.carrierBookingStatus = 'FAILED';
        } else if (carrierBookingStatus && carrierBookingStatus !== 'All') {
            shipmentFilter.carrierBookingStatus = carrierBookingStatus;
        }

        if (shipperCity) {
            shipmentFilter['shipperDetails.city'] = new RegExp(shipperCity, 'i');
        }
        if (consigneeCity) {
            shipmentFilter['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');
        }

        const destFilterVal = destinations || consigneeCountry;
        if (destFilterVal && destFilterVal !== 'All') {
            const destList = (Array.isArray(destFilterVal) ? destFilterVal : destFilterVal.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                shipmentFilter['consigneeDetails.country'] = { $in: destRegexes };
            }
        }

        if (userId) {
            shipmentFilter.user = userId;
        }

        if (shipmentCategory && shipmentCategory !== 'All') {
            shipmentFilter.$or = [
                { shipmentCategory: shipmentCategory },
                { 'shipmentDetails.shipmentCategory': shipmentCategory }
            ];
        }

        if (carrier && carrier !== 'All') {
            const carrierList = carrier.split(',').map(c => c.trim()).filter(Boolean);
            if (carrierList.length > 0) {
                const expandedCarriers = [];
                for (const c of carrierList) {
                    if (c.toUpperCase() === 'RSA') {
                        expandedCarriers.push('RSA', 'Royal Mail', 'RoyalMail', 'DPD', 'Yodel');
                    } else {
                        expandedCarriers.push(c);
                    }
                }
                const carrierRegexPattern = expandedCarriers.map(c => `(${c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')})`).join('|');
                const carrierRegex = new RegExp(carrierRegexPattern, 'i');
                const carrierFilterObj = {
                    $or: [
                        { 'serviceDetails.carrierName': carrierRegex },
                        { 'trackingCarrier': carrierRegex },
                        { 'serviceDetails.serviceName': carrierRegex }
                    ]
                };
                if (!shipmentFilter.$and) shipmentFilter.$and = [];
                shipmentFilter.$and.push(carrierFilterObj);
            }
        }

        if (req.admin.role === 'member') {
            if (req.admin.designation === 'Regional Head' && req.admin.branch) {
                const regionalUsers = await User.find({
                    $or: [
                        { assignedTo: req.admin._id },
                        { branch: req.admin.branch }
                    ]
                }).select('_id');
                const regionalUserIds = regionalUsers.map(u => u._id);
                shipmentFilter.user = { $in: regionalUserIds };
                userFilter._id = { $in: regionalUserIds };
            } else {
                const assignedUsers = await User.find({ assignedTo: req.admin._id }).select('_id');
                const assignedUserIds = assignedUsers.map(u => u._id);
                shipmentFilter.user = { $in: assignedUserIds };
                userFilter._id = { $in: assignedUserIds };
            }
        }

        // Sales Focus date ranges (always absolute, not filtered)
        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        const fourteenDaysAgo = new Date(today);
        fourteenDaysAgo.setDate(today.getDate() - 14);

        // ============================================================
        // BATCH 1: Run ALL independent queries in parallel
        // ============================================================
        const [
            totalUsers,
            usersRegisteredToday,
            pendingVerifications,
            incompleteKyc,
            shipmentStats,          // combined aggregation: status counts + revenue + total
            recentShipments,
            topDestinations,
            countryDistribution,
            topUsersAgg,
            activeUserIdsInLast10Days,
            bulkShipmentsCount
        ] = await Promise.all([
            // 1. Total users
            User.countDocuments(userFilter),

            // 2. Users registered today
            User.countDocuments({
                ...((req.admin.role === 'member') ? { _id: { $in: userFilter._id?.['$in'] || [] } } : {}),
                createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
            }),

            // 3. Pending verifications
            User.countDocuments({
                ...userFilter,
                'kycData.status': 'pending'
            }),

            // 4. Incomplete KYC
            User.countDocuments({
                ...userFilter,
                $or: [
                    { 'kycData.status': 'not_submitted' },
                    { 'kycData.status': 'rejected' },
                    { kycData: { $exists: false } }
                ]
            }),

            // 5. Combined shipment aggregation: status breakdown + revenue + total count in ONE query
            Shipment.aggregate([
                { $match: shipmentFilter },
                {
                    $facet: {
                        statusBreakdown: [
                            {
                                $group: {
                                    _id: {
                                        $switch: {
                                            branches: [
                                                { case: { $regexMatch: { input: "$status", regex: "^pending$", options: "i" } }, then: "Pending" },
                                                { case: { $regexMatch: { input: "$status", regex: "^processing$", options: "i" } }, then: "Processing" },
                                                { case: { $regexMatch: { input: "$status", regex: "^in transit$", options: "i" } }, then: "In Transit" },
                                                { case: { $regexMatch: { input: "$status", regex: "^out for delivery$", options: "i" } }, then: "Out for Delivery" },
                                                { case: { $regexMatch: { input: "$status", regex: "^delivered$", options: "i" } }, then: "Delivered" },
                                                { case: { $regexMatch: { input: "$status", regex: "^cancelled$", options: "i" } }, then: "Cancelled" },
                                                { case: { $regexMatch: { input: "$status", regex: "^on hold$", options: "i" } }, then: "On Hold" },
                                                { case: { $regexMatch: { input: "$status", regex: "^dispute raised$", options: "i" } }, then: "Dispute Raised" },
                                                { case: { $regexMatch: { input: "$status", regex: "^dispute resolved$", options: "i" } }, then: "Dispute Resolved" }
                                            ],
                                            default: "$status"
                                        }
                                    },
                                    count: { $sum: 1 }
                                }
                            }
                        ],
                        revenue: [
                            {
                                $group: {
                                    _id: null,
                                    total: {
                                        $sum: {
                                            $convert: {
                                                input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                                to: "double",
                                                onError: 0,
                                                onNull: 0
                                            }
                                        }
                                    },
                                    count: { $sum: 1 }
                                }
                            }
                        ]
                    }
                }
            ]),

            // 6. Recent shipments
            Shipment.find(shipmentFilter)
                .sort({ createdAt: -1 })
                .limit(5)
                .populate('user', 'name'),

            // 7. Top destinations
            Shipment.aggregate([
                { $match: shipmentFilter },
                {
                    $group: {
                        _id: { city: "$consigneeDetails.city", country: "$consigneeDetails.country" },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { count: -1 } },
                { $limit: 5 },
                {
                    $project: {
                        _id: { $concat: ["$_id.city", ", ", "$_id.country"] },
                        count: 1
                    }
                }
            ]),

            // 8. Country distribution for heatmap
            Shipment.aggregate([
                { $match: shipmentFilter },
                {
                    $group: {
                        _id: { $toLower: "$consigneeDetails.country" },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { count: -1 } },
                { $limit: 100 }
            ]),

            // 9. Top 5 active customers (last 7 days)
            Shipment.aggregate([
                {
                    $match: {
                        createdAt: { $gte: sevenDaysAgo },
                        ...(req.admin.role === 'member' && userFilter._id ? { user: userFilter._id } : {})
                    }
                },
                {
                    $group: {
                        _id: "$user",
                        currentCount: { $sum: 1 }
                    }
                },
                { $sort: { currentCount: -1 } },
                { $limit: 5 }
            ]),

            // 10. Distinct users who shipped in the last 10 days
            Shipment.distinct('user', {
                createdAt: { $gte: new Date(new Date().setDate(today.getDate() - 10)) },
                ...(req.admin.role === 'member' ? { user: { $in: userFilter._id?.['$in'] || [] } } : {})
            }),

            // 11. Bulk shipments count
            Shipment.countDocuments({
                ...shipmentFilter,
                bulkOrderId: { $ne: null }
            })
        ]);

        const inactiveQuery = { ...userFilter };
        if (inactiveQuery._id && inactiveQuery._id.$in) {
            inactiveQuery._id = {
                $in: inactiveQuery._id.$in.filter(id => !activeUserIdsInLast10Days.some(activeId => activeId.toString() === id.toString()))
            };
        } else {
            inactiveQuery._id = { $nin: activeUserIdsInLast10Days };
        }

        const inactiveUsersCount = await User.countDocuments(inactiveQuery);

        // ============================================================
        // Extract combined results from the $facet aggregation
        // ============================================================
        const facetResult = shipmentStats[0] || { statusBreakdown: [], revenue: [] };
        const statusBreakdown = facetResult.statusBreakdown || [];
        statusBreakdown.push({ _id: 'Bulk', count: bulkShipmentsCount });
        const totalRevenue = facetResult.revenue[0]?.total || 0;
        const totalShipments = facetResult.revenue[0]?.count || 0;

        // Derive individual status counts from the breakdown (no extra queries needed)
        const statusMap = statusBreakdown.reduce((acc, s) => { acc[s._id] = s.count; return acc; }, {});
        const activeShipments = (statusMap['Processing'] || 0) + (statusMap['Shipment Received at Our Hub'] || 0) + (statusMap['In Transit'] || 0) + (statusMap['Scheduled'] || 0) + (statusMap['Out for Delivery'] || 0);
        const deliveredShipments = statusMap['Delivered'] || 0;
        const pendingPickups = statusMap['Pending'] || 0;

        // ============================================================
        // BATCH 2: Sales focus — depends on topUsersAgg result
        // ============================================================
        const topUserIds = topUsersAgg.map(u => u._id);

        const [prevPeriodCounts, userDetails] = await Promise.all([
            Shipment.aggregate([
                {
                    $match: {
                        user: { $in: topUserIds },
                        createdAt: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo }
                    }
                },
                {
                    $group: {
                        _id: "$user",
                        prevCount: { $sum: 1 }
                    }
                }
            ]),
            User.find({ _id: { $in: topUserIds } }).select('name companyName')
        ]);

        const prevCountMap = prevPeriodCounts.reduce((acc, curr) => {
            acc[curr._id.toString()] = curr.prevCount;
            return acc;
        }, {});

        const userMap = userDetails.reduce((acc, user) => {
            acc[user._id.toString()] = user;
            return acc;
        }, {});

        const topActiveCustomers = topUsersAgg.map(stat => {
            const userId = stat._id.toString();
            const prevCount = prevCountMap[userId] || 0;
            const user = userMap[userId] || {};

            return {
                _id: userId,
                name: user.name || 'Unknown User',
                companyName: user.companyName || '',
                count: stat.currentCount,
                prevCount: prevCount,
                isGaining: stat.currentCount > prevCount
            };
        });

        const responseData = {
            totalShipments,
            totalUsers,
            activeShipments,
            deliveredShipments,
            pendingPickups,
            totalRevenue,
            recentShipments,
            usersRegisteredToday,
            pendingVerifications,
            incompleteKyc,
            inactiveUsers: inactiveUsersCount,
            shipmentStats: statusBreakdown,
            topDestinations,
            countryDistribution,
            topActiveCustomers
        };

        // Cache the result for 5 minutes (300 seconds)
        cacheService.set(cacheKey, responseData, 300);
        console.timeEnd('[Dashboard] Total Query Time');

        res.json(responseData);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Announcement System
const createAnnouncement = async (req, res) => {
    try {
        const { title, message, type, priority, link, targetAudience, expiresAt } = req.body;

        const announcementData = {
            title,
            message,
            type,
            priority: priority || 'normal',
            link,
            targetAudience,
            createdBy: req.admin._id
        };

        if (expiresAt) {
            announcementData.expiresAt = expiresAt;
        }

        const announcement = await Announcement.create(announcementData);

        await logActivity(req, {
            action: 'CREATE_ANNOUNCEMENT',
            target: announcement._id,
            targetModel: 'Announcement',
            details: { title: announcement.title, type: announcement.type, createdBy: req.admin._id }
        });

        const io = req.app?.get('io');
        if (io) {
            io.emit('announcements_updated');
        }

        res.status(201).json(announcement);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAllAnnouncements = async (req, res) => {
    try {
        const announcements = await Announcement.find({})
            .sort({ createdAt: -1 })
            .populate('createdBy', 'name');
        res.json(announcements);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const deleteAnnouncement = async (req, res) => {
    try {
        const { id } = req.params;
        const announcement = await Announcement.findById(id);
        if (!announcement) {
            return res.status(404).json({ message: 'Announcement not found' });
        }
        await announcement.deleteOne();
        await logActivity(req, {
            action: 'DELETE_ANNOUNCEMENT',
            target: id,
            targetModel: 'Announcement',
            details: { title: announcement.title, deletedBy: req.admin._id }
        });

        const io = req.app?.get('io');
        if (io) {
            io.emit('announcements_updated');
        }

        res.json({ message: 'Announcement removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const toggleAnnouncement = async (req, res) => {
    try {
        const { id } = req.params;
        const announcement = await Announcement.findById(id);
        if (announcement) {
            const oldStatus = announcement.isActive;
            announcement.isActive = !announcement.isActive;
            await announcement.save();
            await logActivity(req, {
                action: 'TOGGLE_ANNOUNCEMENT_STATUS',
                target: announcement._id,
                targetModel: 'Announcement',
                details: { title: announcement.title, oldStatus, newStatus: announcement.isActive }
            });

            const io = req.app?.get('io');
            if (io) {
                io.emit('announcements_updated');
            }

            res.json(announcement);
        } else {
            res.status(404).json({ message: 'Announcement not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Activity Logs
// @route   GET /api/admin/logs
// @access  Private/Admin
const getLogs = async (req, res) => {
    try {
        const { page = 1, limit = 20, action, startDate, endDate, search, status } = req.query;
        let query = {};

        if (action && action !== 'All') query.action = action;

        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            query.createdAt = {
                $gte: start,
                $lte: end
            };
        }

        if (status && status !== 'All Status') {
            query.status = status;
        }

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            const Admin = require('../../models/Admin');
            const User = require('../../models/User');
            
            const [admins, users] = await Promise.all([
                Admin.find({ $or: [{ name: searchRegex }, { email: searchRegex }] }).select('_id'),
                User.find({ $or: [{ name: searchRegex }, { email: searchRegex }] }).select('_id')
            ]);
            
            const actorIds = [...admins.map(a => a._id), ...users.map(u => u._id)];
            
            query.$or = [
                { action: searchRegex },
                { ipAddress: searchRegex }
            ];
            
            if (actorIds.length > 0) {
                query.$or.push({ actor: { $in: actorIds } });
            }
        }

        const logs = await ActivityLog.find(query)
            .populate('actor', 'name email role')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .lean();

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [count, todayCount, failedCount, activeAdminsAggr] = await Promise.all([
            ActivityLog.countDocuments(query),
            ActivityLog.countDocuments({ ...query, createdAt: { $gte: startOfToday } }),
            ActivityLog.countDocuments({ ...query, status: 'FAILURE' }),
            ActivityLog.aggregate([
                { $match: { createdAt: { $gte: startOfToday }, actorModel: 'Admin' } },
                { $group: { _id: "$actor" } }
            ])
        ]);

        res.json({
            logs,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalLogs: count,
            metrics: {
                totalEvents: count,
                todayEvents: todayCount,
                failedActions: failedCount,
                activeAdmins: activeAdminsAggr.length
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Carrier Booking Logs (API bookings)
// @route   GET /api/admin/carrier-bookings
// @access  Private/Admin
const getCarrierBookingLogs = async (req, res) => {
    try {
        const { page = 1, limit = 20, carrier, success, startDate, endDate, action, search, destinationCountry, destinations } = req.query;
        let query = {};

        if (carrier) query.carrier = carrier;
        if (success !== undefined) query.success = success === 'true';
        if (action) query.action = action;

        if (startDate && endDate) {
            query.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(new Date(endDate).setHours(23, 59, 59, 999))
            };
        }

        // Destination country filter
        const countryFilter = destinationCountry || destinations;
        if (countryFilter) {
            const destList = (Array.isArray(countryFilter) ? countryFilter : countryFilter.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                const matchingDestShipments = await Shipment.find({
                    'consigneeDetails.country': { $in: destRegexes }
                }).select('_id');
                const destShipmentIds = matchingDestShipments.map(s => s._id);
                query.shipment = { $in: destShipmentIds };
            }
        }

        // Search logic
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            // Find shipments matching shipmentId or consigneeName
            const matchingShipments = await Shipment.find({
                $or: [
                    { shipmentId: searchRegex },
                    { trackingId: searchRegex },
                    { lastMileAWB: searchRegex },
                    { 'consigneeDetails.consigneeName': searchRegex }
                ]
            }).select('_id');
            const shipmentIds = matchingShipments.map(s => s._id);
            query.$or = [
                { awbNo: searchRegex },
                { errorMessage: searchRegex }
            ];

            if (shipmentIds.length > 0) {
                query.$or.push({ shipment: { $in: shipmentIds } });
            }
        }

        const [logs, count, stats] = await Promise.all([
            CarrierBookingLog.find(query)
                .populate('shipment', 'shipmentId trackingId lastMileAWB carrierLabelUrl carrierLabel lastMileSticker shipperDetails.shipperName shipperDetails.city consigneeDetails.consigneeName consigneeDetails.city consigneeDetails.country serviceDetails.serviceName serviceDetails.chargeableWeight')
                .sort({ createdAt: -1 })
                .limit(limit * 1)
                .skip((page - 1) * limit)
                .lean(),
            CarrierBookingLog.countDocuments(query),
            CarrierBookingLog.aggregate([
                { $match: startDate && endDate ? query : {} },
                {
                    $group: {
                        _id: { carrier: '$carrier', success: '$success' },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);

        // Format stats
        const formattedStats = stats.reduce((acc, item) => {
            const carrier = item._id.carrier;
            if (!acc[carrier]) acc[carrier] = { success: 0, failed: 0 };
            if (item._id.success) acc[carrier].success = item.count;
            else acc[carrier].failed = item.count;
            return acc;
        }, {});

        res.json({
            logs,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalLogs: count,
            stats: formattedStats
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get System Health Details
// @route   GET /api/admin/system/health
// @access  Private/Admin
const mongoose = require('mongoose');
const { getRedisConnection } = require('../../config/redisConfig');

const getSystemHealth = async (req, res) => {
    try {
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        let dbStatus = 'disconnected';
        try {
            if (mongoose.connection.readyState === 1) {
                dbStatus = 'connected';
            } else if (mongoose.connection.readyState === 2) {
                dbStatus = 'connecting';
            }
        } catch (e) {
            dbStatus = 'error';
        }

        let redisStatus = 'disconnected';
        try {
            const redisClient = getRedisConnection();
            if (redisClient) {
                if (redisClient.constructor.name === 'RedisMock') {
                    redisStatus = 'mocked (in-memory)';
                } else if (redisClient.status === 'ready') {
                    redisStatus = 'connected';
                } else {
                    redisStatus = redisClient.status || 'connecting';
                }
            }
        } catch (e) {
            redisStatus = 'error';
        }

        res.json({
            status: 'healthy',
            timestamp: new Date(),
            uptime: {
                seconds: Math.floor(uptime),
                formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`
            },
            services: {
                database: {
                    status: dbStatus,
                    name: 'MongoDB'
                },
                redis: {
                    status: redisStatus,
                    name: 'Redis Cache'
                }
            },
            system: {
                platform: process.platform,
                nodeVersion: process.version,
                memory: {
                    heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                    heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                    rssMB: Math.round(memoryUsage.rss / 1024 / 1024)
                }
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getGroupedUserSessions = async (actorId, since) => {
    let query = { actor: actorId };
    
    if (since) {
        const startDate = new Date(since);
        const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000); // 24 hours window
        query.createdAt = {
            $gte: startDate,
            $lte: endDate
        };
    }

    const logs = await ActivityLog.find(query)
        .sort({ createdAt: 1 })
        .lean();

    if (logs.length === 0) return [];

    const mapActionToCategory = (action) => {
        const act = action?.toUpperCase() || '';
        if (act.includes('LOGIN') || act.includes('DASHBOARD')) return 'dashboard';
        if (act.includes('SHIPMENT_CREATED') || act.includes('BOOK')) return 'book_shipment';
        if (act.includes('SHIPMENT') && !act.includes('DRAFT')) return 'my_bookings';
        if (act.includes('MANIFEST')) return 'manifests';
        if (act.includes('DRAFT')) return 'drafts';
        if (act.includes('QUOTE') || act.includes('RATE')) return 'rate_calculator';
        if (act.includes('MARKETPLACE') || act.includes('SHOPIFY') || act.includes('EBAY') || act.includes('ETSY') || act.includes('AMAZON')) return 'marketplace';
        if (act.includes('TICKET') || act.includes('SUPPORT') || act.includes('DISPUTE')) return 'support';
        if (act.includes('WALLET') || act.includes('RECHARGE') || act.includes('PAYMENT')) return 'wallet';
        if (act.includes('PROFILE') || act.includes('ADDRESS') || act.includes('SETTING') || act.includes('PASSWORD') || act.includes('KYC') || act.includes('MEMBER') || act.includes('USER') || act.includes('ADMIN')) return 'settings';
        if (act.includes('DEVELOPER') || act.includes('API') || act.includes('WEBHOOK')) return 'api_hub';
        return null;
    };

    const sessions = [];
    let currentSession = null;

    logs.forEach(log => {
        const actionStr = log.action?.toUpperCase() || '';
        const isLoginSuccess = actionStr.includes('LOGIN_SUCCESS');
        const isLogout = actionStr.includes('LOGOUT');

        let startNewSession = false;
        
        if (!currentSession) {
            startNewSession = true;
        } else if (isLoginSuccess) {
            // If a login success occurs and the current session is older than 30 mins, start a new one.
            const timeDiffMin = (new Date(log.createdAt) - new Date(currentSession.startTime)) / (1000 * 60);
            if (timeDiffMin > 30) {
                 startNewSession = true;
            }
        }

        if (startNewSession) {
            if (currentSession) sessions.push(currentSession);
            currentSession = {
                startTime: log.createdAt,
                endTime: null,
                ip: log.ipAddress || 'N/A',
                modules: {
                    dashboard: 0,
                    book_shipment: 0,
                    my_bookings: 0,
                    manifests: 0,
                    drafts: 0,
                    rate_calculator: 0,
                    marketplace: 0,
                    support: 0,
                    wallet: 0,
                    settings: 0,
                    api_hub: 0
                }
            };
        }

        // Map action to module
        const category = mapActionToCategory(log.action);
        if (category && currentSession) {
            currentSession.modules[category] = (currentSession.modules[category] || 0) + 1;
        }

        // Close session on LOGOUT
        if (isLogout && currentSession) {
            currentSession.endTime = log.createdAt;
            sessions.push(currentSession);
            currentSession = null;
        }
    });

    // Push the last open session
    if (currentSession) {
        sessions.push(currentSession);
    }

    return sessions;
};

const getUserSessionsAPI = async (req, res) => {
    try {
        const { actorId, since } = req.query;
        if (!actorId) {
            return res.status(400).json({ message: 'Actor ID is required' });
        }
        
        const sessions = await getGroupedUserSessions(actorId, since);
        res.json({ sessions });
    } catch (error) {
        res.status(500).json({ message: 'Failed to get user sessions', error: error.message });
    }
};

const exportUserActivityToExcel = async (req, res) => {
    try {
        const { actorId, since } = req.query;
        if (!actorId) {
            return res.status(400).json({ message: 'Actor ID is required for export' });
        }

        const sessions = await getGroupedUserSessions(actorId, since);

        if (sessions.length === 0) {
            return res.status(404).json({ message: 'No activity found for this user in the specified timeframe' });
        }

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('User Sessions');

        worksheet.columns = [
            { header: 'Login Time', key: 'startTime', width: 22 },
            { header: 'Session End', key: 'endTime', width: 22 },
            { header: 'IP Address', key: 'ip', width: 20 },
            { header: 'Dashboard', key: 'dashboard', width: 15 },
            { header: 'Book Shipment', key: 'book_shipment', width: 15 },
            { header: 'My Bookings', key: 'my_bookings', width: 15 },
            { header: 'Manifests', key: 'manifests', width: 15 },
            { header: 'Drafts', key: 'drafts', width: 15 },
            { header: 'Rate Calculator', key: 'rate_calculator', width: 15 },
            { header: 'Marketplace', key: 'marketplace', width: 15 },
            { header: 'Support Center', key: 'support', width: 15 },
            { header: 'Wallet', key: 'wallet', width: 15 },
            { header: 'Settings/Profile', key: 'settings', width: 15 },
            { header: 'API Hub', key: 'api_hub', width: 15 }
        ];

        sessions.forEach(session => {
            const rowData = {
                startTime: new Date(session.startTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                endTime: session.endTime ? new Date(session.endTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Active/Unknown',
                ip: session.ip,
                ...session.modules
            };
            worksheet.addRow(rowData);
        });

        worksheet.getRow(1).font = { bold: true };
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="User_Sessions_${actorId}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ message: 'Failed to generate excel file', error: error.message });
    }
};

module.exports = {
    getDashboardStats,
    createAnnouncement,
    getAllAnnouncements,
    deleteAnnouncement,
    toggleAnnouncement,
    getLogs,
    getUserSessionsAPI,
    exportUserActivityToExcel,
    forceRefreshRates,
    getCarrierBookingLogs,
    getSystemHealth
};
