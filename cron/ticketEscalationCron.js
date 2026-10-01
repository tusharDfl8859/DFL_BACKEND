const cron = require('node-cron');
const Ticket = require('../models/Ticket');
const sendEmail = require('../utils/emailService');

const startTicketEscalationCron = () => {
    // Run daily at midnight '0 0 * * *'
    cron.schedule('0 0 * * *', async () => {
        // Scheduled daily ticket escalation check
        try {
            // Find all tickets that are not Resolved and not Closed
            const tickets = await Ticket.find({
                status: { $nin: ['Resolved', 'Closed'] }
            }).populate({
                path: 'assignments.sales assignments.operations assignments.support assignments.manager'
            }).populate('user', 'name email companyName');

            if (!tickets || tickets.length === 0) return;

            const now = new Date();

            for (const ticket of tickets) {
                if (!ticket.createdAt) continue;
                const ageMs = now - new Date(ticket.createdAt);
                const actualAgeDays = Math.floor(ageMs / 86400000); // 1 day = 86400000 ms

                if (actualAgeDays === 0) continue; // Raised today, no escalation yet

                // Level 1 Email
                let level1Email = 'Helpdesk@thedflgroup.com';
                if (ticket.issueType === 'Billing Query') {
                    level1Email = ticket.assignments?.sales?.email || 'Helpdesk@thedflgroup.com';
                }

                // Level 2 Emails (Assigned Sales Person + Rajesh)
                const salesEmail = ticket.assignments?.sales?.email;
                const level2Emails = salesEmail && salesEmail !== 'marketing1@dflindia.in' 
                    ? [salesEmail, 'marketing1@dflindia.in'].join(',') 
                    : 'marketing1@dflindia.in';

                // Level 3 Email (Prerit Bhatnagar)
                const level3Email = 'pb@thedflgroup.com';

                // Level 4 Email (Sarvesh Ji)
                const level4Email = 'courier@thedflgroup.com';

                // Level 5 Email (Rajesh Gaur)
                const level5Email = 'rg@thedflgroup.com';

                let toEmails = [];
                let ccEmails = [];
                let levelNum = 0;

                if (actualAgeDays === 1) {
                    // Day 2 (after 24h unresolved): TO Level 1 | CC Level 2
                    levelNum = 2;
                    toEmails = [level1Email];
                    ccEmails = [level2Emails];
                } else if (actualAgeDays === 2) {
                    // Day 3 (after 48h unresolved): TO Level 1, Level 2 | CC Level 3
                    levelNum = 3;
                    toEmails = [level1Email, level2Emails];
                    ccEmails = [level3Email];
                } else if (actualAgeDays === 3) {
                    // Day 4 (after 72h unresolved): TO Level 1, Level 2, Level 3 | CC Level 4
                    levelNum = 4;
                    toEmails = [level1Email, level2Emails, level3Email];
                    ccEmails = [level4Email];
                } else if (actualAgeDays >= 4) {
                    // Day 5+ (after 96h unresolved): TO Level 1, Level 2, Level 3, Level 4 | CC Level 5 (Rajesh Gaur)
                    levelNum = 5;
                    toEmails = [level1Email, level2Emails, level3Email, level4Email];
                    ccEmails = [level5Email];
                }

                if (levelNum > 0) {
                    const toStr = [...new Set(toEmails.join(',').split(',').map(e => e.trim()).filter(Boolean))].join(',');
                    const ccStr = [...new Set(ccEmails.join(',').split(',').map(e => e.trim()).filter(Boolean))].join(',');

                    const subject = "[Escalation Level " + levelNum + "] Ticket #" + ticket.ticketId + " Unresolved (" + (actualAgeDays + 1) + " Days) - " + ticket.issueType;
                    const html = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ef4444; border-radius: 8px;">
                            <h2 style="color: #991b1b; margin-bottom: 15px;">🚨 Escalation Alert (Level ${levelNum})</h2>
                            <p style="color: #334155; font-size: 15px;">Ticket <strong>#${ticket.ticketId}</strong> has remained unresolved for <strong>${actualAgeDays + 1} days</strong> and has been escalated according to the support matrix.</p>
                            
                            <div style="background-color: #fee2e2; padding: 15px; border-radius: 6px; margin: 15px 0; border: 1px solid #fca5a5;">
                                <p style="margin: 0 0 8px 0;"><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
                                <p style="margin: 0 0 8px 0;"><strong>Customer:</strong> ${ticket.user?.name || 'N/A'} (${ticket.user?.companyName || ''})</p>
                                <p style="margin: 0 0 8px 0;"><strong>Shipment ID:</strong> ${ticket.shipmentId || 'N/A'}</p>
                                <p style="margin: 0 0 8px 0;"><strong>Issue Type:</strong> ${ticket.issueType}</p>
                                <p style="margin: 0 0 8px 0;"><strong>Priority:</strong> ${ticket.priority || 'Medium'}</p>
                                <p style="margin: 0;"><strong>Description:</strong> ${ticket.description}</p>
                            </div>
                            
                            <p style="color: #64748b; font-size: 13px;">Please take immediate action on the dashboard to resolve this case.</p>
                        </div>
                    `;

                    try {
                        await sendEmail({
                            to: toStr,
                            cc: ccStr,
                            subject,
                            html
                        });

                        ticket.remarks.push({
                            role: 'System',
                            text: "Automated Escalation (Level " + levelNum + " - Day " + (actualAgeDays + 1) + "): Alert sent to [TO: " + toStr + "] [CC: " + ccStr + "]",
                            type: 'status_update'
                        });
                    } catch (emailError) {
                        ticket.remarks.push({
                            role: 'System',
                            text: "Automated Escalation (Level " + levelNum + "): Email delivery failed (" + (emailError?.message || 'Delivery error') + ")",
                            type: 'status_update'
                        });
                    }

                    await ticket.save();
                    
                }
            }

            // Auto-close tickets that have remained in 'Resolved' status for 3 days (72 hours) without updates
            const threeDaysAgo = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
            const resolvedTickets = await Ticket.find({
                status: 'Resolved',
                updatedAt: { $lte: threeDaysAgo }
            });

            for (const resolvedTicket of resolvedTickets) {
                resolvedTicket.status = 'Closed';
                resolvedTicket.closedByName = 'System (Auto-Close)';
                resolvedTicket.remarks.push({
                    text: 'Ticket was automatically closed after remaining in Resolved status for 3 days without updates.',
                    role: 'System',
                    type: 'status_update',
                    createdAt: new Date()
                });
                await resolvedTicket.save();
                // No email sent on auto-close as per requirement
            }
        } catch (error) {
            // Escalation cron error handled silently
        }
    });
};

module.exports = startTicketEscalationCron;
