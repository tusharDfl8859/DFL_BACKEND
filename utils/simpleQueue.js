const sendEmail = require('./emailService');
const path = require('path');
const { generateAdminNewOrderAlert } = require('./emailTemplates');

class SimpleQueue {
    constructor(name) {
        this.name = name;
    }

    async add(name, data) {
        try {
            if (data.type === 'admin-alert') {
                const adminHtml = generateAdminNewOrderAlert(data.shipmentData);
                await sendEmail({
                    email: data.email,
                    subject: `New Order #${data.shipmentData.shipmentId} - ${data.shipmentData.shipperDetails.city} to ${data.shipmentData.consigneeDetails.city}`,
                    html: adminHtml,
                    attachments: [{
                        filename: 'dfl_longo.png',
                        path: path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png'),
                        cid: 'dfl_logo'
                    }]
                });
            } else {
                await sendEmail({
                    email: data.email,
                    subject: data.subject,
                    html: data.html
                });
            }
        } catch (err) {
            console.error(`Failed to process ${this.name} job ${name}:`, err);
        }
    }
}

module.exports = SimpleQueue;
