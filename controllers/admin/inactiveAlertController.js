const InactiveCustomerAlert = require('../../models/InactiveCustomerAlert');
const User = require('../../models/User');
const Shipment = require('../../models/Shipment');
const Admin = require('../../models/Admin');

/**
 * Syncs inactive customer alerts by calculating the inactivity threshold.
 * Runs in the background and before returning dashboard stats or alerts.
 */
const syncInactiveAlerts = async () => {
    try {
        // 1. Get all non-admin, non-restricted users
        const users = await User.find({ isAdmin: false, isRestricted: false }).select('_id createdAt');
        if (users.length === 0) return;

        // 2. Fetch the latest booking date for all users in parallel via aggregation
        const lastShipmentDates = await Shipment.aggregate([
            { $group: { _id: "$user", lastBookingDate: { $max: "$createdAt" } } }
        ]);

        const bookingMap = new Map();
        lastShipmentDates.forEach(item => {
            if (item._id) {
                bookingMap.set(item._id.toString(), item.lastBookingDate);
            }
        });

        const bulkOps = [];
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

        for (const user of users) {
            const userIdStr = user._id.toString();
            const lastBookingDate = bookingMap.get(userIdStr);
            const referenceDate = lastBookingDate ? new Date(lastBookingDate) : new Date(user.createdAt);

            const isInactive = referenceDate < tenDaysAgo;

            if (isInactive) {
                // Customer is inactive, upsert active alert
                bulkOps.push({
                    updateOne: {
                        filter: { user: user._id },
                        update: {
                            $set: {
                                lastBookingDate: lastBookingDate || null,
                                status: 'active'
                            }
                        },
                        upsert: true
                    }
                });
            } else {
                // Customer is active (diffDays < 10), close alert if active
                bulkOps.push({
                    updateOne: {
                        filter: { user: user._id, status: 'active' },
                        update: {
                            $set: { 
                                status: 'closed',
                                lastBookingDate: lastBookingDate || null
                            }
                        }
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await InactiveCustomerAlert.bulkWrite(bulkOps);
        }
    } catch (error) {
        console.error('Error in syncInactiveAlerts:', error);
    }
};

/**
 * @desc    Get Active Inactive Customer Alerts
 * @route   GET /api/admin/inactive-alerts
 * @access  Private/Admin
 */
const getInactiveAlerts = async (req, res) => {
    try {
        // Sync before fetching to ensure 100% up-to-date data
        await syncInactiveAlerts();

        let userQuery = { isAdmin: false, isRestricted: false };

        // Role-based filtering
        if (req.admin.role === 'member') {
            userQuery.assignedTo = req.admin._id;
        } else if (req.admin.role === 'sales_manager') {
            const reportingAdmins = await Admin.find({ reportsTo: req.admin._id }).select('_id');
            const adminIds = reportingAdmins.map(a => a._id);
            userQuery.assignedTo = { $in: adminIds };
        }

        const matchingUsers = await User.find(userQuery).select('_id');
        const matchingUserIds = matchingUsers.map(u => u._id);

        const alerts = await InactiveCustomerAlert.find({
            status: 'active',
            user: { $in: matchingUserIds }
        })
        .populate({
            path: 'user',
            select: 'name email phone customerId assignedTo createdAt',
            populate: {
                path: 'assignedTo',
                select: 'name email'
            }
        })
        .sort({ updatedAt: -1 });

        res.json({
            count: alerts.length,
            alerts
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Add follow-up remark to an alert
 * @route   POST /api/admin/inactive-alerts/:id/remarks
 * @access  Private/Admin
 */
const addAlertRemarks = async (req, res) => {
    try {
        const { id } = req.params;
        const { comment } = req.body;

        if (!comment || comment.trim() === '') {
            return res.status(400).json({ message: 'Comment/Remark is required' });
        }

        const alert = await InactiveCustomerAlert.findById(id);
        if (!alert) {
            return res.status(404).json({ message: 'Alert not found' });
        }

        alert.remarks.push({
            comment,
            addedBy: req.admin._id,
            addedByName: req.admin.name || 'Admin',
            createdAt: new Date()
        });

        await alert.save();

        res.json({
            message: 'Remark added successfully',
            alert
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    syncInactiveAlerts,
    getInactiveAlerts,
    addAlertRemarks
};
