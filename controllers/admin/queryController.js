const QuoteQuery = require('../../models/QuoteQuery');
const User = require('../../models/User');
const sendEmail = require('../../utils/emailService');
const { logActivity } = require('../../utils/activityLogger');

// @desc    Get all quote queries
// @route   GET /api/admin/queries
// @access  Private/Admin
const getAllQueries = async (req, res) => {
    try {
        const { status, page = 1, limit = 10 } = req.query;
        let query = {};

        if (status && status !== 'All') {
            query.status = status;
        }

        // Role-based Access Control
        // Members see queries from their assigned users AND queries assigned to them specifically
        if (req.admin.role === 'member') {
            const assignedUsers = await User.find({ assignedTo: req.admin._id }).select('_id');
            const assignedUserIds = assignedUsers.map(u => u._id);

            query.$or = [
                { user: { $in: assignedUserIds } }, // Queries from their customers
                { assignedTo: req.admin._id }       // Queries assigned directly to them
            ];
        } else if (req.query.assignedTo) {
            // Admin filtering by assigned team member
            if (req.query.assignedTo !== 'All') {
                query.assignedTo = req.query.assignedTo;
            }
        }

        const count = await QuoteQuery.countDocuments(query);
        const queries = await QuoteQuery.find(query)
            .populate('user', 'name email phone companyName')
            .populate('assignedTo', 'name email')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        res.json({
            queries,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalQueries: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get specific query details
// @route   GET /api/admin/queries/:id
// @access  Private/Admin
const getQueryById = async (req, res) => {
    try {
        const query = await QuoteQuery.findById(req.params.id)
            .populate('user', 'name email phone companyName')
            .populate('assignedTo', 'name email');

        if (!query) {
            return res.status(404).json({ message: 'Query not found' });
        }
        res.json(query);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update query status
// @route   PUT /api/admin/queries/:id
// @access  Private/Admin
const updateQueryStatus = async (req, res) => {
    try {
        const { status, remarks, notes, quotedPrice, currency } = req.body;
        const query = await QuoteQuery.findById(req.params.id);

        if (!query) {
            return res.status(404).json({ message: 'Query not found' });
        }

        const oldStatus = query.status;
        let updateMade = false;

        // 1. Handle Status Change - Log in notes if changed
        if (status && status !== oldStatus) {
            query.status = status;
            query.notes.push({
                text: `Status updated to ${status}`,
                addedBy: req.admin._id
            });
            updateMade = true;
        }

        // 2. Handle Notes / Remarks - Push to notes array
        const noteText = notes || remarks;
        if (noteText) {
            query.notes.push({
                text: noteText,
                addedBy: req.admin._id
            });
            updateMade = true;
        }

        // 3. Handle Other Data (Quoted Price, etc.)
        if (quotedPrice !== undefined) {
            query.quotedPrice = quotedPrice;
            updateMade = true;
        }
        if (currency) {
            query.currency = currency;
            updateMade = true;
        }

        if (updateMade) {
            await query.save();

            // Log activity in global ActivityLog
            await logActivity(req, {
                action: 'UPDATE_QUERY_STATUS',
                target: query._id.toString(),
                targetModel: 'QuoteQuery',
                details: {
                    oldStatus,
                    newStatus: query.status,
                    note: noteText,
                    quotedPrice
                }
            });
        }

        const updatedQuery = await QuoteQuery.findById(query._id)
            .populate('user', 'name email phone companyName')
            .populate('assignedTo', 'name email');

        res.json(updatedQuery);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Assign Query to Team Member
// @route   PUT /api/admin/queries/:id/assign
// @access  Private/Admin
const assignQuery = async (req, res) => {
    try {
        const { memberId } = req.body;
        const query = await QuoteQuery.findById(req.params.id);

        if (query) {
            query.assignedTo = memberId || null;
            const updatedQuery = await query.save();
            res.json(updatedQuery);
        } else {
            res.status(404).json({ message: 'Query not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Send Custom Quote via Email
// @route   POST /api/admin/send-quote
// @access  Private/Admin
const sendCustomQuote = async (req, res) => {
    try {
        const { customerEmail, customerName, quoteDetails, shipmentDetails, notes } = req.body;

        if (!customerEmail || !quoteDetails) {
            return res.status(400).json({ message: 'Customer email and quote details are required' });
        }

        await logActivity(req, {
            action: 'SEND_CUSTOM_QUOTE',
            target: null, // No specific target DB ID for now, or create a Quote record if needed
            targetModel: 'Quote',
            details: { customerEmail, customerName, total: quoteDetails.totalPrice, service: quoteDetails.serviceName }
        });

        const message = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f6f8; margin: 0; padding: 0; }
                .wrapper { width: 100%; table-layout: fixed; background-color: #f4f6f8; padding-bottom: 40px; }
                .webkit { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                .header { background: linear-gradient(135deg, #0B4F6C 0%, #083D54 100%); padding: 35px 20px; text-align: center; }
                .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
                .header p { color: rgba(255,255,255,0.8); margin: 8px 0 0; font-size: 14px; }
                
                .content { padding: 40px 30px; }
                .greeting { font-size: 18px; color: #1e293b; margin-bottom: 25px; font-weight: 600; }
                
                .price-card { background: linear-gradient(to right, #f8fcfd, #f0f7fa); border: 1px solid #dae9f2; border-radius: 10px; padding: 30px; text-align: center; margin-bottom: 35px; }
                .price-label { font-size: 14px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; margin-bottom: 8px; }
                .price-amount { font-size: 42px; color: #0B4F6C; font-weight: 800; line-height: 1; margin: 10px 0; }
                .price-service { font-size: 16px; color: #334155; font-weight: 600; margin-top: 10px; }
                .price-meta { font-size: 13px; color: #64748b; margin-top: 5px; }

                .section-title { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 15px; margin-top: 30px; }

                .details-grid { width: 100%; border-collapse: separate; border-spacing: 0; }
                .details-grid th { text-align: left; color: #64748b; font-weight: 500; padding: 8px 0; font-size: 14px; width: 35%; }
                .details-grid td { text-align: right; color: #1e293b; font-weight: 600; padding: 8px 0; font-size: 15px; }
                
                .box-list { margin-top: 10px; }
                .box-item { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 15px; margin-bottom: 8px; display: flex; justify-content: space-between; font-size: 13px; color: #475569; }
                .box-dim { font-family: monospace; color: #64748b; }

                .notes-box { background-color: #fffbeb; border: 1px solid #fef3c7; color: #92400e; padding: 15px; border-radius: 8px; font-size: 14px; line-height: 1.5; margin-bottom: 25px; display: flex; align-items: flex-start; gap: 10px; }
                
                .cta-container { text-align: center; margin-top: 40px; margin-bottom: 20px; }
                .cta-button { background-color: #0B4F6C; color: #ffffff !important; padding: 18px 40px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; display: inline-block; transition: all 0.3s ease; box-shadow: 0 10px 20px rgba(11, 79, 108, 0.2); border: 2px solid #0B4F6C; }
                .cta-button:hover { background-color: #ffffff; color: #0B4F6C !important; box-shadow: 0 5px 15px rgba(11, 79, 108, 0.15); transform: translateY(-2px); }
                
                .footer { text-align: center; padding: 30px; color: #94a3b8; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="wrapper">
                <div class="webkit">
                    <div class="header">
                        <h1>Exclusive Quote</h1>
                        <p>Tailored Shipping Solution</p>
                    </div>
                    <div class="content">
                        <div class="greeting">Hi ${customerName || 'Customer'},</div>
                        <p style="color: #475569; margin-bottom: 30px;">Here is the custom shipping quote you requested. This rate is valid for 24 hours.</p>

                        <div class="price-card">
                            <div class="price-label">Total Estimate</div>
                            <div class="price-amount">₹${quoteDetails.totalPrice}</div>
                            <div class="price-service">${quoteDetails.serviceName || 'Express Service'}</div>
                            <div class="price-meta">${quoteDetails.transitTime || 'Standard Delivery'}</div>
                        </div>

                        ${notes ? `
                        <div class="notes-box">
                            <strong>📝 Note:</strong> ${notes}
                        </div>` : ''}

                        <div class="section-title">Route Details</div>
                        <table class="details-grid">
                            <tr><th>Origin</th><td>${shipmentDetails.originCountry || '-'} (${shipmentDetails.originPincode || '-'})</td></tr>
                            <tr><th>Destination</th><td>${shipmentDetails.destinationCountry || '-'} (${shipmentDetails.destinationPincode || '-'})</td></tr>
                        </table>

                        <div class="section-title">Shipment Specs</div>
                        <table class="details-grid">
                            <tr><th>Total Weight</th><td>${shipmentDetails.weight} kg</td></tr>
                            <tr><th>Type</th><td><span style="text-transform: capitalize">${shipmentDetails.type || 'Standard'}</span></td></tr>
                        </table>

                        ${shipmentDetails.boxes && shipmentDetails.boxes.length > 0 ? `
                            <div class="section-title">Package Dimensions</div>
                            <div class="box-list">
                                ${shipmentDetails.boxes.map((box, i) => `
                                    <div class="box-item">
                                        <span>Box ${i + 1}</span>
                                        <span class="box-dim">${box.length}x${box.width}x${box.height} cm | ${box.weight}kg</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                        <div class="cta-container">
                            <a href="${process.env.FRONTEND_URL || 'https://express.thedflgroup.com/login'}/login" class="cta-button">Login to Book Now</a>
                        </div>
                    </div>
                    <div class="footer">
                        <p>&copy; ${new Date().getFullYear()} DFL Group. All rights reserved.</p>
                        <p>Prices are subject to change based on actual weight and dimensions at the time of booking.</p>
                    </div>
                </div>
            </div>
        </body>
        </html>
        `;

        await sendEmail({
            email: customerEmail,
            subject: `Your Shipping Quote (${shipmentDetails.originCountry} to ${shipmentDetails.destinationCountry})`,
            html: message
        });

        res.json({ message: 'Quote sent successfully' });

    } catch (error) {

        res.status(500).json({ message: 'Failed to send quote email', error: error.message });
    }
};

module.exports = {
    getAllQueries,
    getQueryById,
    updateQueryStatus,
    assignQuery,
    sendCustomQuote
};
