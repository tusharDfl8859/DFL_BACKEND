/**
 * Safe Chatbot Audit Logging Service
 * Ensures zero secrets, JWT tokens, or unmasked PII ever reach audit logs.
 */

const logChatbotEvent = (eventData) => {
    const { requestId, userId, intent, latency, status, errorCategory } = eventData;
    const auditRecord = {
        timestamp: new Date().toISOString(),
        requestId: requestId || `req-${Date.now()}`,
        userId: userId ? String(userId) : 'anonymous',
        intent: intent || 'UNKNOWN',
        latencyMs: latency || 0,
        status: status || 'SUCCESS',
        errorCategory: errorCategory || null
    };

    // Safe console logging without PII or keys
    if (status === 'ERROR') {
        console.warn('[CHATBOT_AUDIT_WARNING]', JSON.stringify(auditRecord));
    } else {
        console.log('[CHATBOT_AUDIT]', JSON.stringify(auditRecord));
    }

    return auditRecord;
};

module.exports = {
    logChatbotEvent
};
