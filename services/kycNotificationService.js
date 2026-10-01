const sendEmail = require('../utils/emailService');
const Admin = require('../models/Admin');
const Partner = require('../models/Partner');

const STEP_LABELS = {
    identity: 'Identity Proof (Aadhaar & PAN)',
    pan: 'PAN Card Details',
    gst: 'Business Details & GST Certificate',
    export: 'CSB-V Export Documents (IEC / AD Code / LUT)',
    documents: 'Sign & Photo / Personal Documents',
    all: 'Overall KYC Submission'
};

const REASON_CODE_LABELS = {
    BLURRED_IMAGE: 'Blurred / Unclear Document Image',
    DOCUMENT_EXPIRED: 'Document Expired',
    NAME_MISMATCH: 'Name Mismatch with Registration',
    GST_PAN_MISMATCH: 'GSTIN and PAN Number Mismatch',
    INCORRECT_DOC: 'Incorrect Document Type Uploaded',
    INCOMPLETE_DOC: 'Incomplete Document (Missing Back Side / Pages)',
    INVALID_NUMBER: 'Invalid / Unverified Document Number',
    OTHER: 'Other Discrepancy'
};

/**
 * Send KYC rejection notifications to all relevant stakeholders:
 * 1. Assigned Sales Rep
 * 2. Sales Managers / Operations Admins
 * 3. Franchise Partner (if customer is linked to a partner)
 * 4. Customer
 */
