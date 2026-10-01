const sendEmail = require('./emailService');

const sendBookingFailureAlert = async (shipmentId, carrier, errorMessage, payload = {}) => {
    try {
        // Define recipients. We can add multiple emails to BOOKING_ALERT_EMAILS in .env separated by comma
        const alertEmails = process.env.BOOKING_ALERT_EMAILS 
            ? process.env.BOOKING_ALERT_EMAILS.split(',').map(e => e.trim())
            : [
                'kaushal.tech@thedflgroup.com',
                'tushar.tech@thedflgroup.com',
                'sahil.tech@thedflgroup.com',
                'marketing1@dflindia.in'
              ];

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #d9534f;">🚨 Carrier Booking Failed</h2>
                <p>An API booking request to a carrier has failed. Details are below:</p>
                <table style="width: 100%; max-width: 600px; border-collapse: collapse; margin-top: 15px;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; width: 150px;">Shipment ID</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${shipmentId || 'N/A'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Carrier</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${carrier || 'Unknown'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">Error Message</td>
                        <td style="padding: 10px; border: 1px solid #ddd; color: #d9534f;">${errorMessage || 'No error message provided'}</td>
                    </tr>
                </table>
                <h3 style="margin-top: 25px;">Payload / Error Details:</h3>
                <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 13px;">${JSON.stringify(payload, null, 2)}</pre>
                <br/>
                <p>Please check the admin panel logs or the database for more details and manual resolution.</p>
                <p style="font-size: 12px; color: #888;">This is an automated system alert.</p>
            </div>
        `;

        await sendEmail({
            email: alertEmails.join(','),
            subject: `🚨 URGENT: Booking Failed for ${shipmentId} (${carrier})`,
            html: emailHtml
        });
        
        console.log(`[BookingAlert] Failure alert sent to ${alertEmails.join(',')} for ${shipmentId}`);
    } catch (err) {
        console.error('[BookingAlert] Failed to send booking failure alert email:', err.message);
    }
};

module.exports = {
    sendBookingFailureAlert
};
