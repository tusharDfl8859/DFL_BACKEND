const Admin = require('../../models/Admin');
const User = require('../../models/User');
const Prospect = require('../../models/Prospect');
const { logActivity } = require('../../utils/activityLogger');
const mongoose = require('mongoose');

// @desc    Get all clients (Users & Prospects) assigned to a member
// @route   GET /api/admin/team/:id/clients
// @access  Private/Admin
const getMemberClients = async (req, res) => {
    try {
        const { id } = req.params;

        const member = await Admin.findById(id).select('name email role');
        if (!member) {
            return res.status(404).json({ message: 'Team member not found' });
        }

        // 1. Get Assigned Users (Customers)
        const users = await User.find({ assignedTo: id })
            .select('name email customerId companyName kycVerified status createdAt isRestricted')
            .sort({ createdAt: -1 });

        // 2. Get Assigned Prospects
        const prospects = await Prospect.find({ salesperson: id })
            .sort({ createdAt: -1 });

        res.json({
            member,
            counts: {
                users: users.length,
                prospects: prospects.length
            },
            users,
            prospects
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Reassign selected clients to another member
// @route   POST /api/admin/team/reassign
// @access  Private/Admin, SuperAdmin
const reassignClients = async (req, res) => {
    try {
        const { oldMemberId, newMemberId, userIds = [], prospectIds = [] } = req.body;

        if (!oldMemberId || !newMemberId) {
            return res.status(400).json({ message: 'Old and New Member IDs are required' });
        }

        if (oldMemberId === newMemberId) {
            return res.status(400).json({ message: 'Cannot reassign to the same member' });
        }

        const newMember = await Admin.findById(newMemberId);
        if (!newMember) {
            return res.status(404).json({ message: 'Target team member not found' });
        }

        let usersUpdated = 0;
        let prospectsUpdated = 0;

        // 1. Reassign Users
        if (userIds.length > 0) {
            // Restriction Check
            const restrictedUsers = await User.find({ _id: { $in: userIds }, isRestricted: true });
            if (restrictedUsers.length > 0) {
                if (newMember.designation !== 'Sales Manager' && newMember.role !== 'super_admin') {
                    return res.status(403).json({
                        message: `Selection includes ${restrictedUsers.length} restricted customer(s) that can only be assigned to a Sales Manager.`
                    });
                }
            }

            const result = await User.updateMany(
                { _id: { $in: userIds }, assignedTo: oldMemberId },
                {
                    $set: {
                        assignedTo: newMemberId,
                        branch: newMember.branch || null,
                        branchUpdatedBy: req.admin.name
                    }
                }
            );
            usersUpdated = result.modifiedCount;

            // Log individual assignments for history tracing
            if (usersUpdated > 0) {
                const updatedUsersData = await User.find({ _id: { $in: userIds }, assignedTo: newMemberId });
                for (const u of updatedUsersData) {
                    await logActivity(req, {
                        action: 'ASSIGN_USER_BULK',
                        target: u._id.toString(),
                        targetModel: 'User',
                        details: {
                            userName: u.name,
                            oldAssignedTo: oldMemberId,
                            newAssignedTo: newMemberId
                        }
                    });
                }
            }
        }

        // 2. Reassign Prospects
        if (prospectIds.length > 0) {
            const result = await Prospect.updateMany(
                { _id: { $in: prospectIds }, salesperson: oldMemberId },
                { $set: { salesperson: newMemberId } }
            );
            prospectsUpdated = result.modifiedCount;
        }

        // Log Activity
        await logActivity(req, {
            action: 'REASSIGN_CLIENTS',
            target: oldMemberId,
            targetModel: 'Admin',
            details: {
                oldMemberId,
                newMemberId,
                targetName: newMember.name,
                usersMoved: usersUpdated,
                prospectsMoved: prospectsUpdated
            }
        });

        res.json({
            message: `Successfully reassigned ${usersUpdated} users and ${prospectsUpdated} prospects to ${newMember.name}`,
            stats: {
                usersUpdated,
                prospectsUpdated
            }
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getMemberClients,
    reassignClients
};
