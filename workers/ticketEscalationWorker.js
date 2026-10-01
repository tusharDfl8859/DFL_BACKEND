const cron = require('node-cron');
const Ticket = require('../models/Ticket');
const sendEmail = require('../utils/emailService');

const runTicketEscalationSweep = async () => {
    console.log('[Worker: Ticket Escalation] Running daily ticket escalation check...');
    try {
        // Find all tickets that are not Resolved and not Closed
        const pendingTickets = await Ticket.find({
            status: { $nin: ['Resolved', 'Closed'] }
        }).populate({
            path: 'assignments.sales assignments.operations assignments.support assignments.manager'
        });

        const now = new Date();

        for (const ticket of pendingTickets) {
            try {
                // Calculate age in days
                const ageMs = now - new Date(ticket.createdAt);
                const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

                if (ageDays === 1) {
                    // Send to assigned sales manager
                    if (ticket.assignments?.manager?.email) {
                        await sendEmail({
                            email: ticket.assignments.manager.email,
                            subject: `Escalation (Day 2): Ticket ${ticket.ticketId} Unresolved`,
                            html: `<h2>Ticket Escalation Alert</h2>
                            <p>Ticket <strong>${ticket.ticketId}</strong> has been unresolved for 2 days. Please look into it immediately.</p>
                            <p><strong>Issue Type:</strong> ${ticket.issueType}</p>
                            <p><strong>Description:</strong> ${ticket.description}</p>`
                        });

                        ticket.remarks.push({
                            role: 'System',
                            text: `Automated Escalation (Day 2): Alert email sent to Sales Manager.`,
                            type: 'status_update'
                        });
                        await ticket.save();
                    }
                } else if (ageDays === 2) {
                    // Send to assigned operations
                    if (ticket.assignments?.operations?.email) {
                        await sendEmail({
                            email: ticket.assignments.operations.email,
                            subject: `Escalation (Day 3): Ticket ${ticket.ticketId} Unresolved`,
                            html: `<h2>Ticket Escalation Alert</h2>
                            <p>Ticket <strong>${ticket.ticketId}</strong> has been unresolved for 3 days. Please look into it immediately.</p>
                            <p><strong>Issue Type:</strong> ${ticket.issueType}</p>
                            <p><strong>Description:</strong> ${ticket.description}</p>`
                        });

                        ticket.remarks.push({
                            role: 'System',
                            text: `Automated Escalation (Day 3): Alert email sent to Operations.`,
                            type: 'status_update'
                        });
                        await ticket.save();
                    }
                } else if (ageDays === 3) {
                    // Send to management
                    await sendEmail({
                        email: 'rg@thedflgroup.com',
                        subject: `Escalation (Day 4): Ticket ${ticket.ticketId} Unresolved`,
                        html: `<h2>Ticket Escalation Alert - Final Warning</h2>
                        <p>Ticket <strong>${ticket.ticketId}</strong> has been unresolved for 4 days. It will expire tomorrow if not resolved.</p>
                        <p><strong>Issue Type:</strong> ${ticket.issueType}</p>
                        <p><strong>Description:</strong> ${ticket.description}</p>`
                    });

                    ticket.remarks.push({
                        role: 'System',
                        text: `Automated Escalation (Day 4): Final warning alert email sent to Management.`,
                        type: 'status_update'
                    });
                    await ticket.save();
                } else if (ageDays >= 4) {
                    // Expire the ticket
                    ticket.status = 'Closed';
                    ticket.isExpired = true;
                    ticket.remarks.push({
                        role: 'System',
                        text: 'Ticket closed automatically due to no resolution after 4 days.',
                        type: 'status_update'
                    });

                    if (!ticket.assignmentHistory) {
                        ticket.assignmentHistory = [];
                    }

                    await ticket.save();
                }
            } catch (err) {
                console.error(`Failed to process ticket escalation for ticket ${ticket?.ticketId}:`, err);
            }
        }
    } catch (error) {
        console.error('Failed to run ticket escalation worker:', error);
    }
};

// Run daily at midnight to check ticket escalations
const scheduledTask = process.env.NODE_ENV === 'test'
    ? null
    : cron.schedule('0 0 * * *', runTicketEscalationSweep);

module.exports = {
    runTicketEscalationSweep,
    scheduledTask
};
