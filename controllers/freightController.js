const FreightInquiry = require('../models/FreightInquiry');

// @desc    Create new freight inquiry
// @route   POST /api/prospects/freight
// @access  Protected (Member/Admin)
const createFreightInquiry = async (req, res) => {
    try {
        const {
            companyName, contactPersonName, contactNumber, email,
            isShipper, isConsignee, modeOfShipment,
            portOfLoading, portOfDestination, commodity,
            averageShipmentVolume, monthlyShipments,
            currentFreightRate, estimatedMonthlyRevenue,
            currentFreightForwarder,
            tradeLane, incoterms, specialRequirements, remarks,
            businessCountries, shippingLine, state, pinCode, feedback,
            status, followUpDate,
            initialQuery // Optional: { subject, modeOfShipment, portOfLoading, ... }
        } = req.body;

        if (!remarks || remarks.trim() === '') {
            return res.status(400).json({ message: 'Notes/Remarks are required.' });
        }

        // Format timestamp for initial remark
        const timestamp = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });

        // Build create data
        const createData = {
            salesperson: req.admin._id,
            companyName, contactPersonName, contactNumber, email,
            isShipper: isShipper === 'Yes',
            isConsignee: isConsignee === 'Yes',
            modeOfShipment,
            portOfLoading, portOfDestination, commodity,
            averageShipmentVolume, monthlyShipments,
            currentFreightRate, estimatedMonthlyRevenue,
            currentFreightForwarder,
            tradeLane, incoterms, specialRequirements,
            country: req.body.country || '',
            businessCountries: Array.isArray(businessCountries)
                ? businessCountries
                : (typeof businessCountries === 'string' && businessCountries.trim() ? [businessCountries.trim()] : []),
            shippingLine: shippingLine || '',
            state: state || '', pinCode: pinCode || '', feedback: feedback || '',
            remarks: `[${timestamp}]: ${remarks}`,
            status: status || 'Interested',
            followUpDate,
            history: [{
                status: status || 'Interested',
                remarks: remarks, // Capture actual entry notes
                timestamp: new Date(),
                updatedBy: req.admin._id
            }]
        };

        // If initial query provided, add it
        if (initialQuery && initialQuery.subject && initialQuery.subject.trim()) {
            createData.queryCounter = 1;
            createData.queries = [{
                queryId: 'FQ-0001',
                subject: initialQuery.subject.trim(),
                modeOfShipment: initialQuery.modeOfShipment || modeOfShipment || '',
                portOfLoading: initialQuery.portOfLoading || portOfLoading || '',
                portOfDestination: initialQuery.portOfDestination || portOfDestination || '',
                commodity: initialQuery.commodity || commodity || '',
                weight: initialQuery.weight || '',
                volume: initialQuery.volume || '',
                containerType: initialQuery.containerType || '',
                numberOfContainers: initialQuery.numberOfContainers || 0,
                expectedShipmentDate: initialQuery.expectedShipmentDate || undefined,
                quotedRate: initialQuery.quotedRate || '',
                remarks: initialQuery.remarks || '',
                status: 'Open',
                notes: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }];
        }

        const inquiry = await FreightInquiry.create(createData);

        res.status(201).json(inquiry);
    } catch (error) {
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(e => e.message);
            return res.status(400).json({ message: messages.join(', ') });
        }
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get freight inquiries (own or team)
// @route   GET /api/prospects/freight
// @access  Protected (Admin/Member)
const getFreightInquiries = async (req, res) => {
    try {
        const { scope, startDate, endDate, contactNumber, country, shippingLine, state, modeOfShipment, status } = req.query;
        const role = req.admin.role;

        let filter = {};

        // If searching by contact number, search across all records
        if (contactNumber) {
            filter.contactNumber = { $regex: contactNumber, $options: 'i' };
        } else if (scope === 'team' && (role === 'super_admin' || role === 'admin' || role === 'sales_manager')) {
            // No salesperson filter — get all
        } else {
            filter.salesperson = req.admin._id;
        }

        // Date range filter
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        // New filters
        if (country) filter.businessCountries = { $regex: country, $options: 'i' };
        if (shippingLine) filter.shippingLine = { $regex: shippingLine, $options: 'i' };
        if (state) filter.state = { $regex: state, $options: 'i' };
        if (modeOfShipment) filter.modeOfShipment = modeOfShipment;
        if (status) filter.status = status;

        const inquiries = await FreightInquiry.find(filter)
            .populate('salesperson', 'name email')
            .sort({ updatedAt: -1 });

        res.json(inquiries);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update freight inquiry
// @route   PUT /api/prospects/freight/:id
// @access  Protected (Member owner or Admin)
const updateFreightInquiry = async (req, res) => {
    try {
        const inquiry = await FreightInquiry.findById(req.params.id);
        if (!inquiry) {
            return res.status(404).json({ message: 'Freight inquiry not found' });
        }

        // Permission check: owner or admin
        const role = req.admin.role;
        if (String(inquiry.salesperson) !== String(req.admin._id) &&
            role !== 'super_admin' && role !== 'admin' && role !== 'sales_manager') {
            return res.status(403).json({ message: 'Not authorized to update this inquiry' });
        }

        // Explicitly handle all fields to ensure they are updated correctly
        const updateData = {
            companyName: req.body.companyName,
            contactPersonName: req.body.contactPersonName,
            contactNumber: req.body.contactNumber,
            email: req.body.email,
            isShipper: req.body.isShipper === 'Yes' || req.body.isShipper === true,
            isConsignee: req.body.isConsignee === 'Yes' || req.body.isConsignee === true,
            modeOfShipment: req.body.modeOfShipment,
            portOfLoading: req.body.portOfLoading,
            portOfDestination: req.body.portOfDestination,
            commodity: req.body.commodity,
            averageShipmentVolume: req.body.averageShipmentVolume,
            monthlyShipments: req.body.monthlyShipments,
            currentFreightRate: req.body.currentFreightRate,
            estimatedMonthlyRevenue: req.body.estimatedMonthlyRevenue,
            currentFreightForwarder: req.body.currentFreightForwarder,
            tradeLane: req.body.tradeLane,
            incoterms: req.body.incoterms,
            specialRequirements: req.body.specialRequirements,
            country: req.body.country,
            businessCountries: Array.isArray(req.body.businessCountries)
                ? req.body.businessCountries
                : (req.body.country ? [req.body.country] : inquiry.businessCountries),
            shippingLine: req.body.shippingLine,
            state: req.body.state,
            pinCode: req.body.pinCode,
            status: req.body.status || inquiry.status,
            followUpDate: req.body.followUpDate
        };

        // Remove undefined fields
        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        // Handle remarks with timestamp (if provided in this update)
        if (req.body.remarks && req.body.remarks.trim()) {
            const timestamp = new Date().toLocaleString('en-GB', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            const newRemark = `[${timestamp}] (${req.admin.name}): ${req.body.remarks}`;
            updateData.remarks = inquiry.remarks
                ? `${inquiry.remarks}\n${newRemark}`
                : newRemark;
        }

        // Push to history
        const historyEntry = {
            status: updateData.status || inquiry.status,
            remarks: req.body.remarks || 'Updated',
            timestamp: new Date(),
            updatedBy: req.admin._id
        };

        const updated = await FreightInquiry.findByIdAndUpdate(
            req.params.id,
            {
                ...updateData,
                $push: { history: historyEntry }
            },
            { new: true, runValidators: true }
        ).populate('salesperson', 'name email');

        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

// @desc    Get freight analytics summary (for Performance Analytics toggle)
// @route   GET /api/prospects/freight/analytics/summary
// @access  Protected (Admin)
const getFreightAnalyticsSummary = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const Admin = require('../models/Admin');

        // RBAC: resolve accessible member IDs
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else { // super_admin, sales_manager
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        let dateFilter = {};
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) dateFilter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        const matchStage = { ...dateFilter, salesperson: { $in: memberIds } };

        const [totalResult, statusCounts, bestPerformerData] = await Promise.all([
            FreightInquiry.countDocuments(matchStage),
            FreightInquiry.aggregate([
                { $match: matchStage },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            FreightInquiry.aggregate([
                { $match: matchStage },
                { $group: { _id: '$salesperson', conversions: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } } } },
                { $sort: { conversions: -1 } },
                { $limit: 1 },
                { $lookup: { from: 'admins', localField: '_id', foreignField: '_id', as: 'info' } },
                { $unwind: { path: '$info', preserveNullAndEmptyArrays: true } }
            ])
        ]);

        const statusMap = {};
        statusCounts.forEach(s => { statusMap[s._id] = s.count; });

        const totalInterested = statusMap['Interested'] || 0;
        const totalConversions = statusMap['Converted'] || 0;
        const totalFollowUps = statusMap['Follow-up'] || 0;

        let bestPerformer = null;
        if (bestPerformerData.length > 0 && bestPerformerData[0].conversions > 0) {
            bestPerformer = {
                name: bestPerformerData[0].info?.name || 'Unknown',
                conversions: bestPerformerData[0].conversions
            };
        }

        const InactiveCustomerAlert = require('../models/InactiveCustomerAlert');
        const User = require('../models/User');
        const { syncInactiveAlerts } = require('./admin/inactiveAlertController');
        
        await syncInactiveAlerts();

        let userQuery = { isAdmin: false, isRestricted: false };
        if (req.admin.role !== 'super_admin') {
            userQuery.assignedTo = { $in: memberIds };
        }

        const matchingUsers = await User.find(userQuery).select('_id');
        const matchingUserIds = matchingUsers.map(u => u._id);

        const inactiveUsersCount = await InactiveCustomerAlert.countDocuments({
            status: 'active',
            user: { $in: matchingUserIds }
        });

        res.json({
            totalCalls: totalResult,
            totalInterested,
            totalConversions,
            conversionRate: totalResult > 0 ? ((totalConversions / totalResult) * 100).toFixed(1) : 0,
            totalFollowUps,
            callBacks: statusMap['Call Back'] || 0,
            notInterested: statusMap['Not Interested'] || 0,
            inactiveUsers: inactiveUsersCount,
            bestPerformer
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get freight analytics trends (for line chart)
// @route   GET /api/prospects/freight/analytics/trends
// @access  Protected (Admin)
const getFreightAnalyticsTrends = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const Admin = require('../models/Admin');

        // RBAC
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else {
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        let matchStage = { salesperson: { $in: memberIds } };
        if (startDate || endDate) {
            matchStage.createdAt = {};
            if (startDate) matchStage.createdAt.$gte = new Date(startDate);
            if (endDate) matchStage.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        const trends = await FreightInquiry.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    calls: { $sum: 1 },
                    conversions: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        const labels = trends.map(t => t._id);
        const calls = trends.map(t => t.calls);
        const conversions = trends.map(t => t.conversions);

        res.json({
            labels,
            datasets: { calls, conversions }
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get freight analytics by member (for bar chart & table)
// @route   GET /api/prospects/freight/analytics/by-member
// @access  Protected (Admin)
const getFreightAnalyticsByMember = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const Admin = require('../models/Admin');

        // RBAC
        let memberIds = [];
        if (req.admin.role === 'member') {
            return res.status(403).json({ message: 'Access denied' });
        } else if (req.admin.role === 'admin') {
            memberIds = await Admin.find({ createdBy: req.admin._id }).distinct('_id');
        } else {
            memberIds = await Admin.find({ role: 'member' }).distinct('_id');
        }

        const members = await Admin.find({ _id: { $in: memberIds } }).select('name email');

        let matchStage = { salesperson: { $in: memberIds } };
        if (startDate || endDate) {
            matchStage.createdAt = {};
            if (startDate) matchStage.createdAt.$gte = new Date(startDate);
            if (endDate) matchStage.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        const memberStats = await FreightInquiry.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$salesperson',
                    totalCalls: { $sum: 1 },
                    conversions: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } },
                    interested: { $sum: { $cond: [{ $eq: ['$status', 'Interested'] }, 1, 0] } },
                    followUps: { $sum: { $cond: [{ $eq: ['$status', 'Follow-up'] }, 1, 0] } },
                    callBacks: { $sum: { $cond: [{ $eq: ['$status', 'Call Back'] }, 1, 0] } },
                    notInterested: { $sum: { $cond: [{ $eq: ['$status', 'Not Interested'] }, 1, 0] } }
                }
            }
        ]);

        const statsMap = memberStats.reduce((acc, curr) => {
            acc[curr._id.toString()] = curr;
            return acc;
        }, {});

        // Merge: show all members (even if 0 freight data) so the table is populated
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
                conversions,
                interested: stats.interested || 0,
                followUps: stats.followUps || 0,
                callBacks: stats.callBacks || 0,
                notInterested: stats.notInterested || 0,
                conversionRate: totalCalls > 0 ? Math.round((conversions / totalCalls) * 100) : 0
            };
        });

        result.sort((a, b) => b.totalCalls - a.totalCalls);

        res.json(result);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Export freight data as Excel
// @route   GET /api/prospects/freight/export
// @access  Protected (super_admin only)
const exportFreightData = async (req, res) => {
    try {
        // super_admin check
        if (req.admin.role !== 'super_admin') {
            return res.status(403).json({ message: 'Access denied. Super Admin only.' });
        }

        const { startDate, endDate, country, shippingLine, state, modeOfShipment, status, salesperson, search } = req.query;
        let filter = {};

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }
        if (country) filter.businessCountries = { $regex: country, $options: 'i' };
        if (shippingLine) filter.shippingLine = { $regex: shippingLine, $options: 'i' };
        if (state) filter.state = { $regex: state, $options: 'i' };
        if (modeOfShipment) filter.modeOfShipment = modeOfShipment;
        if (status) filter.status = status;
        if (salesperson) filter.salesperson = salesperson;
        if (search) {
            filter.$or = [
                { companyName: { $regex: search, $options: 'i' } },
                { contactPersonName: { $regex: search, $options: 'i' } },
                { contactNumber: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        const inquiries = await FreightInquiry.find(filter)
            .populate('salesperson', 'name email')
            .sort({ createdAt: -1 });

        const XLSX = require('xlsx');
        const rawData = inquiries.flatMap(inq => {
            const baseData = {
                'CONSIGNEE': inq.companyName || '',
                'NAME': inq.contactPersonName || '',
                'NUMBER': inq.contactNumber || '',
                'EMAIL ID': inq.email || '',
                'MAIN MODE': inq.modeOfShipment || '',
                'POL': inq.portOfLoading || '',
                'POD': inq.portOfDestination || '',
                'BUSINESS COUNTRIES': Array.isArray(inq.businessCountries) ? inq.businessCountries.join(', ') : '',
                'MAIN COMMODITY': inq.commodity || '',
                'MAIN VOLUME': inq.averageShipmentVolume || '',
                'FEEDBACK': inq.feedback || '',
                'LINE': inq.shippingLine || '',
                'STATE': inq.state || '',
                'PIN CODE': inq.pinCode || '',
                'MAIN STATUS': inq.status || '',
                'SALESPERSON': inq.salesperson?.name || '',
                'LEAD DATE': inq.createdAt ? new Date(inq.createdAt).toLocaleDateString('en-GB') : ''
            };

            if (!inq.queries || inq.queries.length === 0) {
                return [{
                    ...baseData,
                    'QUERY ID': '-',
                    'QUERY SUBJECT': '-',
                    'QUERY MODE': '-',
                    'QUERY COMMODITY': '-',
                    'WEIGHT': '-',
                    'QUERY VOLUME': '-',
                    'EXPECTED DATE': '-',
                    'QUOTED RATE': '-',
                    'QUERY STATUS': '-',
                    'QUERY REMARKS': '-',
                    'QUERY DATE': '-'
                }];
            }

            return inq.queries.map(q => ({
                ...baseData,
                'QUERY ID': q.queryId || '-',
                'QUERY SUBJECT': q.subject || '-',
                'QUERY MODE': q.modeOfShipment || '-',
                'QUERY COMMODITY': q.commodity || '-',
                'WEIGHT': q.weight || '-',
                'QUERY VOLUME': q.volume || '-',
                'EXPECTED DATE': q.expectedShipmentDate ? new Date(q.expectedShipmentDate).toLocaleDateString('en-GB') : '-',
                'QUOTED RATE': q.quotedRate || '-',
                'QUERY STATUS': q.status || '-',
                'QUERY REMARKS': q.remarks || '-',
                'QUERY DATE': q.createdAt ? new Date(q.createdAt).toLocaleDateString('en-GB') : '-'
            }));
        });

        const data = rawData.map((row, idx) => ({
            'S.NO': idx + 1,
            ...row
        }));

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Freight Data');

        // Set column widths
        ws['!cols'] = [
            // Base columns (17 cols start + S.NO = 18 cols)
            { wch: 5 }, { wch: 20 }, { wch: 18 }, { wch: 15 }, { wch: 25 },
            { wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 18 },
            { wch: 15 }, { wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 10 },
            { wch: 15 }, { wch: 15 }, { wch: 12 },
            // Query columns (11 cols)
            { wch: 15 }, { wch: 25 }, { wch: 18 }, { wch: 18 }, { wch: 12 },
            { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 12 }
        ];

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const filename = `Freight_Data_${new Date().toISOString().split('T')[0]}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ message: 'Failed to export freight data' });
    }
};

module.exports = {
    createFreightInquiry,
    getFreightInquiries,
    updateFreightInquiry,
    getFreightAnalyticsSummary,
    getFreightAnalyticsTrends,
    getFreightAnalyticsByMember,
    exportFreightData
};
