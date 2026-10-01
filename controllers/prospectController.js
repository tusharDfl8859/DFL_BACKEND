const Prospect = require('../models/Prospect');

// @desc    Create new prospect
// @route   POST /api/prospects
// @access  Protected (Member/Admin)
const createProspect = async (req, res) => {
    try {
        const {
            companyName,
            contactNumber,
            email,
            alternateContact,
            shipmentMode,
            pickupLocation,
            deliveryLocation,
            remarks,
            status,
            followUpDate,
            avgShipmentWeight,
            monthlyShipments,
            currentPriceGetting,
            monthlyRevenue,
            currentShippingPartner,
            productCategory
        } = req.body;

        if (!remarks || remarks.trim() === '') {
            return res.status(400).json({ message: 'Notes/Remarks are required.' });
        }

        const prospect = await Prospect.create({
            salesperson: req.admin._id, // Assumes authenticated as Admin/Member
            companyName,
            contactNumber,
            email,
            alternateContact,
            shipmentMode,
            pickupLocation,
            deliveryLocation,
            remarks,
            status,
            followUpDate,
            avgShipmentWeight,
            monthlyShipments,
            currentPriceGetting,
            monthlyRevenue,
            currentShippingPartner,
            productCategory,
            history: [{
                status: status || 'Interested',
                remarks: remarks || 'Prospect Entry Created',
                timestamp: new Date(),
                updatedBy: req.admin._id
            }]
        });

        res.status(201).json(prospect);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Check if prospect exists by contact number or company name
// @route   GET /api/prospects/check
// @access  Protected (Member/Admin)
const checkProspect = async (req, res) => {
    try {
        const { contactNumber, companyName } = req.query;

        if (!contactNumber && !companyName) {
            return res.status(400).json({ message: 'Must provide contact number or company name for checking.' });
        }

        let query = { $or: [] };

        if (contactNumber) {
            query.$or.push({ contactNumber: { $regex: new RegExp(`^${contactNumber}$`, 'i') } });
        }

        if (companyName) {
            query.$or.push({ companyName: { $regex: new RegExp(`^${companyName}$`, 'i') } });
        }

        const existingProspect = await Prospect.findOne(query)
            .populate('salesperson', 'name email role')
            .lean();

        if (existingProspect) {
            return res.json({ exists: true, prospect: existingProspect });
        } else {
            return res.json({ exists: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get all prospects (for Admin/Member Report)
// @route   GET /api/prospects
// @access  Protected (Admin/Member)
// @desc    Get all prospects (for Admin/Member Report)
// @route   GET /api/prospects
// @access  Protected (Admin/Member)
const getProspects = async (req, res) => {
    try {
        let query = {};
        const { scope } = req.query;

        // Enforcement: STRICT PRIVACY DEFAULT, but relax for Team/Super Admin if requested
        if (scope === 'team' && (req.admin.role === 'admin' || req.admin.role === 'super_admin' || req.admin.role === 'sales_manager')) {
            if (req.admin.role === 'super_admin') {
                // Super Admin sees ALL (no salesperson filter)
            } else {
                // Admin sees their own + their team's
                const Admin = require('../models/Admin');
                const teamIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
                teamIds.push(req.admin._id); // Include self
                query.salesperson = { $in: teamIds };
            }
        } else {
            // Default: STRICT PRIVACY (Only own data)
            query.salesperson = req.admin._id;
        }

        // Optional Filters from Query Params
        if (req.query.status) query.status = req.query.status;


        // Date Range Filter
        if (req.query.startDate && req.query.endDate) {
            query.createdAt = {
                $gte: new Date(req.query.startDate),
                $lte: new Date(new Date(req.query.endDate).setHours(23, 59, 59))
            };
        }

        // Specific FollowUp Date Filter (e.g. for Today's FollowUp List)
        if (req.query.followUpDate) {
            const fDate = new Date(req.query.followUpDate);
            // Match strict date string (YYYY-MM-DD from frontend usually)
            // Stored as ISO string, so we match string start or range for that day
            const startOfDay = new Date(fDate.setHours(0, 0, 0, 0));
            const endOfDay = new Date(fDate.setHours(23, 59, 59, 999));
            query.followUpDate = { $gte: startOfDay, $lte: endOfDay };
        } else if (req.query.pendingFollowUps === 'true') {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            query.followUpDate = { $lt: todayStart, $ne: null };
            query.status = { $nin: ['Converted', 'Not Interested', 'Junk Data'] };
            // Exclude if addressed on or after the due day
            query.$expr = { $lt: ["$updatedAt", "$followUpDate"] };
        }

        const prospects = await Prospect.find(query)
            .populate('salesperson', 'name email')
            .populate('history.updatedBy', 'name')
            .sort({ createdAt: -1 });

        res.json(prospects);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update prospect details
// @route   PUT /api/prospects/:id
// @access  Protected (Member owner or Admin)
const updateProspect = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            status,
            followUpDate,
            remarks,
            companyName,
            contactNumber,
            shipmentMode,
            pickupLocation,
            deliveryLocation,
            avgShipmentWeight,
            monthlyShipments,
            currentPriceGetting,
            monthlyRevenue,
            currentShippingPartner,
            productCategory
        } = req.body;

        if (!remarks || remarks.trim() === '') {
            return res.status(400).json({ message: 'A new note/remark is required for updates.' });
        }

        let prospect = await Prospect.findById(id);

        if (!prospect) {
            return res.status(404).json({ message: 'Prospect not found' });
        }

        const isSuperAdmin = req.admin.role === 'super_admin';
        const isManager = req.admin.role === 'admin' || req.admin.role === 'sales_manager';
        if (!isSuperAdmin && !isManager && prospect.salesperson.toString() !== req.admin._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to update this prospect' });
        }

        // Update fields if provided
        const oldStatus = prospect.status;
        const timestampStr = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
        const updaterName = req.admin.name || 'Unknown';

        if (status && status !== oldStatus) {
            prospect.status = status;
            prospect.remarks = (prospect.remarks || '') + `\n[${timestampStr} - ${updaterName}]: Status updated to ${status}`;

            // Auto-clear follow-up for Junk Data or if moving away from a follow-up required status
            if (status === 'Junk Data') {
                prospect.followUpDate = null;
            }
        }

        if (req.body.hasOwnProperty('followUpDate')) {
            prospect.followUpDate = req.body.followUpDate || null;
        }

        // If remarks are provided, they are treated as a NEW note to be appended
        if (remarks) {
            prospect.remarks = (prospect.remarks || '') + `\n[${timestampStr} - ${updaterName}]: ${remarks}`;
        }

        if (companyName) prospect.companyName = companyName;
        if (contactNumber) prospect.contactNumber = contactNumber;
        if (req.body.email) prospect.email = req.body.email;
        if (shipmentMode) prospect.shipmentMode = shipmentMode;
        if (pickupLocation) prospect.pickupLocation = pickupLocation;
        if (deliveryLocation) prospect.deliveryLocation = deliveryLocation;
        if (avgShipmentWeight !== undefined) prospect.avgShipmentWeight = avgShipmentWeight;
        if (monthlyShipments !== undefined) prospect.monthlyShipments = monthlyShipments;
        if (currentPriceGetting !== undefined) prospect.currentPriceGetting = currentPriceGetting;
        if (monthlyRevenue !== undefined) prospect.monthlyRevenue = monthlyRevenue;
        if (currentShippingPartner !== undefined) prospect.currentShippingPartner = currentShippingPartner;
        if (productCategory !== undefined) prospect.productCategory = productCategory;

        // Track History - use ONLY the new remark here
        const historyEntry = {
            status: status || prospect.status,
            remarks: remarks || (status && status !== oldStatus ? `Status updated to ${status}` : "Details updated"),
            timestamp: new Date(),
            updatedBy: req.admin._id
        };
        prospect.history.push(historyEntry);

        await prospect.save();
        res.json(prospect);

    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};



// --- Analytics Controllers ---

// @desc    Get aggregated analytics summary
// @route   GET /api/prospects/analytics/summary
// @access  Protected (Admin)
const getAnalyticsSummary = async (req, res) => {
    try {
        const { startDate, endDate, salespersonId } = req.query;

        // Date Filter logic: For Calls, we look at the interaction timestamp (history)
        // For Status counts, we look at prospects that were ACTIVE in the period.
        const dateFilter = (startDate && endDate) ? {
            $gte: new Date(startDate),
            $lte: new Date(new Date(endDate).setHours(23, 59, 59))
        } : null;



        const Admin = require('../models/Admin');
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin' || req.admin.role === 'sales_manager') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else { // super_admin
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        const salespersonMatch = {};
        if (salespersonId) {
            const mongoose = require('mongoose');
            const targetId = new mongoose.Types.ObjectId(salespersonId);
            // Verify access
            if (!memberIds.some(id => id.toString() === targetId.toString())) {
                return res.status(403).json({ message: 'Access denied for this salesperson' });
            }
            salespersonMatch.salesperson = targetId;
        } else {
            salespersonMatch.salesperson = { $in: memberIds };
        }

        // Optimized Aggregation: 
        // 1. totalCalls: Count every history entry in the range. 
        // 2. statusStats: Count unique prospects active in the range.
        const [results] = await Prospect.aggregate([
            {
                $facet: {
                    callStats: [
                        { $unwind: "$history" },
                        {
                            $match: {
                                ...salespersonMatch,
                                ...(dateFilter && { "history.timestamp": dateFilter })
                            }
                        },
                        { $group: { _id: null, totalCalls: { $sum: 1 } } }
                    ],
                    statusStats: [
                        {
                            $match: {
                                ...salespersonMatch,
                                ...(dateFilter && {
                                    history: {
                                        $elemMatch: { timestamp: dateFilter }
                                    }
                                })
                            }
                        },
                        {
                            $group: {
                                _id: "$status",
                                count: { $sum: 1 },
                                totalFollowUps: { $sum: { $cond: [{ $ifNull: ["$followUpDate", false] }, 1, 0] } }
                            }
                        }
                    ],
                }
            }
        ]);

        const totalCallsInPeriod = results.callStats[0]?.totalCalls || 0;
        const totalFollowUpsInPeriod = results.statusStats.reduce((sum, curr) => sum + (curr.totalFollowUps || 0), 0);

        const totalStats = { totalCalls: totalCallsInPeriod, totalFollowUps: totalFollowUpsInPeriod };
        const statusMap = results.statusStats.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {});

        const totalConversions = statusMap['Converted'] || 0; // UPDATED: Based on 'Converted'
        const totalInterested = statusMap['Interested'] || 0; // ADDED: Specific Interested count
        const totalCallBacks = statusMap['Call Back'] || 0;
        const totalNotInterested = statusMap['Not Interested'] || 0;
        const totalJunkData = statusMap['Junk Data'] || 0;
        const totalNotConnected = statusMap['Not Connected'] || 0;

        const conversionRate = totalStats.totalCalls > 0
            ? ((totalConversions / totalStats.totalCalls) * 100).toFixed(1)
            : 0;

        // Best Performer logic needs the same dateFilter adjustments
        let bestPerformer = null;

        if (!salespersonId) {
            const performanceStats = await Prospect.aggregate([
                { $unwind: "$history" },
                {
                    $match: {
                        ...salespersonMatch,
                        ...(dateFilter && { "history.timestamp": dateFilter })
                    }
                },
                {
                    $group: {
                        _id: {
                            salesperson: "$salesperson",
                            prospectId: "$_id"
                        },
                        isConverted: { $max: { $cond: [{ $eq: ["$history.status", "Converted"] }, 1, 0] } },
                        calls: { $sum: 1 }
                    }
                },
                {
                    $group: {
                        _id: "$_id.salesperson",
                        conversions: { $sum: "$isConverted" },
                        calls: { $sum: "$calls" }
                    }
                },
                { $sort: { conversions: -1 } },
                { $limit: 1 },
                {
                    $lookup: {
                        from: "admins",
                        localField: "_id",
                        foreignField: "_id",
                        as: "details"
                    }
                },
                { $unwind: "$details" },
                { $project: { name: "$details.name", conversions: 1, calls: 1 } }
            ]);
            bestPerformer = performanceStats[0] || null;
        }

        // Calculate "Today FollowUp" Count
        // The original `matchStage` was not defined in this scope, so we need to reconstruct it
        // based on `salespersonMatch` for consistency.
        const baseMatchStageForFollowUps = { ...salespersonMatch };

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const todayMatchStage = {
            ...baseMatchStageForFollowUps,
            followUpDate: { $gte: todayStart, $lte: todayEnd },
            status: { $nin: ['Converted', 'Not Interested', 'Junk Data'] }
        };
        const todayFollowUpsCount = await Prospect.countDocuments(todayMatchStage);

        // Calculate "Pending Follow-up" Count (Past Entries)
        const pendingMatchStage = {
            ...baseMatchStageForFollowUps,
            followUpDate: { $lt: todayStart, $ne: null },
            status: { $nin: ['Converted', 'Not Interested', 'Junk Data'] },
            $expr: { $lt: ["$updatedAt", "$followUpDate"] } // Exclude if addressed on or after due date
        };
        const pendingFollowUpsCount = await Prospect.countDocuments(pendingMatchStage);

        // Calculate "Inactive Users" from InactiveCustomerAlert
        const InactiveCustomerAlert = require('../models/InactiveCustomerAlert');
        const User = require('../models/User');
        const { syncInactiveAlerts } = require('./admin/inactiveAlertController');
        await syncInactiveAlerts();

        let userQuery = { isAdmin: false, isRestricted: false };
        if (req.admin.role === 'member') {
            userQuery.assignedTo = req.admin._id;
        } else if (req.admin.role === 'sales_manager' || req.admin.role === 'admin') {
            const memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
            userQuery.assignedTo = { $in: memberIds };
        }

        const matchingUsers = await User.find(userQuery).select('_id');
        const matchingUserIds = matchingUsers.map(u => u._id);

        const inactiveUsersCount = await InactiveCustomerAlert.countDocuments({
            status: 'active',
            user: { $in: matchingUserIds }
        });

        res.json({
            totalCalls: totalStats.totalCalls,
            totalConversions,
            totalInterested, // Sending upstream
            conversionRate,
            totalFollowUps: totalStats.totalFollowUps,
            todayFollowUps: todayFollowUpsCount,
            pendingFollowUps: pendingFollowUpsCount,
            totalCallBacks,
            totalNotInterested,
            totalJunkData,
            totalNotConnected,
            inactiveUsers: inactiveUsersCount,
            bestPerformer
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get analytics grouped by team member
// @route   GET /api/prospects/analytics/by-member
// @access  Protected (Admin)
const getAnalyticsByMember = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const Admin = require('../models/Admin');
        const mongoose = require('mongoose');

        // RBAC: Super Admin sees all. Admin sees only their team. Member sees none.
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin' || req.admin.role === 'sales_manager') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else { // super_admin
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        const members = await Admin.find({ _id: { $in: memberIds } }).select('name email');

        // Date Filter for activity
        const dateFilter = (startDate && endDate) ? {
            $gte: new Date(startDate),
            $lte: new Date(new Date(endDate).setHours(23, 59, 59))
        } : null;

        const memberStats = await Prospect.aggregate([
            { $unwind: "$history" },
            {
                $match: {
                    salesperson: { $in: memberIds },
                    ...(dateFilter && { "history.timestamp": dateFilter })
                }
            },
            {
                $group: {
                    _id: "$salesperson",
                    totalCalls: { $sum: 1 },
                    // Unique prospects and their statuses observed in this period
                    prospects: {
                        $addToSet: {
                            id: "$_id",
                            status: "$status",
                            hasFollowUp: { $cond: [{ $ifNull: ["$followUpDate", false] }, 1, 0] }
                        }
                    }
                }
            },
            {
                $project: {
                    totalCalls: 1,
                    conversions: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Converted"] }
                            }
                        }
                    },
                    interested: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Interested"] }
                            }
                        }
                    },
                    callBacks: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Call Back"] }
                            }
                        }
                    },
                    notInterested: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Not Interested"] }
                            }
                        }
                    },
                    junkData: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Junk Data"] }
                            }
                        }
                    },
                    notConnected: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Not Connected"] }
                            }
                        }
                    },
                    followUps: { $sum: "$prospects.hasFollowUp" }
                }
            }
        ]);

        const statsMap = memberStats.reduce((acc, curr) => {
            acc[curr._id.toString()] = curr;
            return acc;
        }, {});

        // Merge
        const result = members.map(member => {
            const stats = statsMap[member._id.toString()] || {};
            const totalCalls = stats.totalCalls || 0;
            const conversions = stats.conversions || 0;

            return {
                member: {
                    _id: member._id,
                    name: member.name,
                    email: member.email
                },
                totalCalls,
                interested: stats.interested || 0, // Sending upstream
                conversions,
                conversionRate: totalCalls > 0 ? ((conversions / totalCalls) * 100).toFixed(1) : 0,
                callBacks: stats.callBacks || 0,
                notInterested: stats.notInterested || 0,
                junkData: stats.junkData || 0,
                notConnected: stats.notConnected || 0,
                followUps: stats.followUps || 0,
                // Placeholder for Duration/Productivity until we have that data
                avgDuration: '0s',
                productivity: totalCalls > 0 ? (conversions * 10 + totalCalls).toString() : '0' // simple heuristic
            };
        });

        // Sort by conversions descending
        result.sort((a, b) => b.conversions - a.conversions);

        res.json(result);

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get trends for charts
// @route   GET /api/prospects/analytics/trends
// @access  Protected (Admin)
const getAnalyticsTrends = async (req, res) => {
    try {
        const { startDate, endDate, salespersonId } = req.query;

        const Admin = require('../models/Admin');
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else { // super_admin
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        let matchStage = {};
        if (salespersonId) {
            const mongoose = require('mongoose');
            const targetId = new mongoose.Types.ObjectId(salespersonId);
            if (!memberIds.some(id => id.toString() === targetId.toString())) {
                return res.status(403).json({ message: 'Access denied for this salesperson' });
            }
            matchStage.salesperson = targetId;
        } else {
            matchStage.salesperson = { $in: memberIds };
        }

        // Aggregate by Date
        const dateFilter = (startDate && endDate) ? {
            $gte: new Date(startDate),
            $lte: new Date(new Date(endDate).setHours(23, 59, 59))
        } : null;

        const dailyStats = await Prospect.aggregate([
            { $unwind: "$history" },
            {
                $match: {
                    ...matchStage,
                    ...(dateFilter && { "history.timestamp": dateFilter })
                }
            },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: "%Y-%m-%d", date: "$history.timestamp" } },
                        prospectId: "$_id" // Group by prospectId within each day to count unique conversions per day
                    },
                    calls: { $sum: 1 },
                    isConverted: { $max: { $cond: [{ $eq: ["$history.status", "Converted"] }, 1, 0] } }
                }
            },
            {
                $group: {
                    _id: "$_id.date",
                    calls: { $sum: "$calls" },
                    conversions: { $sum: "$isConverted" } // Sum of unique converted prospects for the day
                }
            },
            { $sort: { _id: 1 } }
        ]);

        res.json({
            labels: dailyStats.map(s => s._id),
            datasets: {
                calls: dailyStats.map(s => s.calls),
                conversions: dailyStats.map(s => s.conversions)
            }
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single member deep dive
// @route   GET /api/prospects/analytics/member/:id
// @access  Protected (Admin)
const getMemberAnalytics = async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate, status } = req.query;
        const mongoose = require('mongoose');
        const Admin = require('../models/Admin');

        let memberIds = [];
        let memberDetail = null;
        const isSuperAdmin = req.admin.role === 'super_admin';
        const isManager = req.admin.role === 'admin' || req.admin.role === 'sales_manager';

        if (id === 'team') {
            // Team View: Get all authorized members
            if (req.admin.role === 'admin' || req.admin.role === 'sales_manager') {
                memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
                memberIds.push(req.admin._id);
            } else if (req.admin.role === 'super_admin') {
                memberIds = await Admin.find({ role: { $in: ['member', 'admin', 'operation', 'sales_manager'] } }).distinct('_id');
            } else {
                return res.status(403).json({ message: 'Access denied' });
            }
            memberDetail = { name: 'Team Performance', designation: 'All Members', isTeam: true };
        } else {
            // Single Member View
            const member = await Admin.findById(id).select('name email role contactNumber designation');
            if (!member) return res.status(404).json({ message: 'Member not found' });
            memberIds = [new mongoose.Types.ObjectId(id)];
            memberDetail = member;
        }

        // Stats Aggregation
        const stats = await Prospect.aggregate([
            { $unwind: "$history" },
            {
                $match: {
                    salesperson: { $in: memberIds },
                    ...(startDate && endDate && {
                        "history.timestamp": {
                            $gte: new Date(startDate),
                            $lte: new Date(new Date(endDate).setHours(23, 59, 59))
                        }
                    })
                }
            },
            {
                $group: {
                    _id: null,
                    totalCalls: { $sum: 1 },
                    prospects: {
                        $addToSet: {
                            id: "$_id",
                            status: "$status",
                            followUpDate: "$followUpDate"
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalCalls: 1,
                    conversions: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Converted"] }
                            }
                        }
                    },
                    interested: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Interested"] }
                            }
                        }
                    },
                    callBacks: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Call Back"] }
                            }
                        }
                    },
                    followUps: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $ne: [{ $ifNull: ["$$p.followUpDate", null] }, null] }
                            }
                        }
                    },
                    notInterested: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Not Interested"] }
                            }
                        }
                    },
                    junkData: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Junk Data"] }
                            }
                        }
                    },
                    notConnected: {
                        $size: {
                            $filter: {
                                input: "$prospects",
                                as: "p",
                                cond: { $eq: ["$$p.status", "Not Connected"] }
                            }
                        }
                    }
                }
            }
        ]);

        // Recent Activity
        const recentActivity = await Prospect.aggregate([
            { $match: { salesperson: { $in: memberIds } } },
            {
                $project: {
                    _id: 1,
                    companyName: 1,
                    shipmentMode: 1,
                    monthlyRevenue: 1,
                    avgShipmentWeight: 1,
                    monthlyShipments: 1,
                    currentPriceGetting: 1,
                    currentShippingPartner: 1,
                    productCategory: 1,
                    email: 1,
                    contactNumber: 1,
                    pickupLocation: 1,
                    deliveryLocation: 1,
                    status: 1,
                    remarks: 1,
                    salesperson: 1,
                    entryCreatedAt: "$createdAt",
                    history: {
                        $cond: [
                            { $and: [{ $isArray: "$history" }, { $gt: [{ $size: "$history" }, 0] }] },
                            "$history",
                            [{ status: "$status", remarks: "$remarks", timestamp: "$createdAt" }]
                        ]
                    },
                    updatedAt: {
                        $cond: [
                            { $and: [{ $isArray: "$history" }, { $gt: [{ $size: "$history" }, 0] }] },
                            { $arrayElemAt: ["$history.timestamp", -1] },
                            "$createdAt"
                        ]
                    }
                }
            },
            {
                $match: {
                    ...(status && { status }),
                    ...(startDate && endDate && {
                        updatedAt: {
                            $gte: new Date(startDate),
                            $lte: new Date(new Date(endDate).setHours(23, 59, 59))
                        }
                    })
                }
            },
            { $addFields: { createdAt: "$updatedAt" } },
            ...((isSuperAdmin || isManager) ? [
                { $unwind: "$history" },
                {
                    $lookup: {
                        from: 'admins',
                        localField: 'history.updatedBy',
                        foreignField: '_id',
                        as: 'history.updatedBy'
                    }
                },
                { $unwind: { path: '$history.updatedBy', preserveNullAndEmptyArrays: true } },
                {
                    $group: {
                        _id: "$_id",
                        companyName: { $first: "$companyName" },
                        shipmentMode: { $first: "$shipmentMode" },
                        monthlyRevenue: { $first: "$monthlyRevenue" },
                        avgShipmentWeight: { $first: "$avgShipmentWeight" },
                        monthlyShipments: { $first: "$monthlyShipments" },
                        currentPriceGetting: { $first: "$currentPriceGetting" },
                        currentShippingPartner: { $first: "$currentShippingPartner" },
                        productCategory: { $first: "$productCategory" },
                        email: { $first: "$email" },
                        contactNumber: { $first: "$contactNumber" },
                        pickupLocation: { $first: "$pickupLocation" },
                        deliveryLocation: { $first: "$deliveryLocation" },
                        status: { $first: "$status" },
                        remarks: { $first: "$remarks" },
                        salesperson: { $first: "$salesperson" },
                        history: { $push: "$history" },
                        entryCreatedAt: { $first: "$entryCreatedAt" },
                        updatedAt: { $first: "$updatedAt" },
                        createdAt: { $first: "$createdAt" }
                    }
                }
            ] : []),
            { $sort: { updatedAt: -1 } },
            {
                $lookup: {
                    from: 'admins',
                    localField: 'salesperson',
                    foreignField: '_id',
                    as: 'salespersonDetails'
                }
            },
            { $unwind: { path: '$salespersonDetails', preserveNullAndEmptyArrays: true } }
        ]);

        res.json({
            member: memberDetail,
            stats: stats[0] || { totalCalls: 0, conversions: 0, interested: 0, callBacks: 0, followUps: 0, notInterested: 0 },
            recentActivity
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Reassign prospect to another salesperson
// @route   PATCH /api/prospects/:id/reassign
// @access  Protected (Admin/SuperAdmin)
const reassignProspect = async (req, res) => {
    try {
        const { id } = req.params;
        const { targetSalespersonId } = req.body;

        if (!targetSalespersonId) {
            return res.status(400).json({ message: 'Target salesperson ID is required' });
        }

        const prospect = await Prospect.findById(id);
        if (!prospect) {
            return res.status(404).json({ message: 'Prospect not found' });
        }

        const Admin = require('../models/Admin');
        const targetAdmin = await Admin.findById(targetSalespersonId);
        if (!targetAdmin) {
            return res.status(404).json({ message: 'Target salesperson not found' });
        }

        // Authorization: Only Super Admin or the Admin who created the current salesperson can reassign
        // Or if the current admin is the one who created the target salesperson.
        // Actually, for "Himaanie", we want her to be able to reassign within her team.
        // Since we are hardcoding the check in the frontend, let's make the backend flexible enough
        // but still secure.
        const isSuperAdmin = req.admin.role === 'super_admin';
        const isManager = req.admin.role === 'admin' || req.admin.role === 'sales_manager';
        const authorizedEmails = [
            'pb@thedflgroup.com',
            'jameswaltercop@gmail.com',
            'piyush19807work@gmail.com',
            'piyushsinha19807@gmail.com',
            'kaushal.tech@thedflgroup.com',
            'kaushal@gmail.com',
            'himani@dflindia.in',
            'dk@thedflgroup.com'
        ];
        const isEmailAuthorized = authorizedEmails.includes(req.admin.email);
        if (!isSuperAdmin && !isManager && !isEmailAuthorized) {
            return res.status(403).json({ message: 'Not authorized to reassign prospects' });
        }

        const oldSalesperson = await Admin.findById(prospect.salesperson).select('name');
        prospect.salesperson = targetSalespersonId;
        // Log history
        const timestampStr = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
        const oldName = oldSalesperson ? oldSalesperson.name : 'Unknown';
        const reassignmentNote = `Reassigned from ${oldName} to ${targetAdmin.name} by ${req.admin.name}`;
        prospect.remarks = (prospect.remarks || '') + `\n[${timestampStr}]: ${reassignmentNote}`;
        prospect.history.push({
            status: prospect.status,
            remarks: reassignmentNote,
            timestamp: new Date(),
            updatedBy: req.admin._id
        });

        await prospect.save();
        res.json({ message: 'Prospect reassigned successfully', prospect });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

module.exports = {
    createProspect,
    getProspects,
    updateProspect,
    getAnalyticsSummary,
    checkProspect,
    getAnalyticsByMember,
    getAnalyticsTrends,
    getMemberAnalytics,
    reassignProspect
};
