const FreightInquiry = require('../models/FreightInquiry');

// @desc    Get all freight clients with query summary counts
// @route   GET /api/prospects/freight-queries
// @access  Protected (Admin/Member)
const getClients = async (req, res) => {
    try {
        const { scope = 'own', search = '', page = 1, limit = 20, salesperson,
            country, shippingLine, state, pinCode, modeOfShipment, status,
            startDate, endDate } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        // Build filter
        const filter = {};
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (scope === 'team' && managerRoles.includes(req.admin.role)) {
            // No salesperson filter — get all team data unless a specific salesperson is requested
            if (salesperson) {
                filter.salesperson = salesperson;
            }
        } else {
            filter.salesperson = req.admin._id;
        }

        if (search.trim()) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { companyName: { $regex: escaped, $options: 'i' } },
                { contactPersonName: { $regex: escaped, $options: 'i' } },
                { contactNumber: { $regex: escaped, $options: 'i' } },
                { email: { $regex: escaped, $options: 'i' } }
            ];
        }

        // New filters
        if (country) filter.businessCountries = { $regex: country, $options: 'i' };
        if (shippingLine) filter.shippingLine = { $regex: shippingLine, $options: 'i' };
        if (state) filter.state = { $regex: state, $options: 'i' };
        if (pinCode) filter.pinCode = { $regex: pinCode, $options: 'i' };
        if (modeOfShipment) filter.modeOfShipment = modeOfShipment;
        if (status) filter.status = status;
        if (startDate || endDate) {
            const start = startDate ? new Date(startDate) : new Date(0);
            const end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();

            const dateFilter = { $gte: start, $lte: end };
            const dateCondition = {
                $or: [
                    { createdAt: dateFilter },
                    { "queries.createdAt": dateFilter }
                ]
            };

            if (filter.$or) {
                const searchCondition = { $or: filter.$or };
                delete filter.$or;
                filter.$and = [searchCondition, dateCondition];
            } else {
                filter.$or = dateCondition.$or;
            }
        }

        const total = await FreightInquiry.countDocuments(filter);
        const clients = await FreightInquiry.find(filter)
            .populate('salesperson', 'name email')
            .sort({ updatedAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean();

        // Add query summary to each client - Filtering individual queries by the same criteria
        const clientsWithSummary = clients.map(client => {
            let queries = client.queries || [];

            // Apply filters to the individual queries for the summary counts
            if (startDate || endDate) {
                const start = startDate ? new Date(startDate) : new Date(0);
                const end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();
                queries = queries.filter(q => {
                    const qDate = new Date(q.createdAt);
                    return qDate >= start && qDate <= end;
                });
            }

            if (modeOfShipment) {
                queries = queries.filter(q => q.modeOfShipment === modeOfShipment);
            }

            const openQueries = queries.filter(q => !q.status.startsWith('Closed')).length;
            const closedQueries = queries.filter(q => q.status.startsWith('Closed')).length;
            const wonQueries = queries.filter(q => q.status === 'Closed - Won').length;

            return {
                ...client,
                querySummary: {
                    total: queries.length,
                    open: openQueries,
                    closed: closedQueries,
                    won: wonQueries
                }
            };
        });

        res.json({
            clients: clientsWithSummary,
            pagination: {
                total,
                page: pageNum,
                pages: Math.ceil(total / limitNum),
                limit: limitNum
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching clients' });
    }
};

// @desc    Get dashboard stats
// @route   GET /api/prospects/freight-queries/stats
// @access  Protected (Admin/Member)
const getStats = async (req, res) => {
    try {
        const { scope = 'own', search = '', salesperson,
            country, shippingLine, state, pinCode, modeOfShipment, status,
            startDate, endDate } = req.query;

        // Build same filter as getClients to ensure stats match list
        const filter = {};
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (scope === 'team' && managerRoles.includes(req.admin.role)) {
            if (salesperson) filter.salesperson = salesperson;
        } else {
            filter.salesperson = req.admin._id;
        }

        if (search && search.trim()) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { companyName: { $regex: escaped, $options: 'i' } },
                { contactPersonName: { $regex: escaped, $options: 'i' } },
                { contactNumber: { $regex: escaped, $options: 'i' } },
                { email: { $regex: escaped, $options: 'i' } }
            ];
        }

        if (country) filter.businessCountries = { $regex: country, $options: 'i' };
        if (shippingLine) filter.shippingLine = { $regex: shippingLine, $options: 'i' };
        if (state) filter.state = { $regex: state, $options: 'i' };
        if (pinCode) filter.pinCode = { $regex: pinCode, $options: 'i' };
        if (modeOfShipment) filter.modeOfShipment = modeOfShipment;
        if (status) filter.status = status;

        // Note: For stats, we might want to include clients with activity in date range
        // but for now let's use the same document-level date filter to be consistent with the list
        if (startDate || endDate) {
            const start = startDate ? new Date(startDate) : new Date(0);
            const end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();

            const dateFilter = { $gte: start, $lte: end };
            const dateCondition = {
                $or: [
                    { createdAt: dateFilter },
                    { "queries.createdAt": dateFilter }
                ]
            };

            if (filter.$or) {
                const searchCondition = { $or: filter.$or };
                delete filter.$or;
                filter.$and = [searchCondition, dateCondition];
            } else {
                filter.$or = dateCondition.$or;
            }
        }

        const clients = await FreightInquiry.find(filter)
            .select('queries salesperson')
            .populate('salesperson', 'name')
            .lean();

        let totalQueries = 0;
        let openQueries = 0;
        let inProgressQueries = 0;
        let quotedQueries = 0;
        let closedWon = 0;
        let closedLost = 0;

        const teamMap = {};

        clients.forEach(client => {
            let queries = client.queries || [];

            // Apply same query-level filtering as in getClients for the dashboard stats
            if (startDate || endDate) {
                const start = startDate ? new Date(startDate) : new Date(0);
                const end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();
                queries = queries.filter(q => {
                    const qDate = new Date(q.createdAt);
                    return qDate >= start && qDate <= end;
                });
            }

            if (modeOfShipment) {
                queries = queries.filter(q => q.modeOfShipment === modeOfShipment);
            }

            const qCount = queries.length;
            totalQueries += qCount;

            let c_open = 0, c_inProgress = 0, c_quoted = 0, c_won = 0, c_lost = 0;

            queries.forEach(q => {
                switch (q.status) {
                    case 'Open': openQueries++; c_open++; break;
                    case 'In Progress': inProgressQueries++; c_inProgress++; break;
                    case 'Quoted': quotedQueries++; c_quoted++; break;
                    case 'Closed - Won': closedWon++; c_won++; break;
                    case 'Closed - Lost': closedLost++; c_lost++; break;
                }
            });

            // Group by salesperson for team summary
            if (client.salesperson) {
                const spId = String(client.salesperson._id);
                if (!teamMap[spId]) {
                    teamMap[spId] = {
                        _id: spId,
                        name: (client.salesperson && typeof client.salesperson === 'object') ? (client.salesperson.name || 'Unknown') : 'Unknown',
                        totalClients: 0,
                        totalQueries: 0,
                        openQueries: 0,
                        closedWon: 0,
                        closedLost: 0
                    };
                }
                teamMap[spId].totalClients++;
                teamMap[spId].totalQueries += qCount;
                teamMap[spId].openQueries += c_open;
                teamMap[spId].closedWon += c_won;
                teamMap[spId].closedLost += c_lost;
            }
        });

        const totalClosed = closedWon + closedLost;
        const conversionRate = totalClosed > 0 ? Math.round((closedWon / totalClosed) * 100) : 0;

        const teamBreakdown = Object.values(teamMap).map(member => {
            const tClosed = member.closedWon + member.closedLost;
            member.conversionRate = tClosed > 0 ? Math.round((member.closedWon / tClosed) * 100) : 0;
            return member;
        }).sort((a, b) => b.totalClients - a.totalClients);

        res.json({
            totalClients: clients.length,
            totalQueries,
            openQueries,
            inProgressQueries,
            quotedQueries,
            closedWon,
            closedLost,
            conversionRate,
            teamBreakdown
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching stats' });
    }
};

// @desc    Get all queries for a specific client
// @route   GET /api/prospects/freight-queries/:clientId
// @access  Protected (Admin/Member)
const getClientQueries = async (req, res) => {
    try {
        const { clientId } = req.params;
        const client = await FreightInquiry.findById(clientId)
            .populate('salesperson', 'name email')
            .populate('queries.notes.addedBy', 'name')
            .populate('queries.closedBy', 'name')
            .lean();

        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // Authorization: member can only see own clients
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (!managerRoles.includes(req.admin.role)) {
            if (String(client.salesperson._id || client.salesperson) !== String(req.admin._id)) {
                return res.status(403).json({ message: 'Not authorized to view this client' });
            }
        }

        // Sort queries by createdAt descending
        if (client.queries) {
            client.queries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        }

        res.json(client);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching client queries' });
    }
};

// @desc    Add a new query to a client
// @route   POST /api/prospects/freight-queries/:clientId
// @access  Protected (Admin/Member)
const addQuery = async (req, res) => {
    try {
        const { clientId } = req.params;
        const {
            subject, modeOfShipment, portOfLoading, portOfDestination,
            commodity, weight, volume, containerType, numberOfContainers,
            expectedShipmentDate, quotedRate, remarks
        } = req.body;

        if (!subject || !subject.trim()) {
            return res.status(400).json({ message: 'Query subject is required' });
        }

        const client = await FreightInquiry.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // Authorization
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (!managerRoles.includes(req.admin.role)) {
            if (String(client.salesperson) !== String(req.admin._id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        // Generate queryId
        client.queryCounter = (client.queryCounter || 0) + 1;
        const queryId = `FQ-${String(client.queryCounter).padStart(4, '0')}`;

        const newQuery = {
            queryId,
            subject: subject.trim(),
            modeOfShipment: modeOfShipment || '',
            portOfLoading: portOfLoading || '',
            portOfDestination: portOfDestination || '',
            commodity: commodity || '',
            weight: weight || '',
            volume: volume || '',
            containerType: containerType || '',
            numberOfContainers: numberOfContainers || 0,
            expectedShipmentDate: expectedShipmentDate || undefined,
            quotedRate: quotedRate || '',
            remarks: remarks || '',
            status: 'Open',
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date()
        };

        client.queries.push(newQuery);
        await client.save();

        // Return the newly added query
        const addedQuery = client.queries[client.queries.length - 1];
        res.status(201).json({ message: 'Query added successfully', query: addedQuery });
    } catch (error) {
        res.status(500).json({ message: 'Server error adding query' });
    }
};

// @desc    Update a query (details, status, add note)
// @route   PUT /api/prospects/freight-queries/:clientId/:queryId
// @access  Protected (Admin/Member)
const updateQuery = async (req, res) => {
    try {
        const { clientId, queryId } = req.params;
        const updateData = req.body;

        const client = await FreightInquiry.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // Authorization
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (!managerRoles.includes(req.admin.role)) {
            if (String(client.salesperson) !== String(req.admin._id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        const query = client.queries.find(q => q.queryId === queryId);
        if (!query) {
            return res.status(404).json({ message: `Query ${queryId} not found` });
        }

        // Prevent updating a closed query's shipment details (but allow adding notes)
        if (query.status.startsWith('Closed') && !updateData.newNote && updateData.status === undefined) {
            return res.status(400).json({ message: 'Cannot modify a closed query. Reopen it first.' });
        }

        // Update allowed fields
        const editableFields = [
            'subject', 'modeOfShipment', 'portOfLoading', 'portOfDestination',
            'commodity', 'weight', 'volume', 'containerType', 'numberOfContainers',
            'expectedShipmentDate', 'quotedRate', 'remarks', 'status'
        ];

        editableFields.forEach(field => {
            if (updateData[field] !== undefined) {
                if (field === 'expectedShipmentDate' && !updateData[field]) {
                    query[field] = undefined;
                } else {
                    query[field] = updateData[field];
                }
            }
        });

        // Add note if provided
        if (updateData.newNote && updateData.newNote.trim()) {
            query.notes.push({
                text: updateData.newNote.trim(),
                addedBy: req.admin._id,
                createdAt: new Date()
            });
        }

        query.updatedAt = new Date();
        await client.save();

        res.json({ message: 'Query updated successfully', query });
    } catch (error) {
        res.status(500).json({ message: 'Server error updating query' });
    }
};

// @desc    Close a query
// @route   PATCH /api/prospects/freight-queries/:clientId/:queryId/close
// @access  Protected (Admin/Member)
const closeQuery = async (req, res) => {
    try {
        const { clientId, queryId } = req.params;
        const { closeStatus, note } = req.body; // 'Closed - Won' or 'Closed - Lost'

        if (!closeStatus || !['Closed - Won', 'Closed - Lost'].includes(closeStatus)) {
            return res.status(400).json({ message: 'closeStatus must be "Closed - Won" or "Closed - Lost"' });
        }

        const client = await FreightInquiry.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // Authorization
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (!managerRoles.includes(req.admin.role)) {
            if (String(client.salesperson) !== String(req.admin._id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        const query = client.queries.find(q => q.queryId === queryId);
        if (!query) {
            return res.status(404).json({ message: `Query ${queryId} not found` });
        }

        // Guard: already closed
        if (query.status.startsWith('Closed')) {
            return res.status(400).json({ message: `Query is already closed (${query.status})` });
        }

        query.status = closeStatus;
        query.closedAt = new Date();
        query.closedBy = req.admin._id;
        query.updatedAt = new Date();

        // Add closure note
        const noteText = note || `Query closed as "${closeStatus}"`;
        query.notes.push({
            text: noteText,
            addedBy: req.admin._id,
            createdAt: new Date()
        });

        await client.save();
        res.json({ message: 'Query closed successfully', query });
    } catch (error) {
        res.status(500).json({ message: 'Server error closing query' });
    }
};

// @desc    Reopen a closed query
// @route   PATCH /api/prospects/freight-queries/:clientId/:queryId/reopen
// @access  Protected (Admin/Member)
const reopenQuery = async (req, res) => {
    try {
        const { clientId, queryId } = req.params;

        const client = await FreightInquiry.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // Authorization
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        if (!managerRoles.includes(req.admin.role)) {
            if (String(client.salesperson) !== String(req.admin._id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        const query = client.queries.find(q => q.queryId === queryId);
        if (!query) {
            return res.status(404).json({ message: `Query ${queryId} not found` });
        }

        // Guard: not closed
        if (!query.status.startsWith('Closed')) {
            return res.status(400).json({ message: `Query is not closed (current: ${query.status})` });
        }

        query.status = 'Open';
        query.closedAt = undefined;
        query.closedBy = undefined;
        query.updatedAt = new Date();

        query.notes.push({
            text: 'Query reopened',
            addedBy: req.admin._id,
            createdAt: new Date()
        });

        await client.save();
        res.json({ message: 'Query reopened successfully', query });
    } catch (error) {
        res.status(500).json({ message: 'Server error reopening query' });
    }
};

// @desc    Reassign a client to another salesperson
// @route   PATCH /api/prospects/freight-queries/:clientId/reassign
// @access  Protected (Admin/Super Admin/Manager)
const reassignClient = async (req, res) => {
    try {
        const { clientId } = req.params;
        const { newSalespersonId } = req.body;

        // Verify the requesting user is a manager/admin or specifically authorized by email
        const managerRoles = ['super_admin', 'admin', 'sales_manager'];
        const authorizedEmails = [
            'pb@thedflgroup.com', 
            'jameswaltercop@gmail.com', 
            'piyush19807work@gmail.com',
            'piyushsinha19807@gmail.com',
            'kaushal.tech@thedflgroup.com', 
            'kaushal@gmail.com',
            'himani@dflindia.in', 
            'dk@thedflgroup.com'
        ];
        const isEmailAuthorized = authorizedEmails.includes(req.admin.email);

        if (!managerRoles.includes(req.admin.role) && !isEmailAuthorized) {
            return res.status(403).json({ message: 'Not authorized to reassign clients' });
        }

        if (!newSalespersonId) {
            return res.status(400).json({ message: 'New salesperson ID is required' });
        }

        // Find the client
        const client = await FreightInquiry.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // To add a descriptive note, we fetch the names of both salespersons.
        const Admin = require('../models/Admin');
        let newMemberName = 'another team member';
        let oldMemberName = 'previous member';

        try {
            const [targetAdmin, currentAdmin] = await Promise.all([
                Admin.findById(newSalespersonId).select('name'),
                Admin.findById(client.salesperson).select('name')
            ]);
            
            if (targetAdmin) newMemberName = targetAdmin.name;
            if (currentAdmin) oldMemberName = currentAdmin.name;
        } catch (error) {
            return res.status(500).json({
                message: error.message || 'Server error fetching salesperson details for reassignment'
            });
        }

        const reassignmentNote = `Reassigned from ${oldMemberName} to ${newMemberName} by ${req.admin.name || 'Admin'}`;

        // Update the client
        client.salesperson = newSalespersonId;
        client.updatedAt = new Date();

        // Add to global history
        client.history.push({
            status: client.status,
            remarks: reassignmentNote,
            timestamp: new Date(),
            updatedBy: req.admin._id
        });

        // Add to global remarks string (for legacy display if used)
        const timestampStr = new Date().toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
        client.remarks = (client.remarks || '') + `\n[${timestampStr}]: ${reassignmentNote}`;

        // Add note to ALL open queries indicating reassignment
        if (client.queries && client.queries.length > 0) {
            // Find the most recent query or all open queries
            client.queries.forEach(q => {
                if (q.status !== 'Closed - Won' && q.status !== 'Closed - Lost') {
                    q.notes.push({
                        text: `Client reassigned to ${newMemberName} by ${req.admin.name || 'Admin'}`,
                        addedBy: req.admin._id,
                        createdAt: new Date()
                    });
                }
            });
        }

        await client.save();

        res.json({ message: `Client reassigned to ${newMemberName} successfully`, client });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server error reassigning client' });
    }
};

module.exports = {
    getClients,
    getStats,
    getClientQueries,
    addQuery,
    updateQuery,
    closeQuery,
    reopenQuery,
    reassignClient
};
