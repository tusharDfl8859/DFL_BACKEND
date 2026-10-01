const Ticket = require('../models/Ticket');
const { logActivity } = require('../utils/activityLogger');
const sendEmail = require('../utils/emailService');

// Function for Customer Acknowledgement Email (from Excel Template)
const sendAcknowledgementEmail = async (customerEmail, customerName, newTicket) => {
    if (!customerEmail) return;
    const dateFormatted = new Date(newTicket.createdAt || Date.now()).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });

    const subject = "Ticket Received - " + newTicket.issueType + " Issue (Case ID: " + newTicket.ticketId + ")";
    const shipmentInfo = newTicket.shipmentId ? "(Shipment ID: <strong>" + newTicket.shipmentId + "</strong>)" : "";
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #334155; line-height: 1.6;">
            <p>Dear <strong>${customerName || 'Customer'}</strong>,</p>
            <p>Thank you for reaching out to us. This email is to confirm that we have received your ticket regarding a <strong>${newTicket.issueType}</strong> issue ${shipmentInfo}.</p>
            
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0; border: 1px solid #cbd5e1;">
                <h4 style="margin: 0 0 10px 0; color: #1e293b;">Ticket Details:</h4>
                <p style="margin: 0 0 6px 0;">• <strong>Case ID:</strong> ${newTicket.ticketId}</p>
                <p style="margin: 0 0 6px 0;">• <strong>Issue Type:</strong> ${newTicket.issueType}</p>
                <p style="margin: 0 0 6px 0;">• <strong>Priority:</strong> ${newTicket.priority}</p>
                <p style="margin: 0;">• <strong>Date Received:</strong> ${dateFormatted}</p>
            </div>

            <p>Our team is currently reviewing your ticket, and we will share an update within <strong>24 to 48 hours</strong>.</p>
            <p>We appreciate your patience and apologize for any inconvenience this may have caused. If you have any additional information that could help us resolve this faster, please feel free to reply to this email.</p>
            
            <br>
            <p style="margin-bottom: 2px;">Best regards,</p>
            <p style="margin-top: 0; font-weight: bold; color: #0f172a;">Customer Support Team<br>DFL Express</p>
        </div>
    `;
    try {
        await sendEmail({ to: customerEmail, subject, html });
        return true;
    } catch (err) {
        return false;
    }
};

// Function for Level 1 Internal Notification Alert
const sendLevel1AlertEmail = async (level1Email, newTicket, customerName) => {
    if (!level1Email) return;
    const priorityColor = newTicket.priority === 'High' ? '#ef4444' : newTicket.priority === 'Medium' ? '#f59e0b' : '#3b82f6';
    const subject = "[Level 1 Alert] New Ticket: " + newTicket.ticketId + " - " + newTicket.issueType + " (" + newTicket.priority + " Priority)";
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #1e293b; margin-bottom: 15px;">New Ticket Raised (Level 1)</h2>
            <div style="display: inline-block; padding: 4px 10px; background-color: ${priorityColor}; color: #ffffff; border-radius: 4px; font-weight: bold; font-size: 12px; margin-bottom: 15px;">
                ${newTicket.priority} Priority
            </div>
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 15px 0; border: 1px solid #e2e8f0;">
                <p style="margin: 0 0 8px 0;"><strong>Ticket ID:</strong> ${newTicket.ticketId}</p>
                <p style="margin: 0 0 8px 0;"><strong>Customer:</strong> ${customerName || 'N/A'}</p>
                <p style="margin: 0 0 8px 0;"><strong>Shipment ID:</strong> ${newTicket.shipmentId || 'N/A'}</p>
                <p style="margin: 0 0 8px 0;"><strong>Issue Type:</strong> ${newTicket.issueType}</p>
                <p style="margin: 0;"><strong>Description:</strong> ${newTicket.description}</p>
            </div>
            <p style="color: #64748b; font-size: 14px;">Please review this ticket on the dashboard and take action promptly.</p>
        </div>
    `;
    try {
        await sendEmail({ to: level1Email, subject, html });
        return true;
    } catch (err) {
        return false;
    }
};

