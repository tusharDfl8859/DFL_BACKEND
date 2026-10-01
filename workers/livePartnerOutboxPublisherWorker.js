const { publishPendingOutboxEvents } = require('../services/openapi/livePartnerBookingOutboxService');

const INTERVAL_MS = Number(process.env.LIVE_PARTNER_OUTBOX_PUBLISH_INTERVAL_MS || 30000);
let intervalHandle = null;
let running = false;

const runOnce = async () => {
    if (running) return;
    running = true;
    try {
        await publishPendingOutboxEvents(25);
    } catch (error) {
        console.error('Live Partner API outbox publisher failed:', error && error.message ? error.message : error);
    } finally {
        running = false;
    }
};

const startLivePartnerOutboxPublisher = () => {
    if (intervalHandle || process.env.NODE_ENV === 'test') {
        return intervalHandle;
    }
    intervalHandle = setInterval(runOnce, INTERVAL_MS);
    if (intervalHandle.unref) {
        intervalHandle.unref();
    }
    return intervalHandle;
};

const stopLivePartnerOutboxPublisher = () => {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startLivePartnerOutboxPublisher();
}

module.exports = {
    runOnce,
    startLivePartnerOutboxPublisher,
    stopLivePartnerOutboxPublisher
};
