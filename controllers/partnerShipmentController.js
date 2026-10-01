const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { createShipment } = require('./shipmentController');
const { getISTDateRange } = require('../utils/dateUtils');
const XLSX = require('xlsx');

const resolvePartnerCustomer = async (partnerId, userId, customerType, reqPartner, payloadBody) => {
    // 1. If a specific customer ID is provided, resolve that mapped customer first
    if (userId) {
        let customer = null;

        if (typeof userId === 'string' && userId.match(/^[0-9a-fA-F]{24}$/)) {
            customer = await User.findById(userId);
        }

        if (!customer) {
            customer = await User.findOne({ customerId: userId });
        }

        if (customer) {
            // If mapped to this partner, return customer
            if (String(customer.partnerId) === String(partnerId)) {
                return customer;
            }
            // If partnerCode matches but partnerId wasn't populated
            if (customer.partnerCode === reqPartner.partnerCode) {
                customer.partnerId = partnerId;
                await customer.save();
                return customer;
            }
        }
    }

    // 2. If no specific customer was chosen, but customerType is Walk-In, use/create ad-hoc walk-in user
    if (customerType === 'Walk-In') {
        const dynamicPhone = payloadBody?.shipperDetails?.phone || reqPartner.phone || '0000000000';
        const dynamicName = payloadBody?.shipperDetails?.name || `Walk-In (${reqPartner.displayName || reqPartner.companyName || 'Customer'})`;
        const dynamicEmail = `walkin.${dynamicPhone}.${partnerId}@dfl.com`.toLowerCase();

        let walkinUser = await User.findOne({ email: dynamicEmail });
        if (!walkinUser) {
            walkinUser = await User.create({
                name: dynamicName,
                email: dynamicEmail,
                phone: dynamicPhone,
                password: Math.random().toString(36).slice(-8),
                customerId: `WALKIN-${Math.floor(1000 + Math.random() * 9000)}`,
                accountType: 'personal',
                partnerId: partnerId,
                partnerCode: reqPartner.partnerCode,
                tag: '923971e40ebbd2f61e7215f5763567d1',
                acquisitionSourceType: 'partner_referral',
                acquiredByType: 'Partner',
                acquiredById: partnerId,
                referralSource: 'Walk-In'
            });
        }
        return walkinUser;
    }

    return null;
};

// Helper: Build expanded carrier filter (matches RSA along with Royal Mail, DPD, Yodel)
const buildCarrierFilter = (carrier) => {
    if (!carrier || carrier === 'All') return null;
    const carrierList = carrier.split(',').map(c => c.trim()).filter(Boolean);
    if (carrierList.length === 0) return null;

    const expandedCarriers = [];
    for (const c of carrierList) {
        if (c.toUpperCase() === 'RSA') {
            expandedCarriers.push('RSA', 'Royal Mail', 'RoyalMail', 'DPD', 'Yodel');
        } else {
            expandedCarriers.push(c);
        }
    }

    const carrierRegexPattern = expandedCarriers.map(c => `(${c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')})`).join('|');
    const carrierRegex = new RegExp(carrierRegexPattern, 'i');
    return {
        $or: [
            { 'serviceDetails.carrierName': carrierRegex },
            { 'trackingCarrier': carrierRegex },
            { 'serviceDetails.serviceName': carrierRegex }
        ]
    };
};

