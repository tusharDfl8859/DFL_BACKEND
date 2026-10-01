const User = require('../models/User');
const { sendBrevoEmail } = require('../utils/brevoService');

/**
 * Identify users targeting specific re-engagement criteria:
 * Joined before March 15th AND (Zero Bookings OR Incomplete KYC)
 */
/**
 * Identify users targeting specific re-engagement criteria:
 * @param {number} days - Inactivity threshold in days
 * @param {boolean} noBookingsOnly - If true, only include users with 0 shipments
 * @param {boolean} showSent - If true, return users who OLDREADY HAVE been sent an email
 */
const getInactiveUsers = async (days = 1, noBookingsOnly = false, showSent = false) => {
    // Calculate cutoff date based on the 'days' parameter
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    /**
     * TARGET CRITERIA:
     * 1. Not an Admin and not Restricted
     * 2. Signed up on or before the cutoff date (e.g. 15 or 30 days ago)
     * 3. Filter by reengagementEmailSent based on showSent parameter
     */
    let query = {
        isAdmin: false,
        isRestricted: false,
        createdAt: { $lte: cutoffDate }
    };

    if (showSent) {
        // Sent History tab: strictly show those who received the email
        query.reengagementEmailSent = true;
    }
    // If showSent is false (Active Targets), we DO NOT filter them out.
    // This allows the admin to see and email all inactive users again the next day.

    const Shipment = require('../models/Shipment');
    const usersWithShipments = await Shipment.distinct('user');

    // Filter for unengaged users: either zero bookings OR KYC issue
    const unengagedFilter = {
        $or: [
            { _id: { $nin: usersWithShipments } },
            { kycVerified: false },
            { 'kycData.status': { $ne: 'verified' } }
        ]
    };

    if (noBookingsOnly) {
        query._id = { $nin: usersWithShipments };
    } else {
        query.$and = [unengagedFilter];
    }

    const inactiveUsers = await User.find(query, 'name email lastLogin createdAt kycVerified kycData reengagementEmailSent lastReengagementSentAt');
    return inactiveUsers;
};

/**
 * Extracts a professional-looking first name from an email address
 * e.g. "neeraj.kumar@gmail.com" -> "Neeraj"
 */
const extractFirstNameFromEmail = (email) => {
    if (!email) return 'Customer';
    const prefix = email.split('@')[0];
    const firstName = prefix.split(/[\.\-_0-9]/)[0];
    return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
};

/**
 * Generates a well-structured, professional HTML re-engagement email
 * Based on user-provided text for DFL Express
 */
