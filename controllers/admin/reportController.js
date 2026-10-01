const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const QuoteQuery = require('../../models/QuoteQuery');
const Admin = require('../../models/Admin');
const VisitLog = require('../../models/VisitLog');
const { getISTDateRange, getPreviousPeriod } = require('../../utils/dateUtils');
const { CONVERT_PRICE_TO_DOUBLE, CONVERT_WEIGHT_TO_DOUBLE, extractShipmentWeight, getRoleBasedFilters } = require('../../utils/reportHelpers');

const cacheService = require('../../utils/cacheService');

// @desc    Get Daily Report
// @route   GET /api/admin/daily-report
// @access  Private/Admin
const getDailyReport = async (req, res) => {
    try {
        const { startDate, endDate, refresh, destinations } = req.query;

        // 1. Get Role-Based Filters
        const { generalFilter, userFilter } = await getRoleBasedFilters(req.admin);

        // Add destination country filter if provided
        if (destinations) {
            const destList = (Array.isArray(destinations) ? destinations : destinations.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                generalFilter['consigneeDetails.country'] = { $in: destRegexes };
            }
        }

        // --- CACHE CHECK ---
        const cacheKey = `daily_report_${startDate || 'default'}_${endDate || 'default'}_${destinations || 'all'}_${req.admin._id}`;

        // Only check cache if refresh is NOT true
        if (refresh !== 'true') {
            const cachedData = cacheService.get(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        }

        // 2. Get Standardized Date Range (IST)
        const { start, end } = getISTDateRange(startDate, endDate);

        // 3. Get Previous Period for Comparison
        const { previousStart, previousEnd } = getPreviousPeriod(start, end);

        // --- Aggregation Pipelines ---

        // 1. Shipment Aggregation (Revenue, Weight, Status, Carrier, Service, Destinations)
        const shipmentStats = await Shipment.aggregate([
            { $match: { createdAt: { $gte: start, $lte: end }, ...generalFilter } },
            {
                $facet: {
                    "totals": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        {
                            $group: {
                                _id: null,
                                count: { $sum: 1 },
                                revenue: { $sum: CONVERT_PRICE_TO_DOUBLE },
                                totalWeight: { $sum: CONVERT_WEIGHT_TO_DOUBLE },
                                uniqueUsers: { $addToSet: "$user" }
                            }
                        }
                    ],
                    "byStatus": [
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ],
                    "byCarrier": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        { $group: { _id: "$trackingCarrier", count: { $sum: 1 } } }
                    ],
                    "byService": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        {
                            $group: {
                                _id: "$serviceDetails.serviceName",
                                count: { $sum: 1 },
                                revenue: { $sum: CONVERT_PRICE_TO_DOUBLE }
                            }
                        },
                        { $sort: { count: -1 } },
                        { $limit: 3 }
                    ],
                    "byDestination": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        { $group: { _id: "$consigneeDetails.country", count: { $sum: 1 } } },
                        { $sort: { count: -1 } },
                        { $limit: 5 }
                    ],
                    "unmanifested": [
                        {
                            $match: {
                                status: 'Processing',
                                manifestId: null
                            }
                        },
                        { $count: "count" }
                    ],
                    "taxCompliance": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        {
                            $group: {
                                _id: "$shipmentDetails.gstPaymentType", // 'lut' or 'igst'
                                count: { $sum: 1 },
                                revenue: { $sum: CONVERT_PRICE_TO_DOUBLE }
                            }
                        }
                    ],
                    "topSpenders": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        {
                            $group: {
                                _id: "$user",
                                totalSpend: { $sum: CONVERT_PRICE_TO_DOUBLE },
                                shipmentCount: { $sum: 1 }
                            }
                        },
                        { $match: { totalSpend: { $gt: 0 } } },
                        { $sort: { totalSpend: -1 } },
                        { $limit: 5 },
                        {
                            $lookup: {
                                from: "users",
                                localField: "_id",
                                foreignField: "_id",
                                as: "userInfo"
                            }
                        },
                        { $project: { "userInfo.name": 1, "userInfo.email": 1, totalSpend: 1, shipmentCount: 1 } }
                    ],
                    "hourlyTrend": [
                        { $match: { status: { $ne: 'Cancelled' } } },
                        {
                            $group: {
                                _id: { $hour: { date: "$createdAt", timezone: "Asia/Kolkata" } }, // Groups by 0-23 in IST
                                count: { $sum: 1 },
                                revenue: { $sum: CONVERT_PRICE_TO_DOUBLE }
                            }
                        },
                        { $sort: { _id: 1 } }
                    ]
                }
            }
        ]);

        // 2. Transaction Aggregation (Wallet Deposits, Spend, Failed)
        const transactionStats = await Transaction.aggregate([
            { $match: { createdAt: { $gte: start, $lte: end }, ...generalFilter } },
            {
                $group: {
                    _id: "$type", // 'credit' or 'debit'
                    amount: { $sum: "$amount" },
                    count: { $sum: 1 },
                    failedCount: {
                        $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] }
                    }
                }
            }
        ]);

        // 3. User Aggregation (KYC, Signups)
        const userStats = await User.aggregate([
            {
                $facet: {
                    "newSignups": [
                        { $match: { createdAt: { $gte: start, $lte: end }, ...userFilter } },
                        { $group: { _id: "$accountType", count: { $sum: 1 } } }
                    ],
                    "kycStatus": [
                        { $match: { ...userFilter } },
                        { $group: { _id: "$kycData.status", count: { $sum: 1 } } }
                    ],
                    "byReferral": [
                        { $match: { createdAt: { $gte: start, $lte: end }, ...userFilter } },
                        {
                            $group: {
                                _id: "$referralSource",
                                count: { $sum: 1 },
                                verified: { $sum: { $cond: ["$kycVerified", 1, 0] } }
                            }
                        }
                    ],
                    "byTeamReferral": [
                        { $match: { createdAt: { $gte: start, $lte: end }, ...userFilter } },
                        { $match: { assignedTo: { $ne: null } } },
                        {
                            $lookup: {
                                from: "admins",
                                localField: "assignedTo",
                                foreignField: "_id",
                                as: "adminInfo"
                            }
                        },
                        { $unwind: "$adminInfo" },
                        {
                            $group: {
                                _id: "$adminInfo.name",
                                count: { $sum: 1 },
                                verified: { $sum: { $cond: ["$kycVerified", 1, 0] } }
                            }
                        },
                        { $sort: { count: -1 } }
                    ],
                    "verifiedInRange": [
                        { $match: { "kycData.kycVerifiedAt": { $gte: start, $lte: end }, ...userFilter } },
                        { $count: "count" }
                    ]
                }
            }
        ]);

        // 4. Comparison Data (Excluding Cancelled)
        const prevShipmentsCount = await Shipment.countDocuments({ createdAt: { $gte: previousStart, $lte: previousEnd }, status: { $ne: 'Cancelled' }, ...generalFilter });
        const prevSignupsCount = await User.countDocuments({ createdAt: { $gte: previousStart, $lte: previousEnd }, ...userFilter });
        const prevQueriesCount = await QuoteQuery.countDocuments({ createdAt: { $gte: previousStart, $lte: previousEnd }, ...generalFilter });
        const prevVerifiedCount = await User.countDocuments({ "kycData.kycVerifiedAt": { $gte: previousStart, $lte: previousEnd }, ...userFilter });

        // 5. Visit Stats
        // Visits are usually global, so we might not filter by user unless we track who visited
        const visitCount = await VisitLog.countDocuments({ createdAt: { $gte: start, $lte: end } });

        // 6. Visit Breakdown by Source
        const trafficSources = await VisitLog.aggregate([
            { $match: { createdAt: { $gte: start, $lte: end } } },
            {
                $group: {
                    _id: "$source",
                    count: { $sum: 1 } // Simple count of visits
                }
            },
            { $sort: { count: -1 } }
        ]);


        // 7. Traffic Trend (Hourly breakdown by source)
        const trafficTrend = await VisitLog.aggregate([
            { $match: { createdAt: { $gte: start, $lte: end } } },
            {
                $group: {
                    _id: {
                        // Group by 30-minute intervals
                        time: {
                            $dateToString: {
                                format: "%Y-%m-%dT%H:%M:00",
                                date: {
                                    $toDate: {
                                        $subtract: [
                                            { $toLong: "$createdAt" },
                                            { $mod: [{ $toLong: "$createdAt" }, 1000 * 60 * 30] } // 30 minutes in ms
                                        ]
                                    }
                                },
                                timezone: "Asia/Kolkata"
                            }
                        },
                        source: "$source"
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { "_id.time": 1 } }
        ]);

        // 8. Login Page Specific Stats
        const loginPageStats = await VisitLog.aggregate([
            { $match: { createdAt: { $gte: start, $lte: end }, path: '/login' } },
            {
                $group: {
                    _id: "$source",
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } }
        ]);


        // --- Process Results ---
        const sStats = shipmentStats[0];
        const tStats = transactionStats;
        const uStats = userStats[0];

        // Helpers
        const getSum = (arr, key) => arr.reduce((acc, curr) => (curr._id?.toLowerCase() === key) ? acc + curr.amount : acc, 0);

        // Financials
        const walletDeposits = getSum(tStats, 'credit');
        const rawSpend = getSum(tStats, 'debit');
        const walletSpend = Math.abs(rawSpend); // Ensure positive magnitude for display
        const failedTxns = tStats.reduce((acc, curr) => acc + curr.failedCount, 0);

        // Operational
        const totalShipments = sStats.totals[0]?.count || 0;
        const totalRevenue = sStats.totals[0]?.revenue || 0;
        const totalWeight = sStats.totals[0]?.totalWeight || 0;
        const activeUsers = sStats.totals[0]?.uniqueUsers?.length || 0;
        const avgShipmentValue = totalShipments > 0 ? (totalRevenue / totalShipments) : 0;
        const revenuePerKg = totalWeight > 0 ? (totalRevenue / totalWeight) : 0;

        // Logistics Health
        const unmanifested = sStats.unmanifested[0]?.count || 0;
        const pendingPickups = sStats.byStatus.find(x => x._id === 'Pending')?.count || 0;

        // Service Popularity
        const topServices = sStats.byService.map(s => ({ _id: s._id || 'Unknown', count: s.count, totalRevenue: s.revenue }));

        // Compliance
        const gstStats = sStats.taxCompliance.find(x => x._id === 'igst') || { count: 0, revenue: 0 };
        // Handle explicit 'lut' AND missing/null field (which defaults to 'lut')
        const lutStatsRaw = sStats.taxCompliance.filter(x => x._id === 'lut' || x._id === null);
        const lutStats = {
            count: lutStatsRaw.reduce((acc, curr) => acc + curr.count, 0),
            revenue: lutStatsRaw.reduce((acc, curr) => acc + curr.revenue, 0)
        };


        const responseData = {
            range: { start, end },
            kpi: {
                revenue: totalRevenue,
                shipments: totalShipments,
                activeUsers: activeUsers,
                avgShipmentValue: Math.round(avgShipmentValue),
                totalWeight: Math.round(totalWeight * 100) / 100,
                revenuePerKg: Math.round(revenuePerKg),
                signups: uStats.newSignups.reduce((acc, curr) => acc + curr.count, 0),
                kycVerified: uStats.verifiedInRange[0]?.count || 0,
                visits: visitCount
            },
            financials: {
                walletDeposits,
                walletSpend,
                netFloat: walletDeposits - walletSpend, // Net change: Deposits - Expenditures
                failedTransactions: failedTxns
            },
            breakdowns: {
                status: sStats.byStatus.reduce((acc, curr) => ({ ...acc, [curr._id]: curr.count }), {}),
                carrier: sStats.byCarrier.reduce((acc, curr) => ({ ...acc, [curr._id]: curr.count }), {}),
                services: topServices,
                destinations: sStats.byDestination.map(d => ({ _id: d._id || 'Unknown', count: d.count })),
                compliance: { gst: gstStats, lut: lutStats },
                acquisition: uStats.newSignups.map(s => ({ name: s._id || 'Unknown', value: s.count })),
                kyc: uStats.kycStatus.reduce((acc, curr) => ({ ...acc, [curr._id]: curr.count }), {}),
                referral: uStats.byReferral.map(s => ({
                    name: s._id || 'Direct',
                    value: s.count,
                    verified: s.verified
                })),
                teamReferral: uStats.byTeamReferral.map(s => ({
                    name: s._id || 'Unknown',
                    value: s.count,
                    verified: s.verified
                })),
                trafficSources: trafficSources.map(s => ({
                    name: s._id || 'Direct',
                    value: s.count
                })),
                trafficTrend: trafficTrend.map(t => ({
                    time: t._id.time,
                    source: t._id.source || 'direct',
                    count: t.count
                })),
                loginPage: loginPageStats.map(s => ({
                    name: s._id || 'Direct',
                    value: s.count
                }))
            },
            health: {
                unmanifested,
                pendingPickups
            },
            trends: {
                hourly: sStats.hourlyTrend.map(h => ({ hour: h._id, count: h.count, revenue: h.revenue })),
                comparison: {
                    shipments: prevShipmentsCount,
                    signups: prevSignupsCount,
                    queries: prevQueriesCount,
                    kycVerified: prevVerifiedCount
                }
            },
            lists: {
                topSpenders: sStats.topSpenders.map(s => ({
                    _id: s._id,
                    userDetails: {
                        name: s.userInfo[0]?.name || 'Unknown User',
                        email: s.userInfo[0]?.email || 'N/A'
                    },
                    totalSpend: s.totalSpend,
                    shipmentCount: s.shipmentCount
                }))
            }
        };

        // Cache the result for 30 seconds (Testing)
        cacheService.set(cacheKey, responseData, 30);

        res.json(responseData);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getSalesPersonReport = async (req, res) => {
    try {
        const { startDate, endDate, destinations } = req.query;
        const { start, end } = getISTDateRange(startDate, endDate);

        const matchQuery = {
            createdAt: { $gte: start, $lte: end }
        };

        if (destinations) {
            const destList = (Array.isArray(destinations) ? destinations : destinations.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                matchQuery['consigneeDetails.country'] = { $in: destRegexes };
            }
        }

        const pipeline = [
            {
                $match: matchQuery
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            { $unwind: '$userInfo' },
            { $match: {} }
        ];

        if (req.admin.role === 'member') {
            pipeline.push({
                $match: { 'userInfo.assignedTo': req.admin._id }
            });
        }

        pipeline.push(
            {
                $lookup: {
                    from: 'admins',
                    localField: 'userInfo.assignedTo',
                    foreignField: '_id',
                    as: 'salesPersonInfo'
                }
            },
            {
                $unwind: {
                    path: '$salesPersonInfo',
                    preserveNullAndEmptyArrays: true
                }
            },
            { $match: { status: { $ne: 'Cancelled' } } },
            {
                $lookup: {
                    from: 'disputes',
                    localField: '_id',
                    foreignField: 'shipment',
                    as: 'shipmentDisputes'
                }
            },
            {
                $addFields: {
                    disputeTotalForShipment: { $sum: '$shipmentDisputes.amount' },
                    parsedBilling: CONVERT_PRICE_TO_DOUBLE,
                    rawMarkup: {
                        $add: [
                            { $ifNull: ['$serviceDetails.markup', 0] },
                            { $ifNull: ['$serviceDetails.extraMargin', 0] }
                        ]
                    },
                    rawCost: { $ifNull: ['$serviceDetails.cost', 0] },
                    rawDflCost: { $ifNull: ['$serviceDetails.dflCost', 0] }
                }
            },
            {
                $addFields: {
                    billingExGST: { $divide: ['$parsedBilling', 1.18] }
                }
            },
            {
                $addFields: {
                    shipmentProfit: {
                        $cond: [
                            { $gt: ['$rawMarkup', 0] },
                            '$rawMarkup',
                            {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$rawDflCost', 0] },
                                            { $lt: ['$rawDflCost', '$billingExGST'] }
                                        ]
                                    },
                                    { $subtract: ['$billingExGST', '$rawDflCost'] },
                                    {
                                        $cond: [
                                            {
                                                $and: [
                                                    { $gt: ['$rawCost', 0] },
                                                    { $lt: ['$rawCost', '$billingExGST'] }
                                                ]
                                            },
                                            { $subtract: ['$billingExGST', '$rawCost'] },
                                            {
                                                $cond: [
                                                    { $gt: ['$billingExGST', 0] },
                                                    { $multiply: ['$billingExGST', 0.15] },
                                                    0
                                                ]
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $addFields: {
                    shipmentCarrierCost: {
                        $max: [0, { $subtract: ['$billingExGST', '$shipmentProfit'] }]
                    }
                }
            },
            {
                $group: {
                    _id: '$userInfo.assignedTo',
                    salesPersonName: { $first: { $ifNull: ['$salesPersonInfo.name', 'Unassigned'] } },
                    totalShippers: { $addToSet: '$user' },
                    shipmentCount: { $sum: 1 },
                    billing: { $sum: '$parsedBilling' },
                    cost: { $sum: '$shipmentCarrierCost' },
                    grossProfit: { $sum: '$shipmentProfit' },
                    disputeAmount: { $sum: '$disputeTotalForShipment' }
                }
            },
            {
                $project: {
                    _id: 1,
                    salesPersonName: 1,
                    shipperCount: { $size: '$totalShippers' },
                    shipmentCount: 1,
                    billing: 1,
                    disputeAmount: 1,
                    gst: {
                        $subtract: [
                            '$billing',
                            { $divide: ['$billing', 1.18] }
                        ]
                    },
                    cost: 1,
                    grossProfit: 1
                }
            },
            { $sort: { billing: -1 } }
        );

        const report = await Shipment.aggregate(pipeline);

        res.json(report);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getSalesPersonShipments = async (req, res) => {
    try {
        const { salesPersonId } = req.params;
        const { startDate, endDate, destinations } = req.query;
        const { start, end } = getISTDateRange(startDate, endDate);

        // 1. Find Users assigned to this Sales Person
        const query = {};
        if (!salesPersonId || salesPersonId === 'null' || salesPersonId === 'undefined') {
            query.assignedTo = null;
        } else {
            query.assignedTo = salesPersonId;
        }
        const users = await User.find(query).select('_id');
        const userIds = users.map(u => u._id);

        const shipmentQuery = {
            user: { $in: userIds },
            createdAt: { $gte: start, $lte: end },
            status: { $ne: 'Cancelled' }
        };

        if (destinations) {
            const destList = (Array.isArray(destinations) ? destinations : destinations.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                shipmentQuery['consigneeDetails.country'] = { $in: destRegexes };
            }
        }

        const shipments = await Shipment.find(shipmentQuery)
            .populate('user', 'name email') // Get Shipper Name
            .sort({ createdAt: -1 })
            .lean();

        // Format Response
        const formattedShipments = shipments.map(s => {
            const billing = parseFloat(String(s.serviceDetails?.price || '0').replace(/[^0-9.]/g, '')) || 0;
            const markup = (s.serviceDetails?.markup || 0) + (s.serviceDetails?.extraMargin || 0);
            const billingExGST = billing / 1.18;
            const gst = billing - billingExGST;

            let grossProfit = 0;
            if (markup > 0) {
                grossProfit = markup;
            } else if (s.serviceDetails?.dflCost && s.serviceDetails.dflCost < billingExGST) {
                grossProfit = billingExGST - s.serviceDetails.dflCost;
            } else if (s.serviceDetails?.cost && s.serviceDetails.cost < billingExGST) {
                grossProfit = billingExGST - s.serviceDetails.cost;
            } else if (billingExGST > 0) {
                grossProfit = billingExGST * 0.15;
            }

            const cost = Math.max(0, billingExGST - grossProfit);

            return {
                _id: s._id,
                trackingId: s.trackingId,
                shipmentId: s.shipmentId,
                date: s.createdAt,
                shipperName: s.user?.name || 'Unknown',
                consignee: s.consigneeDetails?.state || s.consigneeDetails?.country || 'N/A', // Show Destination
                service: s.serviceDetails?.serviceName || 'N/A',
                billing: billing,
                gst: gst,
                cost: cost,
                grossProfit: grossProfit
            };
        });

        res.json(formattedShipments);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const { generateSkynetEcomReportBuffer } = require('../../utils/skynetEcomReportService');
const { generateUnitedReportBuffer } = require('../../utils/unitedReportService');

const exportSkynetEcomReport = async (req, res) => {
    try {
        const { shipmentIds } = req.body;
        if (!shipmentIds || !Array.isArray(shipmentIds) || shipmentIds.length === 0) {
            return res.status(400).json({ message: 'No shipment IDs provided.' });
        }

        const buffer = await generateSkynetEcomReportBuffer(shipmentIds);
        if (!buffer || buffer.length === 0) {
            return res.status(404).json({ message: 'Failed to generate Excel buffer for selected shipments.' });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Skynet_Ecom_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
        return res.send(buffer);
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to export Skynet Ecom report.' });
    }
};

const exportUnitedReport = async (req, res) => {
    try {
        const { shipmentIds } = req.body;
        if (!shipmentIds || !Array.isArray(shipmentIds) || shipmentIds.length === 0) {
            return res.status(400).json({ message: 'No shipment IDs provided.' });
        }

        const buffer = await generateUnitedReportBuffer(shipmentIds);
        if (!buffer || buffer.length === 0) {
            return res.status(404).json({ message: 'Failed to generate Excel buffer for selected shipments.' });
        }

        res.setHeader('Content-Type', 'application/vnd.ms-excel');
        res.setHeader('Content-Disposition', `attachment; filename=United_Report_${new Date().toISOString().split('T')[0]}.xls`);
        return res.send(buffer);
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to export United report.' });
    }
};

const getDailyReportDetails = async (req, res) => {
    try {
        const { type, value, startDate, endDate, destinations } = req.query;
        if (!type || !value) {
            return res.status(400).json({ message: 'Type and value parameters are required.' });
        }

        const { start, end } = getISTDateRange(startDate, endDate);
        const { generalFilter, userFilter } = await getRoleBasedFilters(req.admin);

        // Add destination country filter if provided
        if (destinations) {
            const destList = (Array.isArray(destinations) ? destinations : destinations.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                generalFilter['consigneeDetails.country'] = { $in: destRegexes };
            }
        }

        let title = `Details for ${value}`;
        let shipments = [];
        let users = [];

        if (type === 'status') {
            title = `Shipments with Status: "${value}"`;
            shipments = await Shipment.find({
                createdAt: { $gte: start, $lte: end },
                status: value,
                ...generalFilter
            })
                .populate('user', 'name email phone accountType companyName')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'destination') {
            title = `Shipments to Destination: "${value}"`;
            shipments = await Shipment.find({
                createdAt: { $gte: start, $lte: end },
                status: { $ne: 'Cancelled' },
                'consigneeDetails.country': { $regex: new RegExp(`^${value}$`, 'i') },
                ...generalFilter
            })
                .populate('user', 'name email phone accountType companyName')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'service') {
            title = `Shipments via Service: "${value}"`;
            shipments = await Shipment.find({
                createdAt: { $gte: start, $lte: end },
                status: { $ne: 'Cancelled' },
                'serviceDetails.serviceName': { $regex: new RegExp(value, 'i') },
                ...generalFilter
            })
                .populate('user', 'name email phone accountType companyName')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'user') {
            const targetUser = await User.findById(value).select('name email phone accountType companyName kycVerified createdAt').lean();
            title = targetUser ? `Top Spender Details: ${targetUser.name || targetUser.email}` : `User Shipments`;

            shipments = await Shipment.find({
                createdAt: { $gte: start, $lte: end },
                status: { $ne: 'Cancelled' },
                user: value,
                ...generalFilter
            })
                .populate('user', 'name email phone accountType companyName')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'accountType' || type === 'acquisition') {
            title = `Registered Users (${value.toUpperCase()})`;
            users = await User.find({
                createdAt: { $gte: start, $lte: end },
                accountType: { $regex: new RegExp(`^${value}$`, 'i') },
                ...userFilter
            })
                .select('name email phone accountType companyName kycVerified createdAt')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'teamReferral' || type === 'team') {
            title = `Users Referred by Team Member: "${value}"`;
            const matchedAdmin = await Admin.findOne({ name: { $regex: new RegExp(`^${value}$`, 'i') } }).select('_id');
            const adminIdFilter = matchedAdmin ? matchedAdmin._id : null;

            users = await User.find({
                createdAt: { $gte: start, $lte: end },
                assignedTo: adminIdFilter,
                ...userFilter
            })
                .select('name email phone accountType companyName kycVerified createdAt')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

        } else if (type === 'referral' || type === 'source') {
            title = `Registered Users via Source: "${value}"`;
            const sourceRegex = (value?.toLowerCase() === 'direct' || value?.toLowerCase() === 'direct / none')
                ? { $in: [null, '', 'Direct', 'direct'] }
                : { $regex: new RegExp(`^${value}$`, 'i') };

            users = await User.find({
                createdAt: { $gte: start, $lte: end },
                referralSource: sourceRegex,
                ...userFilter
            })
                .select('name email phone accountType companyName kycVerified createdAt')
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();
        }

        const isUserList = type === 'accountType' || type === 'acquisition' || type === 'teamReferral' || type === 'team' || type === 'referral' || type === 'source';

        // Format shipments output
        const formattedShipments = shipments.map(s => {
            const price = parseFloat((s.serviceDetails?.price || '0').replace(/[^0-9.]/g, '')) || 0;
            const weight = extractShipmentWeight(s);
            return {
                _id: s._id,
                trackingId: s.trackingId || s._id,
                shipmentId: s.shipmentId || 'N/A',
                createdAt: s.createdAt,
                status: s.status,
                customerName: s.user?.name || s.user?.companyName || 'Unknown Customer',
                customerEmail: s.user?.email || 'N/A',
                userId: s.user?._id,
                destination: `${s.consigneeDetails?.city || ''}, ${s.consigneeDetails?.country || 'N/A'}`,
                serviceName: s.serviceDetails?.serviceName || s.trackingCarrier || 'N/A',
                totalWeight: Math.round(weight * 100) / 100,
                price: price,
                trackingCarrier: s.trackingCarrier || 'N/A'
            };
        });

        const totalRevenue = formattedShipments.reduce((acc, curr) => acc + curr.price, 0);
        const totalWeight = formattedShipments.reduce((acc, curr) => acc + curr.totalWeight, 0);

        return res.json({
            title,
            type,
            value,
            count: isUserList ? users.length : formattedShipments.length,
            totalRevenue,
            totalWeight: Math.round(totalWeight * 100) / 100,
            shipments: formattedShipments,
            users: users
        });

    } catch (error) {
        console.error('Error fetching report details:', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch drill-down details.' });
    }
};

module.exports = {
    getDailyReport,
    getDailyReportDetails,
    getSalesPersonReport,
    getSalesPersonShipments,
    exportSkynetEcomReport,
    exportUnitedReport
};