const createPartnerShipment = async (req, res) => {
    try {
        const customer = await resolvePartnerCustomer(req.partner._id, req.body.userId, req.body.customerType, req.partner, req.body);

        if (!customer) {
            return res.status(403).json({ message: 'You can only book shipments for your mapped customers.' });
        }

        req.user = {
            _id: req.partner._id,
            isAdmin: true,
            name: req.partner.displayName || req.partner.companyName || req.partner.ownerName || 'Partner',
            partnerContext: {
                partnerId: req.partner._id
            }
        };
        req.body.userId = customer._id.toString();
        
        // Ensure customerType is accurately resolved and passed
        const isWalkInCustomer = customer.referralSource === 'Walk-In' || (customer.customerId && String(customer.customerId).includes('WALKIN-'));
        req.body.customerType = req.body.customerType || (isWalkInCustomer ? 'Walk-In' : 'Regular');

        return createShipment(req, res);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getPartnerShipments = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            status = 'All',
            search = '',
            failedBookings,
            startDate,
            endDate,
            shipperCity,
            consigneeCity,
            carrier,
            shipmentId
        } = req.query;

        const baseQuery = { partnerId: req.partner._id };
        
        if (status && status !== 'All') {
            const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
            baseQuery.status = { $in: statusArray };
        }

        if (failedBookings === 'true') {
            baseQuery.carrierBookingStatus = 'FAILED';
        }

        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            baseQuery.createdAt = {
                $gte: start,
                $lte: end
            };
        }

        if (shipperCity) baseQuery['shipperDetails.city'] = new RegExp(shipperCity, 'i');
        if (consigneeCity) baseQuery['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');
        if (carrier && carrier !== 'All') {
            const carrierFilter = buildCarrierFilter(carrier);
            if (carrierFilter) {
                if (!baseQuery.$and) baseQuery.$and = [];
                baseQuery.$and.push(carrierFilter);
            }
        }
        if (shipmentId) baseQuery.shipmentId = new RegExp(shipmentId, 'i');

        if (search) {
            const regex = new RegExp(search, 'i');
            baseQuery.$or = [
                { shipmentId: regex },
                { trackingId: regex },
                { lastMileAWB: regex },
                { 'consigneeDetails.consigneeName': regex },
                { 'shipperDetails.shipperName': regex },
                { 'shipperDetails.city': regex },
                { 'consigneeDetails.city': regex }
            ];
            
            // Handle ObjectId search
            if (search.match(/^[0-9a-fA-F]{24}$/)) {
                baseQuery.$or.push({ _id: search });
            }
        }

        const skip = (Number(page) - 1) * Number(limit);

        const [shipments, count, statusAggregation, spendAggregation] = await Promise.all([
            Shipment.find(baseQuery)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .populate('user', 'name customerId email phone'),
            Shipment.countDocuments(baseQuery),
            Shipment.aggregate([
                { $match: { partnerId: req.partner._id } },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            Shipment.aggregate([
                { $match: { partnerId: req.partner._id } },
                {
                    $group: {
                        _id: null,
                        totalSpend: {
                            $sum: {
                                $convert: {
                                    input: { $trim: { input: { $toString: '$serviceDetails.price' }, chars: 'â‚¹, ' } },
                                    to: 'double',
                                    onError: 0,
                                    onNull: 0
                                }
                            }
                        }
                    }
                }
            ])
        ]);

        const statusCounts = statusAggregation.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {});
        statusCounts.All = Object.values(statusCounts).reduce((sum, current) => sum + current, 0);

        res.json({
            shipments,
            totalPages: Math.ceil(count / Number(limit)),
            currentPage: Number(page),
            totalShipments: count,
            statusCounts,
            totalSpend: spendAggregation[0]?.totalSpend || 0
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getPartnerShipmentById = async (req, res) => {
    try {
        const id = req.params.id;
        const orFilters = [{ shipmentId: id }];
        if (mongoose.Types.ObjectId.isValid(id)) {
            orFilters.push({ _id: id });
        }

        const shipment = await Shipment.findOne({
            partnerId: req.partner._id,
            $or: orFilters
        }).populate('user', 'name customerId email phone');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        res.json(shipment);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const exportPartnerShipments = async (req, res) => {
    try {
        const { status, hours, startDate, endDate, shipperCity, consigneeCity, carrier, shipmentId, search, failedBookings } = req.query;
        let query = { partnerId: req.partner._id };

        if (status && status !== 'All') {
            const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
            query.status = { $in: statusArray };
        }

        if (failedBookings === 'true') {
            query.carrierBookingStatus = 'FAILED';
        }

        if (hours) {
            const h = parseInt(hours);
            if (!isNaN(h) && h > 0) {
                query.createdAt = {
                    $gte: new Date(Date.now() - h * 60 * 60 * 1000)
                };
            }
        } else if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            query.createdAt = {
                $gte: start,
                $lte: end
            };
        }

        if (shipperCity) query['shipperDetails.city'] = new RegExp(shipperCity, 'i');
        if (consigneeCity) query['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');
        if (carrier && carrier !== 'All') {
            const carrierFilter = buildCarrierFilter(carrier);
            if (carrierFilter) {
                if (!query.$and) query.$and = [];
                query.$and.push(carrierFilter);
            }
        }
        if (shipmentId) query.shipmentId = new RegExp(shipmentId, 'i');

        if (search) {
            const regex = new RegExp(search, 'i');
            query.$or = [
                { shipmentId: regex },
                { trackingId: regex },
                { lastMileAWB: regex },
                { 'consigneeDetails.consigneeName': regex },
                { 'shipperDetails.shipperName': regex },
                { 'shipperDetails.city': regex },
                { 'consigneeDetails.city': regex }
            ];
            if (search.match(/^[0-9a-fA-F]{24}$/)) {
                query.$or.push({ _id: search });
            }
        }

        const shipments = await Shipment.find(query)
            .populate('user', 'name email companyName phone')
            .sort({ createdAt: -1 });

        const excelData = shipments.map(s => {
            const boxesSummary = s.shipmentDetails?.boxes?.map(b => {
                const qty = b.items?.reduce((acc, i) => acc + (parseFloat(i.quantity) || 0), 0) || 0;
                return `${b.length}x${b.width}x${b.height} (${b.weight}kg) - Qty: ${qty}`;
            }).join('; ') || '';

            return {
                'Shipment ID': s.shipmentId || s._id.toString(),
                'Tracking ID': s.trackingId || '-',
                'Customer Name': s.user?.name || s.user?.companyName || '-',
                'Shipper Name': s.shipperDetails?.name || '-',
                'Consignee Name': s.consigneeDetails?.name || '-',
                'Origin City': s.shipperDetails?.city || '-',
                'Destination City': s.consigneeDetails?.city || '-',
                'Status': s.status || '-',
                'Amount': s.serviceDetails?.price || '0',
                'Carrier': s.serviceDetails?.carrierName || '-',
                'Service Type': s.serviceDetails?.serviceType || '-',
                'Date': s.createdAt ? new Date(s.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-',
                'Boxes': boxesSummary
            };
        });

        if (excelData.length === 0) {
            return res.status(404).json({ message: 'No shipments found for the given criteria.' });
        }

        const ws = XLSX.utils.json_to_sheet(excelData);
        const csv = XLSX.utils.sheet_to_csv(ws);

        res.header('Content-Type', 'text/csv');
        res.attachment('franchise_shipments.csv');
        return res.send(csv);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    createPartnerShipment,
    getPartnerShipments,
    getPartnerShipmentById,
    exportPartnerShipments
};
 