const sendEmail = require('./emailService');
const Ticket = require('../models/Ticket');

const sendTicketClosedEmail = async (ticketId) => {
    try {
        if (!ticketId) return;

        const ticket = await Ticket.findById(ticketId)
            .populate('user', 'name email')
            .populate('assignments.sales', 'name email')
            .populate('assignments.operations', 'name email')
            .populate('assignments.support', 'name email')
            .populate('assignments.manager', 'name email');

        if (!ticket) return;

        const emails = new Set();
        
        // Add customer email (using optional chaining)
        if (ticket?.user?.email) {
            emails.add(ticket.user.email);
        }

        // Add assigned members emails (using optional chaining)
        ['sales', 'operations', 'support', 'manager'].forEach(role => {
            if (ticket?.assignments?.[role]?.email) {
                emails.add(ticket.assignments[role].email);
            }
        });

        const emailList = Array.from(emails);

        if (emailList.length === 0) return;

        const subject = `Ticket Closed: ${ticket.ticketId}`;
        const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #10b981; margin-bottom: 20px;">Ticket Closed</h2>
            <p style="color: #334155; font-size: 16px;">The ticket <strong>${ticket.ticketId}</strong> has been closed.</p>
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0 0 10px 0;"><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
                <p style="margin: 0 0 10px 0;"><strong>Issue Type:</strong> ${ticket.issueType}</p>
                <p style="margin: 0;"><strong>Description:</strong> ${ticket.description}</p>
            </div>
            <p style="color: #64748b; font-size: 14px;">Thank you for your cooperation.</p>
        </div>`;

        // Send emails concurrently, no consoles
        await Promise.all(emailList.map(email => 
            sendEmail({ email, subject, html }).catch(() => {})
        ));
    } catch (error) {
        // Suppress email error
    }
};

module.exports = { sendTicketClosedEmail };