// Function for Customer Action Taken Email (Template: Email Template Action Taken)
const sendActionTakenEmail = async (ticket, actionSummary, adminUser) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(ticket.user);
        if (!user || !user.email) return false;

        const customerName = user.name || user.companyName || 'Valued Customer';
        const createdOn = new Date(ticket.createdAt).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        }) + ', ' + new Date(ticket.createdAt).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        const adminName = adminUser?.name || 'Customer Support Team';
        const adminDept = adminUser?.designation || adminUser?.department || 'Customer Support';
        const actionTakenText = actionSummary && actionSummary.trim() ? actionSummary.trim() : 'The ticket is in progress and being actively handled by our team.';

        const subject = `[DFL Support] Action Taken on Ticket #${ticket.ticketId} - ${ticket.issueType}`;
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1e293b; line-height: 1.6;">
                <p style="font-size: 15px; margin-top: 0;">Dear <strong>${customerName}</strong>,</p>
                
                <p style="font-size: 14px; color: #334155;">Thank you for your patience while we reviewed your ticket regarding a <strong>${ticket.issueType}</strong> issue (Shipment ID: <strong>${ticket.shipmentId || 'N/A'}</strong>).</p>
                
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
                    <p style="margin: 0 0 10px 0; font-weight: bold; color: #0f172a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px;">Ticket Details:</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Case ID:</strong> ${ticket.ticketId}</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Issue Type:</strong> ${ticket.issueType}</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Priority:</strong> ${ticket.priority || 'Medium'}</p>
                    <p style="margin: 0; font-size: 13px;"><strong>- Date Received:</strong> ${createdOn}</p>
                </div>

                <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 14px 16px; border-radius: 4px; margin: 20px 0;">
                    <p style="margin: 0; font-size: 14px; color: #1e3a8a;">
                        <strong>Action Taken:</strong> ${actionTakenText}
                    </p>
                </div>

                <p style="font-size: 13px; color: #475569;">If this resolves your concern, no further action is needed. If you have any questions or the issue persists, please feel free to reply to this email and we'll be happy to assist further.</p>
                
                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">
                    <p style="margin: 0; font-weight: bold; color: #0f172a;">Best regards,</p>
                    <p style="margin: 2px 0 0 0; color: #334155;">${adminName}</p>
                    <p style="margin: 2px 0 0 0; color: #64748b;">${adminDept}</p>
                    <p style="margin: 2px 0 0 0; font-weight: bold; color: #0f172a;">DFL Express</p>
                    <p style="margin: 2px 0 0 0; color: #64748b;">courier@thedflgroup.com | +91 9355151122</p>
                </div>
            </div>
        `;

        await sendEmail({ to: user.email, subject, html });
        return true;
    } catch (err) {
        return false;
    }
};

// Function for Customer Closing / Resolved Ticket Email (Template: Email Template - Closing Ticket)
const sendClosingTicketEmail = async (ticket, actionSummary, adminUser) => {
    try {
        const User = require('../models/User');
        const user = await User.findById(ticket.user);
        if (!user || !user.email) return false;

        const customerName = user.name || user.companyName || 'Customer';
        const createdOn = new Date(ticket.createdAt).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });

        const resolvedDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });

        const adminName = adminUser?.name || 'Customer Support Team';
        const adminDept = adminUser?.designation || adminUser?.department || 'DFL Support Team';
        const actionTakenText = actionSummary && actionSummary.trim() ? actionSummary.trim() : 'Issue investigated and resolved.';

        const shipmentInfo = ticket.shipmentId ? `(Shipment ID: ${ticket.shipmentId})` : '';
        const subject = `Ticket Resolved - ${ticket.issueType} (Case ID: ${ticket.ticketId})`;
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1e293b; line-height: 1.6;">
                <p style="font-size: 15px; margin-top: 0;">Dear <strong>${customerName}</strong>,</p>
                
                <p style="font-size: 14px; color: #334155;">We would like to inform you that your ticket regarding a <strong>${ticket.issueType}</strong> issue ${shipmentInfo} has been resolved.</p>
                
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
                    <p style="margin: 0 0 10px 0; font-weight: bold; color: #0f172a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px;">Ticket Details:</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Case ID:</strong> ${ticket.ticketId}</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Issue Type:</strong> ${ticket.issueType}</p>
                    <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>- Date Received:</strong> ${createdOn}</p>
                    <p style="margin: 0; font-size: 13px;"><strong>- Date Resolved:</strong> ${resolvedDate}</p>
                </div>

                <div style="background-color: #f0fdf4; border-left: 4px solid #10b981; padding: 14px 16px; border-radius: 4px; margin: 20px 0;">
                    <p style="margin: 0; font-size: 14px; color: #065f46;">
                        <strong>Action Taken:</strong> ${actionTakenText}
                    </p>
                </div>

                <p style="font-size: 13px; color: #475569;">If you feel this issue is not fully resolved or you need further assistance, please reply to this email within <strong>3 days</strong>, and we'll be happy to reopen and continue assisting you.</p>
                
                <p style="font-size: 13px; color: #475569;">Thank you for your patience and for giving us the opportunity to assist you.</p>

                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">
                    <p style="margin: 0; font-weight: bold; color: #0f172a;">Best regards,</p>
                    <p style="margin: 2px 0 0 0; color: #334155;">${adminName}</p>
                    <p style="margin: 2px 0 0 0; color: #64748b;">${adminDept}</p>
                    <p style="margin: 2px 0 0 0; font-weight: bold; color: #0f172a;">DFL Express</p>
                    <p style="margin: 2px 0 0 0; color: #64748b;">courier@thedflgroup.com | +91 9355151122</p>
                </div>
            </div>
        `;

        await sendEmail({ to: user.email, subject, html });
        return true;
    } catch (err) {
        return false;
    }
};


