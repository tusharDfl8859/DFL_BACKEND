const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
    // Create transporter with fallback to Gmail defaults
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_EMAIL,
            pass: process.env.SMTP_PASSWORD
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    const message = {
        from: options.from || `${process.env.FROM_NAME || 'DFL Group'} <${process.env.SMTP_EMAIL}>`,
        to: options.to || options.email,
        replyTo: options.replyTo,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments
    };
    try {
        const info = await transporter.sendMail(message);
        return info;
    } catch (error) {
        throw error; // Re-throw to allow caller to handle
    }
};

module.exports = sendEmail;
