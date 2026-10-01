const sendEmail = require('../utils/emailService');

exports.submitContactForm = async (req, res) => {
    try {
        const { name, email, phone, subject, message } = req.body;

        if (!name || !email || !message) {
            return res.status(400).json({ success: false, message: 'Please provide name, email and message' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ success: false, message: 'Please enter a valid email address format (e.g. name@domain.com)' });
        }

        const emailContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Contact Inquiry</title>
                <style>
                    body { margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; -webkit-font-smoothing: antialiased; }
                    .wrapper { width: 100%; background-color: #f1f5f9; padding: 40px 0; }
                    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
                    .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 40px 0; text-align: center; }
                    .header-title { color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 1px; margin: 0; text-transform: uppercase; }
                    .header-subtitle { color: #fb923c; font-size: 14px; font-weight: 500; margin-top: 5px; text-transform: uppercase; letter-spacing: 2px; }
                    .body { padding: 40px; }
                    .info-table { width: 100%; border-collapse: separate; border-spacing: 0 12px; }
                    .info-cell-label { width: 120px; color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase; vertical-align: top; padding-top: 4px; }
                    .info-cell-value { color: #0f172a; font-size: 16px; font-weight: 500; vertical-align: top; }
                    .message-card { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-top: 30px; }
                    .message-label { display: block; color: #fb923c; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; mb: 12px; }
                    .message-content { color: #334155; font-size: 15px; line-height: 1.7; margin: 0; white-space: pre-line; }
                    .footer { background-color: #f8fafc; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0; }
                    .footer-text { color: #94a3b8; font-size: 12px; margin: 0; }
                    a { color: #0f172a; text-decoration: none; border-bottom: 1px dotted #94a3b8; }
                </style>
            </head>
            <body>
                <div class="wrapper">
                    <div class="container">
                        <div class="header">
                            <h1 class="header-title">DFL GROUP</h1>
                            <div class="header-subtitle">Logistics Inquiry</div>
                        </div>
                        <div class="body">
                            <table class="info-table">
                                <tr>
                                    <td class="info-cell-label">From</td>
                                    <td class="info-cell-value"><strong>${name}</strong></td>
                                </tr>
                                <tr>
                                    <td class="info-cell-label">Email</td>
                                    <td class="info-cell-value"><a href="mailto:${email}">${email}</a></td>
                                </tr>
                                <tr>
                                    <td class="info-cell-label">Subject</td>
                                    <td class="info-cell-value">${subject || 'General Inquiry'}</td>
                                </tr>
                            </table>
                            
                            <div class="message-card">
                                <span class="message-label" style="display:block; margin-bottom:12px;">Message Details</span>
                                <p class="message-content">${message}</p>
                            </div>
                        </div>
                        <div class="footer">
                            <p class="footer-text">This email was sent securely from the DFL Group Contact Form.</p>
                            <p class="footer-text" style="marginTop: 8px">&copy; ${new Date().getFullYear()} DFL Group. All rights reserved.</p>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;

        const SUPPORT_EMAILS = [
            'courier@thedflgroup.com',
            'pb@thedflgroup.com',
            'support@thedflexpress.com'
        ];
        const recipientEmail = process.env.CONTACT_EMAIL || SUPPORT_EMAILS.join(', ');
        await sendEmail({
            to: recipientEmail,
            subject: `New Support Request from ${name}`,
            html: emailContent,
            from: `"${name}" <${process.env.SMTP_EMAIL || 'noreply@thedflgroup.com'}>`,
            replyTo: email
        });

        res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to send message' });
    }
};
