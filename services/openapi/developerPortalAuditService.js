const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const {
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES
} = require('../../constants/developerPortal');

const safeUserAgent = (userAgent) => (
    typeof userAgent === 'string' ? userAgent.slice(0, 512) : null
);

const createDeveloperAudit = async ({
    actorType,
    actorId = null,
    actorRole = null,
    action,
    targetType = DEVELOPER_AUDIT_TARGET_TYPES.DEVELOPER_APPLICATION,
    targetId = null,
    userId = null,
    developerAccountId = null,
    environment = null,
    previousValue = null,
    newValue = null,
    reason = null,
    requestId = null,
    ipAddress = null,
    userAgent = null,
    session = null
}) => DeveloperAuditLog.create([{
    actorType,
    actorId,
    actorRole,
    action,
    targetType,
    targetId,
    userId,
    developerAccountId,
    environment,
    previousValue,
    newValue,
    reason,
    requestId,
    ipAddress,
    userAgent: safeUserAgent(userAgent)
}], { session }).then(([audit]) => audit);

const createCustomerAudit = (params) => createDeveloperAudit({
    ...params,
    actorType: DEVELOPER_AUDIT_ACTOR_TYPES.CUSTOMER
});

const createAdminAudit = (params) => createDeveloperAudit({
    ...params,
    actorType: DEVELOPER_AUDIT_ACTOR_TYPES.ADMIN
});

module.exports = {
    createDeveloperAudit,
    createCustomerAudit,
    createAdminAudit
};