const generateReengagementHTML = (userName, email) => {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
                line-height: 1.6; 
                color: #334155; 
                margin: 0; 
                padding: 0; 
                background-color: #ffffff; 
            }
            .wrapper {
                padding: 40px 20px;
                background-color: #f8fafc;
            }
            .container { 
                max-width: 600px; 
                margin: 0 auto; 
                background: #ffffff; 
                border-radius: 12px; 
                border: 1px solid #e2e8f0;
                padding: 40px;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }
            .logo {
                color: #0B4F6C;
                font-size: 22px;
                font-weight: 900;
                letter-spacing: 1px;
                margin-bottom: 30px;
                border-bottom: 3px solid #0B4F6C;
                display: inline-block;
                padding-bottom: 4px;
            }
            .content {
                font-size: 16px;
            }
            .offer-section {
                margin: 30px 0;
                padding: 24px;
                background-color: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
            }
            .offer-title {
                font-weight: 800;
                color: #0B4F6C;
                font-size: 18px;
                margin-bottom: 15px;
            }
            .highlight {
                color: #0B4F6C;
                font-weight: 700;
            }
            .promo-code {
                font-family: 'Courier New', Courier, monospace;
                font-weight: bold;
                color: #ffffff;
                background: #0B4F6C;
                padding: 4px 12px;
                border-radius: 6px;
                display: inline-block;
            }
            .btn { 
                display: inline-block; 
                background-color: #0B4F6C; 
                color: #ffffff !important; 
                padding: 16px 32px; 
                border-radius: 8px; 
                text-decoration: none; 
                font-weight: 700; 
                margin: 25px 0;
                text-align: center;
            }
            .footer { 
                margin-top: 40px;
                padding-top: 20px;
                border-top: 1px solid #f1f5f9;
                font-size: 12px; 
                color: #94a3b8; 
                text-align: center;
            }
        </style>
    </head>
    <body>
        <div class="wrapper">
            <div class="container">
                <div style="text-align: center; margin-bottom: 15px;">
                    <img src="https://express.thedflgroup.com/dfl_express_logo.png" alt="DFL Express Logo" style="max-width: 180px; height: auto;">
                </div>
                <div class="logo">DFL EXPRESS</div>
                
                <div class="content">
                    <p style="font-size: 18px;">Hi,</p>
                    <p><strong>Thank you for signing up with DFL Express 👍</strong></p>
                    
                    <p>We truly appreciate the time and effort you took to complete your registration. We noticed that you haven’t yet had the chance to try our services, and we’d love to help you get started with our new rewards.</p>
                    
                    <div class="offer-section">

                        <p style="margin: 0 0 10px 0; font-weight: 600;">
                            As a small welcome gesture from Team DFL Express, we’re offering you:<br><br>
                            50% off (up to ₹200) on your first shipment
                        </p>
                        
                        <p style="margin: 15px 0 0 0; font-size: 14px; color: #64748b; font-style: italic;">
                            This ensures the discount is always proportional to the order value.
                        </p>

                        <p style="margin-top: 20px;">
                            Use code: <span class="promo-code">DFLWELCOME</span> during booking
                        </p>
                    </div>
                    
                    <p>To start saving, simply complete your KYC and explore our new automated dashboard. When you apply the coupon, the discount is <strong>automatically credited</strong> to your wallet instantly.</p>
                    
                    <div style="text-align: center;">
                        <a href="https://express.thedflgroup.com/login" class="btn">Start Your First Shipment</a>
                    </div>
                    
                    <p>We look forward to serving you and ensuring a smooth, hassle-free experience.</p>
                    
                    <p>Thanks again for your support 🙌<br>
                    <strong>Best regards,<br>Team DFL Express</strong></p>
                </div>
                
                <div class="footer">
                    &copy; 2026 DFL Express. All rights reserved.<br>
                    Global Logistics Hub | Worldwide Shipments
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
};



/**
 * Send bulk re-engagement emails in batches
 * @param {Array} users - List of users to notify
 * @param {number} templateId - Brevo Template ID (optional)
 * @param {number} batchSize - Number of emails per batch
 * @param {number} delayMs - Delay between batches in milliseconds
 */