// Create a new ticket
exports.createTicket = async (req, res) => {
    try {
        const { shipmentId, issueType, priority, description } = req.body;

        if (!issueType || !description) {
            return res.status(400).json({ success: false, message: 'Issue type and description are required.' });
        }

        // Handle file upload if any
        let attachmentUrl = req?.file?.path || null;

        const User = require('../models/User');
        const Admin = require('../models/Admin');

        const user = await User.findById(req?.user?._id).populate('assignedTo');
        let assignments = {
            sales: null,
            manager: null
        };

        if (user?.assignedTo) {
            assignments.sales = user.assignedTo._id;
            const salesPerson = await Admin.findById(user.assignedTo._id).populate('reportsTo');
            if (salesPerson?.reportsTo) {
                assignments.manager = salesPerson.reportsTo._id;
            } else {
                const defaultManager = await Admin.findOne({ role: 'sales_manager' });
                if (defaultManager) {
                    assignments.manager = defaultManager._id;
                }
            }
        }

        const newTicket = new Ticket({
            user: req?.user?._id,
            shipmentId,
            issueType,
            priority: priority || 'Medium',
            description,
            attachment: attachmentUrl,
            assignments
        });

        await newTicket.save();

        try {
            let salesEmail = null;
            if (assignments.sales) {
                const sp = await Admin.findById(assignments.sales);
                if (sp?.email) salesEmail = sp.email;
            }

            // 1. Send Automatic Acknowledgement Email to Customer
            const ackSent = await sendAcknowledgementEmail(user?.email || req?.user?.email, user?.name || req?.user?.name, newTicket);

            // 2. Determine Level 1 Recipient based on Escalation Matrix:
            // - Billing Query: Assigned Sales Person (system)
            // - Delivery Delay / Tracking Issue: Sheetal (Helpdesk@thedflgroup.com)
            let level1Email = 'Helpdesk@thedflgroup.com';
            if (newTicket.issueType === 'Billing Query') {
                level1Email = salesEmail || 'Helpdesk@thedflgroup.com';
            }

            // 3. Send Level 1 Internal Notification Alert
            const alertSent = await sendLevel1AlertEmail(level1Email, newTicket, user?.name || req?.user?.name);

            if (!ackSent || !alertSent) {
                newTicket.remarks.push({
                    role: 'System',
                    text: 'Initial notification notice: ' + (!ackSent ? 'Customer ack email was not dispatched. ' : '') + (!alertSent ? 'Level 1 internal alert email was not dispatched.' : ''),
                    type: 'status_update'
                });
                await newTicket.save();
            }
        } catch (err) {
            newTicket.remarks.push({
                role: 'System',
                text: 'Initial notification process encountered an issue.',
                type: 'status_update'
            });
            await newTicket.save();
        }

        return res.status(201).json({
            success: true,
            message: 'Ticket raised successfully',
            ticket: newTicket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to create ticket', error: error?.message || 'Server error' });
    }
};

// Get tickets for the logged-in user
exports.getUserTickets = async (req, res) => {
    try {
        if (!req?.user?._id) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const tickets = await Ticket.find({ user: req.user._id }).sort({ createdAt: -1 });
        return res.status(200).json({
            success: true,
            tickets
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
    }
};

// Get single ticket by ID for the logged-in user
exports.getTicketById = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.user?._id) return res.status(400).json({ success: false, message: 'Invalid request' });
        const ticket = await Ticket.findOne({ _id: req.params.id, user: req.user._id })
            .populate([
                { path: 'assignments.sales', select: 'name email contactNumber department' },
                { path: 'assignments.operations', select: 'name email contactNumber department' },
                { path: 'assignments.support', select: 'name email contactNumber department' },
                { path: 'assignments.manager', select: 'name email contactNumber department' }
            ]);

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        return res.status(200).json({
            success: true,
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
    }
};

// Admin: Get ticket analytics / KPI metrics
exports.getTicketAnalytics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let query = {};

        if (startDate && endDate) {
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);
            query.createdAt = {
                $gte: new Date(startDate),
                $lte: end
            };
        }

        const [totalTickets, openTickets, highPriorityTickets, resolvedTickets] = await Promise.all([
            Ticket.countDocuments(query),
            Ticket.countDocuments({ ...query, status: { $in: ['Pending', 'In Progress'] } }),
            Ticket.countDocuments({ ...query, priority: 'High' }),
            Ticket.countDocuments({ ...query, status: { $in: ['Resolved', 'Closed'] } })
        ]);

        return res.status(200).json({
            success: true,
            analytics: {
                totalTickets,
                openTickets,
                highPriorityTickets,
                resolvedTickets
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch ticket analytics' });
    }
};

// Admin: Get all tickets with pagination and filtering
exports.getAllTicketsForAdmin = async (req, res) => {
    try {
        const { status, priority, issueType, startDate, endDate, page = 1, limit = 10 } = req.query;
        let query = {};

        if (startDate && endDate) {
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);
            query.createdAt = {
                $gte: new Date(startDate),
                $lte: end
            };
        }

        if (status && status !== 'All Status') {
            query.status = status;
        }
        if (priority && priority !== 'All Priority') {
            query.priority = priority;
        }
        if (issueType && issueType !== 'All Types') {
            query.issueType = issueType;
        }

        const count = await Ticket.countDocuments(query);
        const tickets = await Ticket.find(query)
            .populate('user', 'name companyName')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        return res.status(200).json({
            success: true,
            tickets,
            totalPages: Math.ceil(count / limit),
            currentPage: parseInt(page),
            totalTickets: count
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
    }
};

// Admin: Get single ticket by ID
exports.getTicketByIdForAdmin = async (req, res) => {
    try {
        if (!req?.params?.id) return res.status(400).json({ success: false, message: 'Ticket ID required' });
        const ticket = await Ticket.findById(req.params.id)
            .populate('user', 'name email phone companyName')
            .populate([
                { path: 'assignments.sales', select: 'name email department' },
                { path: 'assignments.operations', select: 'name email department' },
                { path: 'assignments.support', select: 'name email department' },
                { path: 'assignments.manager', select: 'name email department' },
                { path: 'assignmentHistory.assignedTo', select: 'name email department role designation' },
                { path: 'assignmentHistory.assignedBy', select: 'name email department role designation' }
            ]);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        return res.status(200).json({
            success: true,
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
    }
};

// Admin: Update ticket status and priority
exports.updateTicketStatus = async (req, res) => {
    try {
        if (!req?.params?.id) return res.status(400).json({ success: false, message: 'Ticket ID required' });
        const { status, priority, remark } = req.body;
        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        if (status) {
            const oldStatus = ticket.status;
            ticket.status = status;

            if ((status === 'Closed' || status === 'Resolved') && oldStatus !== status) {
                const closerName = req?.admin?.name || req?.user?.name || 'Unknown';
                ticket.closedBy = req?.admin?._id || req?.user?._id || null;
                ticket.closedByName = closerName;

                if (!remark && !req.file) {
                    ticket.remarks.push({
                        text: `Ticket was marked as ${status} by ${closerName}.`,
                        addedBy: req?.admin?._id || req?.user?._id || null,
                        addedByName: closerName,
                        role: 'System',
                        type: 'status_update'
                    });
                }
            }
        }
        if (priority) ticket.priority = priority;

        if (remark || req.file) {
            ticket.remarks.push({
                text: remark || '',
                attachmentUrl: req?.file?.path || null,
                addedBy: req?.admin?._id || req?.user?._id || null,
                addedByName: req?.admin?.name || req?.user?.name || 'Unknown',
                role: req?.admin ? (req.admin.designation || req.admin.role || 'Admin') : 'Customer',
                type: 'status_update'
            });
        }

        await ticket.save();

        // Trigger action taken email if status is In Progress
        if (status === 'In Progress') {
            await sendActionTakenEmail(ticket, remark, req?.admin);
        }

        // Trigger resolved email if status is updated to Resolved
        if (status === 'Resolved') {
            await sendClosingTicketEmail(ticket, remark, req?.admin);
        }

        const io = req.app.get('io');
        if (io) {
            io.to(ticket._id.toString()).emit('ticket_updated', ticket);
        }

        return res.status(200).json({
            success: true,
            message: 'Ticket updated successfully',
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update ticket' });
    }
};

// Customer: Add Chat Message
exports.addChatMessageUser = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.user?._id) return res.status(400).json({ success: false, message: 'Invalid request' });
        const { text } = req.body;

        if (!text && !req.file) return res.status(400).json({ success: false, message: 'Message text or attachment is required.' });

        const ticket = await Ticket.findOne({ _id: req.params.id, user: req.user._id });
        if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

        ticket.remarks.push({
            text: text || '',
            attachmentUrl: req?.file?.path || null,
            addedBy: req.user._id,
            addedByName: req?.user?.name || 'Customer',
            role: 'Customer',
            type: 'chat'
        });
        await ticket.save();

        const io = req.app.get('io');
        if (io) {
            io.to(ticket._id.toString()).emit('ticket_updated', ticket);
        }

        return res.status(200).json({ success: true, ticket });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to add message' });
    }
};

// Admin: Add Chat Message
exports.addChatMessageAdmin = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.admin?._id) return res.status(400).json({ success: false, message: 'Invalid request' });
        const { text } = req.body;

        if (!text && !req.file) return res.status(400).json({ success: false, message: 'Message text or attachment is required.' });

        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

        ticket.remarks.push({
            text: text || '',
            attachmentUrl: req?.file?.path || null,
            addedBy: req.admin._id,
            addedByName: req?.admin?.name || 'Admin',
            role: req?.admin?.designation || req?.admin?.role || 'Admin',
            type: 'chat'
        });
        await ticket.save();

        const io = req.app.get('io');
        if (io) {
            io.to(ticket._id.toString()).emit('ticket_updated', ticket);
        }

        return res.status(200).json({ success: true, ticket });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to add message' });
    }
};

// Admin: Delete a remark
exports.deleteTicketRemark = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.params?.remarkId) return res.status(400).json({ success: false, message: 'Invalid request' });
        const { id, remarkId } = req.params;
        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        ticket.remarks = ticket.remarks.filter(remark => remark._id.toString() !== remarkId);
        await ticket.save();

        return res.status(200).json({
            success: true,
            message: 'Remark deleted successfully',
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to delete remark' });
    }
};

// Admin: Assign ticket to team members
exports.assignTicket = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.admin?._id) return res.status(400).json({ success: false, message: 'Invalid request' });
        const { role, memberId } = req.body;

        if (!['sales', 'operations', 'support', 'manager'].includes(role)) {
            return res.status(400).json({ success: false, message: 'Invalid role for assignment' });
        }

        const ticket = await Ticket.findById(req.params.id);

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        if (!ticket.assignments) {
            ticket.assignments = {};
        }

        ticket.assignments[role] = memberId || null;

        ticket.assignmentHistory.push({
            roleAssigned: role,
            assignedTo: memberId || null,
            assignedBy: req.admin._id,
            assignedAt: Date.now()
        });

        await ticket.save();

        // Populate assignments for response
        await ticket.populate([
            { path: 'assignments.sales', select: 'name email department' },
            { path: 'assignments.operations', select: 'name email department' },
            { path: 'assignments.support', select: 'name email department' },
            { path: 'assignments.manager', select: 'name email department' },
            { path: 'assignmentHistory.assignedTo', select: 'name email department role designation' },
            { path: 'assignmentHistory.assignedBy', select: 'name email department role designation' }
        ]);

        return res.status(200).json({
            success: true,
            message: 'Ticket assigned successfully',
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to assign ticket' });
    }
};