const sendKycRejectionAlerts = async ({
    user,
    step,
    documentName,
    rejectionCode,
    rejectionReason,
    reviewer
}) => {
    try {
        if (!user) return;

        const docLabel = documentName || STEP_LABELS[step] || step || 'KYC Document';
        const reasonCodeLabel = REASON_CODE_LABELS[rejectionCode] || rejectionCode || 'Verification Issue';
        const detailedRemarks = rejectionReason || 'Please review the uploaded document and re-upload a clear copy.';
        const reviewerName = reviewer?.name || reviewer?.email || 'Verification Team';
        const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        // 1. Fetch Assigned Sales Rep
        let salesRepEmail = null;
        let salesRepName = null;
        if (user.assignedTo) {
            try {
                const rep = await Admin.findById(user.assignedTo).select('name email');
                if (rep && rep.email) {
                    salesRepEmail = rep.email;
                    salesRepName = rep.name;
                }
            } catch {
                // Ignore failure
            }
        }

        // 2. Fetch Franchise Partner
        let partnerEmail = null;
        let partnerName = null;
        if (user.partnerId) {
            try {
                const partner = await Partner.findById(user.partnerId).select('ownerName email companyName');
                if (partner && partner.email) {
                    partnerEmail = partner.email;
                    partnerName = partner.ownerName || partner.companyName;
                }
            } catch {
                // Ignore failure
            }
        } else if (user.partnerCode) {
            try {
                const partner = await Partner.findOne({ partnerCode: user.partnerCode }).select('ownerName email companyName');
                if (partner && partner.email) {
                    partnerEmail = partner.email;
                    partnerName = partner.ownerName || partner.companyName;
                }
            } catch {
                // Ignore failure
            }
        }

        // 3. Fetch Sales Managers
        let salesManagerEmails = [];
        try {
            const managers = await Admin.find({ role: 'sales_manager', isActive: true }).select('email');
            salesManagerEmails = managers.map(m => m.email).filter(Boolean);
        } catch {
            // Ignore failure
        }

        // --- EMAIL TEMPLATE FOR INTERNAL STAKEHOLDERS (Sales Rep, Sales Manager, Franchise) ---
        const internalSubject = `⚠️ Action Required: KYC Document Rejected for Customer ${user.name} (${user.customerId || ''})`;
        const internalHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
                <div style="background: linear-gradient(135deg, #0B4F6C 0%, #062f40 100%); padding: 24px; text-align: left; color: #ffffff;">
                    <div style="display: inline-block; padding: 4px 12px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 20px; font-size: 11px; font-weight: 700; color: #fca5a5; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px;">
                        KYC Action Required
                    </div>
                    <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #ffffff;">Document Verification Discrepancy</h1>
                    <p style="margin: 6px 0 0 0; font-size: 13px; color: #cbd5e1;">A document submitted by customer <strong>${user.name}</strong> was rejected during KYC review.</p>
                </div>

                <div style="padding: 24px;">
                    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600; width: 140px;">Rejected Document:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #1e293b; font-weight: 700;">${docLabel}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600;">Reason Category:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #b91c1c; font-weight: 700;">${reasonCodeLabel}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600; vertical-align: top;">Reviewer Remarks:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #334155; font-style: italic; background: #ffffff; border-radius: 6px; padding: 8px; border: 1px dashed #fca5a5;">
                                    "${detailedRemarks}"
                                </td>
                            </tr>
                        </table>
                    </div>

                    <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px;">Customer Overview</h3>
                    <table style="width: 100%; border-collapse: collapse; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                        <tr>
                            <td style="padding: 8px 12px; font-size: 12px; color: #64748b; border-bottom: 1px solid #e2e8f0; width: 120px;">Customer Name</td>
                            <td style="padding: 8px 12px; font-size: 13px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${user.name}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 12px; font-size: 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Customer ID</td>
                            <td style="padding: 8px 12px; font-size: 13px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${user.customerId || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 12px; font-size: 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Email / Phone</td>
                            <td style="padding: 8px 12px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${user.email} / ${user.phone || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 12px; font-size: 12px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Reviewed By</td>
                            <td style="padding: 8px 12px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${reviewerName} (${dateStr})</td>
                        </tr>
                        ${partnerName ? `
                        <tr>
                            <td style="padding: 8px 12px; font-size: 12px; color: #64748b;">Franchise / Partner</td>
                            <td style="padding: 8px 12px; font-size: 13px; color: #0f172a; font-weight: 600;">${partnerName} (${user.partnerCode || ''})</td>
                        </tr>` : ''}
                    </table>

                    <p style="font-size: 13px; color: #475569; line-height: 1.5; margin-bottom: 20px;">
                        Please follow up with the customer directly to assist them in re-uploading the rejected document so their account can be approved promptly.
                    </p>
                </div>

                <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 14px 24px; text-align: center; font-size: 11px; color: #94a3b8;">
                    DFL Courier & Logistics Operations &bull; Automated KYC Notification
                </div>
            </div>
        `;

        // Dispatch to Sales Rep
        if (salesRepEmail) {
            sendEmail({
                email: salesRepEmail,
                subject: internalSubject,
                html: internalHtml
            }).catch(() => {});
        }

        // Dispatch to Franchise Owner
        if (partnerEmail && partnerEmail !== salesRepEmail) {
            sendEmail({
                email: partnerEmail,
                subject: internalSubject,
                html: internalHtml
            }).catch(() => {});
        }

        // Dispatch to Sales Managers
        for (const mEmail of salesManagerEmails) {
            if (mEmail !== salesRepEmail && mEmail !== partnerEmail) {
                sendEmail({
                    email: mEmail,
                    subject: internalSubject,
                    html: internalHtml
                }).catch(() => {});
            }
        }

        // --- EMAIL TEMPLATE FOR CUSTOMER ---
        if (user.email) {
            const customerSubject = `Important: Update Needed on Your KYC Document (${docLabel})`;
            const customerHtml = `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
                    <div style="background: #0B4F6C; padding: 24px; text-align: center; color: #ffffff;">
                        <h2 style="margin: 0; font-size: 20px; font-weight: 700;">KYC Document Update Required</h2>
                        <p style="margin: 6px 0 0 0; font-size: 13px; color: #e0f2fe;">Hello ${user.name}, we need your help to complete your account verification.</p>
                    </div>

                    <div style="padding: 24px;">
                        <p style="font-size: 14px; color: #334155; line-height: 1.5; margin-top: 0;">
                            During the review of your account, our verification team noticed an issue with the following document:
                        </p>

                        <div style="background: #fff1f2; border: 1px solid #fecdd3; border-radius: 12px; padding: 16px; margin: 20px 0;">
                            <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #9f1239;">
                                📄 ${docLabel}
                            </p>
                            <p style="margin: 0 0 8px 0; font-size: 12px; color: #be123c;">
                                <strong>Issue:</strong> ${reasonCodeLabel}
                            </p>
                            <p style="margin: 0; font-size: 13px; color: #4c0519; background: #ffffff; padding: 10px; border-radius: 8px; border: 1px dashed #fda4af;">
                                <strong>Admin Remarks:</strong> "${detailedRemarks}"
                            </p>
                        </div>

                        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 14px; margin-bottom: 20px;">
                            <p style="margin: 0; font-size: 13px; color: #166534; font-weight: 600;">
                                ✨ Good News: All your other verified documents are safely saved. You only need to re-upload this specific document.
                            </p>
                        </div>

                        <p style="font-size: 13px; color: #475569; line-height: 1.5;">
                            Please log in to your DFL Customer Dashboard and visit your Settings/KYC page to upload the corrected document.
                        </p>
                    </div>

                    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
                        If you have any questions, feel free to reply to this email or reach out to your assigned account manager.
                    </div>
                </div>
            `;

            sendEmail({
                email: user.email,
                subject: customerSubject,
                html: customerHtml
            }).catch(() => {});
        }

    } catch {
        // Non-blocking catch to ensure parent transaction does not fail
    }
};

/**
 * Send KYC Approval email to Franchise Partner
 */
const sendPartnerKycApprovedEmail = async ({ partner }) => {
    try {
        if (!partner || !partner.email) return;

        const partnerName = partner.ownerName || partner.companyName || 'Partner';
        const subject = `🎉 Congratulations! Your Franchise KYC has been Approved – DFL Express`;
        const html = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="background: linear-gradient(135deg, #0B4F6C 0%, #062f40 100%); padding: 28px 24px; text-align: center; color: #ffffff;">
                    <div style="display: inline-block; padding: 4px 12px; background: rgba(34, 197, 94, 0.2); border: 1px solid rgba(34, 197, 94, 0.4); border-radius: 20px; font-size: 11px; font-weight: 700; color: #86efac; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px;">
                        KYC Verified & Active
                    </div>
                    <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff;">Franchise Account Approved!</h1>
                    <p style="margin: 8px 0 0 0; font-size: 14px; color: #e0f2fe;">Welcome aboard, ${partnerName}!</p>
                </div>

                <div style="padding: 24px;">
                    <p style="font-size: 14px; color: #334155; line-height: 1.6; margin-top: 0;">
                        We are pleased to inform you that your Franchise KYC verification for <strong>${partner.companyName}</strong> (Partner Code: <strong>${partner.partnerCode || ''}</strong>) has been successfully approved by the DFL Operations Team.
                    </p>

                    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 18px; margin: 20px 0;">
                        <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: #166534;">🚀 What's Next?</h3>
                        <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #15803d; line-height: 1.6;">
                            <li>Book & dispatch shipments seamlessly</li>
                            <li>Manage customer onboardings and sub-accounts</li>
                            <li>Access real-time wallet transactions and tracking</li>
                        </ul>
                    </div>

                    <p style="font-size: 13px; color: #475569; line-height: 1.5;">
                        You can now log in to your Franchise Portal and start managing your operations right away.
                    </p>
                </div>

                <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8;">
                    DFL Courier & Logistics Operations &bull; Partner Management Team
                </div>
            </div>
        `;

        sendEmail({
            email: partner.email,
            subject,
            html
        }).catch((err) => {
            console.error('Failed to send partner KYC approval email:', err.message);
        });
    } catch (error) {
        console.error('Error in sendPartnerKycApprovedEmail:', error);
    }
};

