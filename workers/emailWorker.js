const { Worker } = require('bullmq');
const path = require('path');
const { redisConfig } = require('../config/redisConfig');
const sendEmail = require('../utils/emailService');
const { generateAdminNewOrderAlert, generateOrderConfirmationEmail } = require('../utils/emailTemplates');

let emailWorker;

const processEmail = async (job) => {
    try {
        if (job.data.type === 'admin-alert') {
            const adminHtml = generateAdminNewOrderAlert(job.data.shipmentData);
            const customerName = job.data.shipmentData.user?.name || 'Customer';
            await sendEmail({
                email: job.data.email, // Admin email passed in job
                subject: `New Order #${job.data.shipmentData.shipmentId} from ${customerName} - ${job.data.shipmentData.shipperDetails.city} to ${job.data.shipmentData.consigneeDetails.city}`,
                html: adminHtml,
                attachments: [{
                    filename: 'dfl_longo.png',
                    path: path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png'),
                    cid: 'dfl_logo'
                }]
            });

        } else if (job.data.type === 'user-confirmation') {
            const userHtml = generateOrderConfirmationEmail(job.data.shipmentData);
            // Fallback to consignee name if user object isn't fully populated in the job
            const customerName = job.data.shipmentData.user?.name || job.data.shipmentData.consigneeDetails?.consigneeName || 'Customer';
            await sendEmail({
                email: job.data.email,
                subject: `Sales Order #${job.data.shipmentData.shipmentId} - Order Confirmation for ${customerName}`,
                html: userHtml,
                from: 'noreply@thedflgroup.com',
                attachments: [{
                    filename: 'dfl_longo.png',
                    path: path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png'),
                    cid: 'dfl_logo'
                }]
            });

        } else if (job.data.type === 'bulk-summary') {
            const { bulkOrderId, total, completed, failed, bookingStatus } = job.data;
            const summaryHtml = `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
                    <div style="text-align: center; padding: 24px 0; border-bottom: 1px solid #f1f5f9;">
                        <h2 style="color: #0B4F6C; margin: 0; font-size: 24px; font-weight: 700;">DFL Group</h2>
                    </div>
                    <div style="padding: 32px;">
                        <h3 style="color: #0f172a; margin-top: 0; margin-bottom: 16px; font-size: 18px; font-weight: 600;">Bulk Order Processing Complete</h3>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6;">Your bulk order <strong>${bulkOrderId}</strong> has finished processing.</p>
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 20px;">
                            <tr>
                                <td style="padding: 8px 0; color: #64748b;">Total Orders:</td>
                                <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${total}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b;">Successful:</td>
                                <td style="padding: 8px 0; color: #059669; font-weight: 600;">${completed}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b;">Failed:</td>
                                <td style="padding: 8px 0; color: #dc2626; font-weight: 600;">${failed}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b;">Status:</td>
                                <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${bookingStatus}</td>
                            </tr>
                        </table>
                        ${failed > 0 ? `<p style="color: #94a3b8; font-size: 13px; margin-top: 20px;">Visit the Bulk Orders page to download the failed orders and correct them.</p>` : ''}
                    </div>
                </div>
            `;
            await sendEmail({
                email: job.data.email,
                subject: `Bulk Order ${bulkOrderId} — ${completed} Success, ${failed} Failed`,
                html: summaryHtml
            });

        } else if (job.data.type === 'shipment-booked') {
            const { generateShipmentBookedEmail } = require('../utils/emailTemplates');
            const html = generateShipmentBookedEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `Order Received – Shipment Booked with [Shipment #${job.data.shipmentData.shipmentId}]`,
                html: html
            });

        } else if (job.data.type === 'shipment-processing') {
            const { generateShipmentProcessingEmail } = require('../utils/emailTemplates');
            const html = generateShipmentProcessingEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `Update: Shipment #${job.data.shipmentData.shipmentId} is Being Processed`,
                html: html
            });

        } else if (job.data.type === 'shipment-received') {
            const { generateShipmentReceivedEmail } = require('../utils/emailTemplates');
            const html = generateShipmentReceivedEmail(job.data.name, job.data.shipmentData, job.data.hubLocation);
            await sendEmail({
                email: job.data.email,
                subject: `Package Received at Operations Hub [Shipment #${job.data.shipmentData.shipmentId}]`,
                html: html
            });

        } else if (job.data.type === 'shipment-dispute') {
            const { generateShipmentDisputeEmail } = require('../utils/emailTemplates');
            const html = generateShipmentDisputeEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `Dispute Acknowledgment – Shipment #${job.data.shipmentData.shipmentId}`,
                html: html
            });

        } else if (job.data.type === 'shipment-delivered') {
            const { generateShipmentDeliveredEmail } = require('../utils/emailTemplates');
            const html = generateShipmentDeliveredEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `Delivered! Shipment #${job.data.shipmentData.shipmentId}`,
                html: html
            });

        } else if (job.data.type === 'shipment-intransit') {
            const { generateShipmentInTransitEmail } = require('../utils/emailTemplates');
            const html = generateShipmentInTransitEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `On the Move: Shipment #${job.data.shipmentData.shipmentId} is In Transit`,
                html: html
            });

        } else if (job.data.type === 'shipment-dispute-resolved') {
            const { generateShipmentDisputeResolvedEmail } = require('../utils/emailTemplates');
            const html = generateShipmentDisputeResolvedEmail(job.data.name, job.data.shipmentData, job.data.resolutionDetails);
            await sendEmail({
                email: job.data.email,
                subject: `Update: Dispute Resolved – Shipment #${job.data.shipmentData.shipmentId}`,
                html: html
            });

        } else if (job.data.type === 'shipment-out-for-delivery') {
            const { generateShipmentOutForDeliveryEmail } = require('../utils/emailTemplates');
            const html = generateShipmentOutForDeliveryEmail(job.data.name, job.data.shipmentData);
            await sendEmail({
                email: job.data.email,
                subject: `Out for Delivery: Shipment #${job.data.shipmentData.shipmentId}`,
                html: html
            });

        } else {
            // Standard/Legacy email
            await sendEmail({
                email: job.data.email,
                subject: job.data.subject,
                html: job.data.html
            });
        }

    } catch (error) {
        // Throw so BullMQ can handle retries automatically
        throw new Error(`Email delivery failed for ${job.data.email} [type: ${job.data.type || 'standard'}]: ${error.message}`);
    }
};

// ─── WORKER INIT ─────────────────────────────────────────────────────────────
if (process.env.BYPASS_REDIS === 'true') {
    emailWorker = { on: () => {} };
} else {
    emailWorker = new Worker('email-queue', processEmail, {
        connection: redisConfig,
        concurrency: 10
    });
}

// ─── WORKER EVENTS ───────────────────────────────────────────────────────────
emailWorker.on('completed', (job) => {
    // Job completed successfully — BullMQ marks it done in Redis
});

emailWorker.on('failed', (job, err) => {
    // Job permanently failed after all retries — error stored in BullMQ job record
    // Admin can inspect failed jobs via Bull Board or Redis directly
});

module.exports = {
    emailWorker,
    processEmail
};