const sendBulkReengagement = async (users, templateId, batchSize = 50, delayMs = 2000) => {
    console.log(`[Re-engagement] Starting bulk send for ${users.length} users in batches of ${batchSize}`);

    let successCount = 0;
    let failureCount = 0;

    // Determine if we are using the default structured format
    const useDefaultFormat = !templateId || templateId === '0';

    for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        console.log(`[Re-engagement] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(users.length / batchSize)}`);

        // Use Promise.allSettled for parallel processing WITHIN the batch
        const results = await Promise.allSettled(batch.map(user => {
            const emailOptions = {
                toEmail: user.email,
                toName: user.name,
                subject: 'Special Welcome Offer from DFL Express 📦',
                params: {
                    STORE_NAME: 'DFL Group'
                }
            };


            if (useDefaultFormat) {
                // Use our new structured HTML format
                emailOptions.params.htmlContent = generateReengagementHTML(user.name, user.email);
            } else {
                // Use the provided Brevo Template ID
                emailOptions.templateId = templateId;
            }

            return sendBrevoEmail(emailOptions);
        }));

        const successfulEmails = [];

        results.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                successCount++;
                successfulEmails.push(batch[idx]._id);
            } else {
                failureCount++;
                console.error(`[Re-engagement] Failed for ${batch[idx].email}: ${res.reason}`);
            }
        });

        // Update database for successful sends in this batch
        if (successfulEmails.length > 0) {
            await User.updateMany(
                { _id: { $in: successfulEmails } },
                {
                    $set: {
                        reengagementEmailSent: true,
                        lastReengagementSentAt: new Date()
                    }
                }
            );
            console.log(`[Re-engagement] Updated ${successfulEmails.length} users as 'Mail Sent'`);
        }

        // Add delay between batches to respect rate limits if not at the last batch
        if (i + batchSize < users.length) {
            console.log(`[Re-engagement] Batch completed. Waiting ${delayMs}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    console.log(`[Re-engagement] Summary: ${successCount} sent, ${failureCount} failed.`);
    return { successCount, failureCount };
};

/**
 * Formats raw text/HTML custom email content into a beautifully aligned, responsive email template
 */
const formatCustomEmailHTML = (content, recipientName = '', senderName = 'DFL Express') => {
    let processedContent = content || '';
    
    // Replace [Customer Name] or [Name] placeholder dynamically if present
    if (recipientName && recipientName.trim()) {
        processedContent = processedContent.replace(/\[Customer Name\]|\[Name\]/gi, recipientName.trim());
    } else {
        processedContent = processedContent.replace(/\[Customer Name\]|\[Name\]/gi, 'Customer');
    }

    // If user provided a full HTML document (starts with <!DOCTYPE or <html), return directly after placeholder replacement
    if (processedContent.trim().toLowerCase().startsWith('<!doctype html') || processedContent.trim().toLowerCase().startsWith('<html')) {
        return processedContent;
    }

    // Convert plain text newlines into structured HTML paragraphs if no structural HTML tags exist
    let bodyHtml = processedContent;
    if (!/<(p|div|table|h1|h2|h3|h4|section|article)\b/i.test(processedContent)) {
        const paragraphs = processedContent.split(/\n\s*\n/);
        bodyHtml = paragraphs
            .map(para => {
                const lines = para.trim().split('\n').map(l => l.trim()).filter(Boolean).join('<br />');
                return lines ? `<p style="margin: 0 0 16px 0; line-height: 1.6; font-size: 15px; color: #334155;">${lines}</p>` : '';
            })
            .filter(Boolean)
            .join('');
    }

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
            line-height: 1.6; 
            color: #334155; 
            margin: 0; 
            padding: 0; 
            background-color: #f8fafc; 
        }
        .wrapper {
            padding: 30px 15px;
            background-color: #f8fafc;
        }
        .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: #ffffff; 
            border-radius: 12px; 
            border: 1px solid #e2e8f0;
            padding: 32px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
        }
        .header {
            text-align: center;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 2px solid #0B4F6C;
        }
        .logo {
            max-width: 170px;
            height: auto;
        }
        .content {
            font-size: 15px;
            color: #334155;
            line-height: 1.6;
        }
        .footer { 
            margin-top: 32px;
            padding-top: 20px;
            border-top: 1px solid #f1f5f9;
            font-size: 12px; 
            color: #94a3b8; 
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="container">
            <div class="header">
                <img src="https://express.thedflgroup.com/dfl_express_logo.png" alt="DFL Express Logo" class="logo">
            </div>
            <div class="content">
                ${bodyHtml}
            </div>
            <div class="footer">
                &copy; ${new Date().getFullYear()} ${senderName || 'DFL Express'}. All rights reserved.<br>
                Global Logistics Hub | Worldwide Shipments
            </div>
        </div>
    </div>
</body>
</html>`;
};

const sendBulkCustomEmailService = async ({ recipients, subject, content, senderName, senderEmail, batchSize = 50, delayMs = 2000 }) => {
    console.log(`[Custom Bulk Email] Starting bulk send for ${recipients.length} recipients in batches of ${batchSize}`);

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        console.log(`[Custom Bulk Email] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(recipients.length / batchSize)}`);

        const results = await Promise.allSettled(batch.map(recipient => {
            const formattedHtml = formatCustomEmailHTML(content, recipient.name || '', senderName);
            return sendBrevoEmail({
                toEmail: recipient.email,
                toName: recipient.name,
                subject: subject,
                params: {
                    htmlContent: formattedHtml
                },
                senderEmail,
                senderName
            });
        }));

        results.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                successCount++;
            } else {
                failureCount++;
                console.error(`[Custom Bulk Email] Failed for ${batch[idx].email}: ${res.reason}`);
            }
        });

        if (i + batchSize < recipients.length) {
            console.log(`[Custom Bulk Email] Batch completed. Waiting ${delayMs}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    console.log(`[Custom Bulk Email] Summary: ${successCount} sent, ${failureCount} failed.`);
    return { successCount, failureCount };
};

module.exports = {
    getInactiveUsers,
    sendBulkReengagement,
    sendBulkCustomEmailService
};
