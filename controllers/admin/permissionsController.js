const Admin = require('../../models/Admin');
const ActivityLog = require('../../models/ActivityLog');
const { ROLE_PERMISSIONS, getEffectivePermissions } = require('../../utils/permissions');
const { logActivity } = require('../../utils/activityLogger');

const ROLE_LEVELS = {
    super_admin: 100,
    admin: 80,
    sales_manager: 50,
    franchise_manager: 50,
    operation: 50,
    customer_support: 40,
    member: 10
};

const checkSuperAdmin = async (req, res) => {
    const effective = getEffectivePermissions(req.admin);
    const hasAccess = req.admin && (req.admin.role === 'super_admin' || effective.includes('permissions:manage'));

    if (!hasAccess) {
        await logActivity(req, {
            action: 'SECURITY_INCIDENT',
            status: 'FAILURE',
            details: {
                message: 'Unauthorized attempt to access permissions management resource.',
                endpoint: req.originalUrl,
                method: req.method,
                actorRole: req.admin?.role,
                actorEmail: req.admin?.email,
                actorName: req.admin?.name
            }
        });
        res.status(403).json({ message: 'Not authorized' });
        return false;
    }
    return true;
};

// @desc    Get all members with their computed effective permissions
// @route   GET /api/admin/permissions/members
// @access  Private (permissions:manage)
const getMembers = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const members = await Admin.find({})
            .select('-password')
            .populate('createdBy', 'name email')
            .populate('reportsTo', 'name email')
            .sort({ createdAt: -1 });

        const computedMembers = members.map(member => {
            const memberObj = member.toObject();
            return {
                ...memberObj,
                effectivePermissions: getEffectivePermissions(member)
            };
        });

        res.json(computedMembers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update a member's role and/or custom permission overrides
// @route   PUT /api/admin/permissions/members/:id
// @access  Private (permissions:manage)
const updateMemberPermissions = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const targetId = req.params.id;
        const { role, permissions, password, isActive } = req.body; // permissions: array of string overrides

        const targetMember = await Admin.findById(targetId);
        if (!targetMember) {
            return res.status(404).json({ message: 'Target member not found' });
        }

        const requester = req.admin;
        const requesterLevel = ROLE_LEVELS[requester.role] || 0;
        const targetLevel = ROLE_LEVELS[targetMember.role] || 0;

        // 1. Hierarchy checks: requester cannot edit someone of equal or higher authority
        if (requester.role !== 'super_admin') {
            if (requesterLevel <= targetLevel) {
                return res.status(403).json({
                    message: 'Access denied. You cannot modify the role or permissions of a member with equal or higher authority.'
                });
            }

            // Requester cannot assign a role higher than their own
            if (role && (ROLE_LEVELS[role] || 0) >= requesterLevel) {
                return res.status(403).json({
                    message: `Access denied. You cannot assign the role '${role}' because it is equal to or higher than your own.`
                });
            }

            // Requester cannot grant permissions they do not have themselves
            if (permissions && permissions.length > 0) {
                const requesterEffective = getEffectivePermissions(requester);
                const grants = permissions.filter(p => p && !p.startsWith('-'));
                const invalidGrants = grants.filter(p => !requesterEffective.includes(p));

                if (invalidGrants.length > 0) {
                    return res.status(403).json({
                        message: `Access denied. You cannot grant permissions you do not have: ${invalidGrants.join(', ')}`
                    });
                }
            }
        }

        // 2. Lockout protection: prevent demoting or deactivating the last active super_admin
        if (targetMember.role === 'super_admin' && ((role && role !== 'super_admin') || isActive === false)) {
            const superAdminCount = await Admin.countDocuments({ role: 'super_admin', isActive: true });
            if (superAdminCount <= 1) {
                return res.status(400).json({
                    message: 'Lockout prevention: Cannot demote or deactivate the last remaining active Super Admin.'
                });
            }
        }

        const oldRole = targetMember.role;
        const oldPermissions = targetMember.permissions || [];
        const oldIsActive = targetMember.isActive !== false;

        // Apply changes
        if (role) targetMember.role = role;
        if (permissions) targetMember.permissions = permissions;
        if (password) targetMember.password = password;
        if (isActive !== undefined) {
            targetMember.isActive = isActive;
            if (isActive === false) {
                targetMember.passwordChangedAt = new Date(); // Invalidate sessions instantly
            }
        }

        const updatedMember = await targetMember.save();

        // 3. Log activity for audit trail
        await logActivity(req, {
            action: 'UPDATE_MEMBER_ACCESS',
            target: targetMember._id.toString(),
            targetModel: 'Admin',
            details: {
                targetName: targetMember.name,
                targetEmail: targetMember.email,
                oldRole,
                newRole: role || oldRole,
                oldPermissions,
                newPermissions: permissions || oldPermissions,
                oldIsActive,
                newIsActive: isActive !== undefined ? isActive : oldIsActive
            }
        });

        res.json({
            ...updatedMember.toObject(),
            effectivePermissions: getEffectivePermissions(updatedMember)
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get roles and default permissions matrix
// @route   GET /api/admin/permissions/roles
// @access  Private (Admin context)
const getRoles = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        res.json(ROLE_PERMISSIONS);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get roles and permissions change history (Audit Log)
// @route   GET /api/admin/permissions/history
// @access  Private (permissions:manage)
const getHistory = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const historyLogs = await ActivityLog.find({ action: 'UPDATE_MEMBER_ACCESS' })
            .populate('actor', 'name email role')
            .populate('target', 'name email role')
            .sort({ createdAt: -1 })
            .limit(100);

        res.json(historyLogs);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Terminate all active sessions for all administrators globally
// @route   POST /api/admin/permissions/terminate-all
// @access  Private (super_admin)
const terminateAllSessions = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const now = new Date();
        // Update all administrators
        await Admin.updateMany({}, { $set: { passwordChangedAt: now } });

        // Log global termination action
        await logActivity(req, {
            action: 'UPDATE_MEMBER_ACCESS',
            details: {
                actionDetails: 'TERMINATED_ALL_SESSIONS_GLOBALLY',
                message: 'All administrative sessions were forced to log out globally.'
            }
        });

        res.json({ message: 'All active sessions globally have been successfully terminated.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Terminate sessions for a specific administrator member
// @route   POST /api/admin/permissions/members/:id/terminate
// @access  Private (super_admin)
const terminateMemberSessions = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const targetId = req.params.id;
        const targetMember = await Admin.findById(targetId);
        if (!targetMember) {
            return res.status(404).json({ message: 'Target member not found' });
        }

        const requester = req.admin;
        const requesterLevel = ROLE_LEVELS[requester.role] || 0;
        const targetLevel = ROLE_LEVELS[targetMember.role] || 0;

        // Hierarchy validation: requester cannot terminate someone of equal or higher authority
        if (requester.role !== 'super_admin' && requesterLevel <= targetLevel) {
            return res.status(403).json({
                message: 'Access denied. You cannot terminate sessions of a member with equal or higher authority.'
            });
        }

        const now = new Date();
        targetMember.passwordChangedAt = now;
        await targetMember.save();

        // Log termination action
        await logActivity(req, {
            action: 'UPDATE_MEMBER_ACCESS',
            target: targetMember._id.toString(),
            targetModel: 'Admin',
            details: {
                targetName: targetMember.name,
                targetEmail: targetMember.email,
                actionDetails: 'TERMINATED_MEMBER_SESSIONS',
                message: `Sessions for ${targetMember.name} were forced to terminate.`
            }
        });

        res.json({ message: `Active sessions for ${targetMember.name} have been successfully terminated.` });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete a member permanently from the system
// @route   DELETE /api/admin/permissions/members/:id
// @access  Private (super_admin)
const deleteMember = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const targetId = req.params.id;
        const targetMember = await Admin.findById(targetId);
        if (!targetMember) {
            return res.status(404).json({ message: 'Target member not found' });
        }

        const requester = req.admin;
        const requesterLevel = ROLE_LEVELS[requester.role] || 0;
        const targetLevel = ROLE_LEVELS[targetMember.role] || 0;

        // 1. Hierarchy checks: requester cannot delete someone of equal or higher authority
        if (requester.role !== 'super_admin' && requesterLevel <= targetLevel) {
            return res.status(403).json({
                message: 'Access denied. You cannot delete a member with equal or higher authority.'
            });
        }

        // 2. Lockout protection: prevent deleting the last active super_admin
        if (targetMember.role === 'super_admin') {
            const superAdminCount = await Admin.countDocuments({ role: 'super_admin' });
            if (superAdminCount <= 1) {
                return res.status(400).json({
                    message: 'Lockout prevention: Cannot delete the last remaining Super Admin.'
                });
            }
        }

        const memberName = targetMember.name;
        const memberEmail = targetMember.email;
        const memberRole = targetMember.role;

        await Admin.findByIdAndDelete(targetId);

        // 3. Log activity for audit trail
        await logActivity(req, {
            action: 'UPDATE_MEMBER_ACCESS',
            details: {
                actionDetails: 'DELETE_MEMBER_PERMANENTLY',
                targetName: memberName,
                targetEmail: memberEmail,
                targetRole: memberRole,
                message: `Member ${memberName} (${memberEmail}) was permanently deleted from the database.`
            }
        });

        res.json({ message: `Member ${memberName} has been permanently deleted.` });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Clear all permissions change history logs
// @route   DELETE /api/admin/permissions/history
// @access  Private (super_admin)
const clearHistory = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        await ActivityLog.deleteMany({ action: 'UPDATE_MEMBER_ACCESS' });
        res.json({ message: 'All access control logs have been successfully cleared.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get security incident reports (unauthorized access attempts)
// @route   GET /api/admin/permissions/incidents
// @access  Private (super_admin)
const getIncidents = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        const incidents = await ActivityLog.find({ action: 'SECURITY_INCIDENT' })
            .populate('actor', 'name email role')
            .sort({ createdAt: -1 })
            .limit(100);
        res.json(incidents);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Clear all security incident reports
// @route   DELETE /api/admin/permissions/incidents
// @access  Private (super_admin)
const clearIncidents = async (req, res) => {
    if (!(await checkSuperAdmin(req, res))) return;
    try {
        await ActivityLog.deleteMany({ action: 'SECURITY_INCIDENT' });
        res.json({ message: 'All security incident reports have been successfully cleared.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getMembers,
    updateMemberPermissions,
    getRoles,
    getHistory,
    terminateAllSessions,
    terminateMemberSessions,
    deleteMember,
    clearHistory,
    getIncidents,
    clearIncidents
};