/**
 * Send KYC Rejection email to Franchise Partner
 */
const sendPartnerKycRejectionAlerts = async ({
    partner,
    step,
    documentName,
    rejectionCode,
    rejectionReason,
    reviewer
}) => {
    try {
        if (!partner || !partner.email) return;

        const partnerName = partner.ownerName || partner.companyName || 'Partner';
        const docLabel = documentName || STEP_LABELS[step] || step || 'KYC Document';
        const reasonCodeLabel = REASON_CODE_LABELS[rejectionCode] || rejectionCode || 'Verification Issue';
        const detailedRemarks = rejectionReason || 'Please review the uploaded document and re-upload a clear copy.';

        const subject = `⚠️ Action Required: Franchise KYC Document Rejected (${docLabel})`;
        const html = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="background: linear-gradient(135deg, #0B4F6C 0%, #062f40 100%); padding: 24px; text-align: left; color: #ffffff;">
                    <div style="display: inline-block; padding: 4px 12px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 20px; font-size: 11px; font-weight: 700; color: #fca5a5; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px;">
                        KYC Discrepancy Found
                    </div>
                    <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #ffffff;">Franchise KYC Update Required</h1>
                    <p style="margin: 6px 0 0 0; font-size: 13px; color: #cbd5e1;">Hello ${partnerName}, action is required on your KYC submission.</p>
                </div>

                <div style="padding: 24px;">
                    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600; width: 140px;">Rejected Document:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #1e293b; font-weight: 700;">${docLabel}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600;">Reason Category:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #b91c1c; font-weight: 700;">${reasonCodeLabel}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0; font-size: 12px; color: #991b1b; font-weight: 600; vertical-align: top;">Reviewer Remarks:</td>
                                <td style="padding: 4px 0; font-size: 13px; color: #334155; font-style: italic; background: #ffffff; border-radius: 6px; padding: 8px; border: 1px dashed #fca5a5;">
                                    "${detailedRemarks}"
                                </td>
                            </tr>
                        </table>
                    </div>

                    <p style="font-size: 13px; color: #475569; line-height: 1.5;">
                        Please log in to your Franchise Portal, go to Settings &gt; KYC Details, and re-upload the corrected document for prompt verification.
                    </p>
                </div>

                <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 14px 24px; text-align: center; font-size: 11px; color: #94a3b8;">
                    DFL Courier & Logistics Operations &bull; Partner Verification Team
                </div>
            </div>
        `;

        sendEmail({
            email: partner.email,
            subject,
            html
        }).catch((err) => {
            console.error('Failed to send partner KYC rejection alert email:', err.message);
        });
    } catch (error) {
        console.error('Error in sendPartnerKycRejectionAlerts:', error);
    }
};

module.exports = {
    sendKycRejectionAlerts,
    sendPartnerKycApprovedEmail,
    sendPartnerKycRejectionAlerts,
    STEP_LABELS,
    REASON_CODE_LABELS
};
