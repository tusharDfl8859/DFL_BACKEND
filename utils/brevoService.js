const axios = require('axios');
const sendEmail = require('./emailService');

/**
 * Send a bulk email using Brevo Transactional Email API with SMTP fallback
 * @param {Object} options - Email options
 * @param {string} options.toEmail - Recipient email
 * @param {string} options.toName - Recipient name
 * @param {string} options.subject - Email subject
 * @param {number} options.templateId - Brevo Template ID
 * @param {Object} options.params - Dynamic variables for the template
 */
const sendBrevoEmail = async ({ toEmail, toName, subject, templateId, params, senderEmail, senderName }) => {
    const apiKey = (process.env.BREVO_API_KEY || '').trim();
    const finalSenderEmail = (senderEmail || process.env.BREVO_SENDER_EMAIL || 'noreply@thedflgroup.com').trim();
    const finalSenderName = (senderName || process.env.BREVO_SENDER_NAME || 'DFL Group').trim();

    if (!apiKey) {
        throw new Error('BREVO_API_KEY is not defined in environment variables');
    }

    // Construct the email payload
    const payload = {
        sender: {
            name: finalSenderName,
            email: finalSenderEmail
        },
        to: [
            {
                email: toEmail,
                name: toName
            }
        ],
        subject: subject
    };

    // If templateId is provided, use it. Otherwise, use htmlContent.
    if (templateId && templateId !== '0') {
        payload.templateId = parseInt(templateId);
        payload.params = params;
    } else if (params?.htmlContent) {
        payload.htmlContent = params.htmlContent;
    } else {
        throw new Error('Either templateId or htmlContent must be provided');
    }

    try {
        // Try Brevo API first
        const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
            headers: {
                'api-key': apiKey,
                'x-sib-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        // Fallback to SMTP if Brevo API fails (especially for unauthorized/invalid keys)
        try {
            const smtpResult = await sendEmail({
                email: toEmail,
                subject: subject,
                html: params?.htmlContent || `<h1>${subject}</h1><p>Template used: ${templateId}</p>`
            });
            return { success: true, method: 'SMTP Fallback', messageId: smtpResult.messageId };
        } catch (smtpError) {
            throw new Error(`Failed to send email via Brevo and Fallback SMTP: ${errorMessage}`);
        }
    }
};

const sendBrevoSMS = async ({ toMobile, sender, message }) => {
    const apiKey = (process.env.BREVO_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('BREVO_API_KEY is not defined in environment variables');
    }

    // Default sender to 'DFLGRP' or any alphanumeric string up to 11 chars
    const senderName = (sender || process.env.BREVO_SMS_SENDER || 'DFLGRP').substring(0, 11);

    const payload = {
        sender: senderName,
        recipient: toMobile,
        content: message,
        type: 'transactional'
    };

    try {
        const response = await axios.post('https://api.brevo.com/v3/transactionalSMS/sms', payload, {
            headers: {
                'api-key': apiKey,
                'x-sib-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Failed to send SMS via Brevo: ${errorMessage}`);
    }
};

module.exports = {
    sendBrevoEmail,
    sendBrevoSMS
};