// Admin: Escalate ticket
exports.escalateTicket = async (req, res) => {
    try {
        if (!req?.params?.id || !req?.admin?._id) return res.status(400).json({ success: false, message: 'Invalid request' });

        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const Admin = require('../models/Admin');
        const User = require('../models/User');

        let managerToAssign = null;

        const salesManager = await Admin.findOne({ role: 'sales_manager' });
        if (salesManager) {
            managerToAssign = salesManager._id;
        } else {
            const fallbackManager = await Admin.findOne({ role: { $in: ['super_admin', 'admin'] } });
            if (fallbackManager) managerToAssign = fallbackManager._id;
        }

        if (!managerToAssign) {
            return res.status(400).json({ success: false, message: 'No manager found to escalate to.' });
        }

        if (!ticket.assignments) {
            ticket.assignments = {};
        }

        ticket.assignments.manager = managerToAssign;

        ticket.assignmentHistory.push({
            roleAssigned: 'manager',
            assignedTo: managerToAssign,
            assignedBy: req.admin._id,
            assignedAt: Date.now()
        });

        // Add an automated remark about escalation
        ticket.remarks.push({
            text: 'Case escalated to Manager due to pending resolution.',
            addedBy: req.admin._id,
            role: req?.admin?.designation || req?.admin?.role || 'Admin',
            createdAt: Date.now()
        });

        await ticket.save();

        if (ticket.user) {
            await User.findByIdAndUpdate(ticket.user, { assignedTo: managerToAssign });
        }

        await ticket.populate([
            { path: 'assignments.sales', select: 'name email department' },
            { path: 'assignments.operations', select: 'name email department' },
            { path: 'assignments.support', select: 'name email department' },
            { path: 'assignments.manager', select: 'name email contactNumber email department designation' },
            { path: 'assignmentHistory.assignedTo', select: 'name email department role designation' },
            { path: 'assignmentHistory.assignedBy', select: 'name email department role designation' }
        ]);

        return res.status(200).json({
            success: true,
            message: 'Ticket escalated successfully',
            ticket
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to escalate ticket' });
    }
};

// Download ticket PDF
exports.downloadTicketPDF = async (req, res) => {
    try {
        if (!req?.params?.id) return res.status(400).json({ success: false, message: 'Ticket ID required' });

        const ticket = await Ticket.findById(req.params.id).populate('user', 'name companyName email phone');
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const { generateTicketPDF } = require('../utils/ticketPdfGenerator');

        const pdfUrl = await generateTicketPDF(ticket);

        return res.status(200).json({
            success: true,
            pdfUrl
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to generate ticket PDF' });
    }
};

// Admin: Get Ticket Analytics
exports.getTicketAnalytics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let matchStage = {};

        if (startDate && endDate) {
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);

            matchStage.createdAt = {
                $gte: new Date(startDate),
                $lte: end
            };
        }

        const totalTickets = await Ticket.countDocuments(matchStage);

        const openTickets = await Ticket.countDocuments({
            ...matchStage,
            status: { $in: ['Open', 'Pending', 'In Progress'] }
        });

        const resolvedTickets = await Ticket.countDocuments({
            ...matchStage,
            status: { $in: ['Resolved', 'Closed'] }
        });

        const highPriorityTickets = await Ticket.countDocuments({
            ...matchStage,
            priority: 'High'
        });

        const trends = {
            totalTicketsTrend: 0,
            openTicketsTrend: 0,
            resolvedTicketsTrend: 0,
            highPriorityTrend: 0
        };

        return res.status(200).json({
            success: true,
            analytics: {
                totalTickets,
                openTickets,
                resolvedTickets,
                highPriorityTickets
            },
            trends
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to fetch ticket analytics' });
    }
};
