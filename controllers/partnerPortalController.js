const crypto = require('crypto');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const Partner = require('../models/Partner');
const Transaction = require('../models/Transaction');
const PaymentRequest = require('../models/PaymentRequest');
const SystemConfig = require('../models/SystemConfig');
const { logActivity } = require('../utils/activityLogger');
const sendEmail = require('../utils/emailService');
const { normalizeEmail, normalizePhoneNumber, checkUserExists, isEmailMatch } = require('../utils/phoneNormalizer');

const generateCustomerId = (isWalkIn = false) => {
    const randomDigits = Math.floor(100000 + Math.random() * 900000);
    return isWalkIn ? `DFLC-WALKIN-${randomDigits}` : `DFLC-${randomDigits}`;
};

const DEFAULT_REWARD_SETTINGS = {
    under1KgFlatRate: 20,
    under1KgEffectiveDate: '2026-10-01T00:00:00+05:30',
    monthlySlabs: [
        { minKg: 1, ratePerKg: 20, label: '1-299 KG' },
        { minKg: 300, ratePerKg: 25, label: '300-999 KG' },
        { minKg: 1000, ratePerKg: 30, label: '1000-2999 KG' },
        { minKg: 3000, ratePerKg: 35, label: '3000-4999 KG' },
        { minKg: 5000, ratePerKg: 38, label: '5000-9999 KG' },
        { minKg: 10000, ratePerKg: 42, label: '10000+ KG' }
    ]
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const roundWeight = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

const parseNumericValue = (value) => {
    const parsed = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
};

const getISTMonthKey = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(new Date(date));

    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    return `${year}-${month}`;
};

const formatMonthLabel = (monthKey) => {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return monthKey || 'Unknown';

    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        month: 'short',
        year: 'numeric'
    }).format(new Date(Date.UTC(year, month - 1, 1)));
};

const normalizeMonthlySlabs = (slabs) => {
    if (!Array.isArray(slabs)) return DEFAULT_REWARD_SETTINGS.monthlySlabs;

    const normalized = slabs
        .map((slab) => ({
            minKg: Number(slab.minKg ?? slab.min ?? 0),
            ratePerKg: Number(slab.ratePerKg ?? slab.rate ?? 0),
            label: slab.label || `${slab.minKg ?? slab.min}+ KG`
        }))
        .filter((slab) => slab.minKg > 0 && slab.ratePerKg >= 0)
        .sort((a, b) => a.minKg - b.minKg);

    return normalized.length ? normalized : DEFAULT_REWARD_SETTINGS.monthlySlabs;
};

const getRewardSettings = async () => {
    try {
        const config = await SystemConfig.findOne({ key: 'franchiseRewardSettings' }).lean();
        return {
            under1KgFlatRate: Number(config?.value?.under1KgFlatRate ?? DEFAULT_REWARD_SETTINGS.under1KgFlatRate),
            under1KgEffectiveDate: config?.value?.under1KgEffectiveDate || DEFAULT_REWARD_SETTINGS.under1KgEffectiveDate,
            monthlySlabs: normalizeMonthlySlabs(config?.value?.monthlySlabs)
        };
    } catch (error) {
        console.error('Failed to load franchise reward settings:', error.message);
        return DEFAULT_REWARD_SETTINGS;
    }
};

const resolveMonthlySlab = (kg, slabs) => {
    const numericKg = Number(kg) || 0;
    if (numericKg <= 0) {
        return { minKg: 0, ratePerKg: 0, label: 'No eligible KG' };
    }

    return [...slabs].reverse().find((slab) => numericKg >= slab.minKg) || { minKg: 0, ratePerKg: 0, label: 'Below minimum' };
};

const getNextMonthlySlab = (kg, slabs) => {
    const numericKg = Number(kg) || 0;
    return slabs.find((slab) => numericKg < slab.minKg) || null;
};

const calculateShipmentWeight = (shipment) => {
    const chargeableWeight = parseNumericValue(shipment?.serviceDetails?.chargeableWeight);
    if (chargeableWeight > 0) return chargeableWeight;

    const boxes = shipment?.shipmentDetails?.boxes || [];
    return boxes.reduce((total, box) => {
        const actualWeight = parseNumericValue(box.weight);
        const length = parseNumericValue(box.length);
        const width = parseNumericValue(box.width);
        const height = parseNumericValue(box.height);
        const volumetricWeight = length && width && height ? (length * width * height) / 5000 : 0;
        return total + Math.max(actualWeight, volumetricWeight);
    }, 0);
};

const buildPartnerRewardSummary = async (partnerId) => {
    const settings = await getRewardSettings();
    const eligibleShipments = await Shipment.find({
        partnerId
    })
        .select('shipmentId status carrierBookingStatus serviceDetails.chargeableWeight shipmentDetails.boxes createdAt')
        .lean();

    const monthlyMap = new Map();
    const seenShipmentIds = new Set();
    const effectiveDate = new Date(settings.under1KgEffectiveDate || '2026-10-01T00:00:00+05:30');

    eligibleShipments.forEach((shipment) => {
        const shipmentKey = shipment.shipmentId || shipment._id?.toString();
        if (!shipmentKey || seenShipmentIds.has(shipmentKey)) {
            return;
        }

        seenShipmentIds.add(shipmentKey);
        const monthKey = getISTMonthKey(shipment.createdAt);
        const weight = calculateShipmentWeight(shipment);
        const current = monthlyMap.get(monthKey) || {
            monthKey,
            kg: 0,
            shipmentCount: 0,
            under1KgCount: 0,
            above1KgWeight: 0,
            legacyKg: 0
        };

        const isNewPolicy = shipment.createdAt ? new Date(shipment.createdAt) >= effectiveDate : false;

        if (isNewPolicy) {
            // Technical specification:
            // If weight < 1000 grams (< 1.0 kg): flat incentive of Rs. 20 per shipment. No prorating.
            // If weight >= 1000 grams (>= 1.0 kg): existing slab-based calculation.
            // Boundary case: exactly 1.000 kg falls into the slab logic, not the flat band.
            if (weight < 1.0) {
                current.under1KgCount += 1;
            } else {
                current.above1KgWeight += weight;
            }
        } else {
            // Legacy shipments prior to effective date retain full slab weight calculation
            current.legacyKg += weight;
        }

        current.kg += weight;
        current.shipmentCount += 1;
        monthlyMap.set(monthKey, current);
    });

    const monthlyBreakdown = [...monthlyMap.values()]
        .map((month) => {
            const kg = roundWeight(month.kg);
            const slabEligibleKg = roundWeight(month.above1KgWeight + month.legacyKg);
            const slab = resolveMonthlySlab(slabEligibleKg, settings.monthlySlabs);
            const above1KgPayout = roundMoney(slabEligibleKg * slab.ratePerKg);
            const under1KgPayout = roundMoney(month.under1KgCount * (settings.under1KgFlatRate || 20));
            const payout = roundMoney(under1KgPayout + above1KgPayout);

            return {
                monthKey: month.monthKey,
                monthLabel: formatMonthLabel(month.monthKey),
                kg,
                shipmentCount: month.shipmentCount,
                under1KgCount: month.under1KgCount,
                above1KgWeight: roundWeight(month.above1KgWeight),
                legacyKg: roundWeight(month.legacyKg),
                under1KgFlatRate: settings.under1KgFlatRate || 20,
                under1KgPayout,
                above1KgPayout,
                slabLabel: slab.label,
                ratePerKg: slab.ratePerKg,
                payout
            };
        })
        .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

    const currentMonthKey = getISTMonthKey();
    const currentMonth = monthlyBreakdown.find((month) => month.monthKey === currentMonthKey) || {
        monthKey: currentMonthKey,
        monthLabel: formatMonthLabel(currentMonthKey),
        kg: 0,
        shipmentCount: 0,
        under1KgCount: 0,
        above1KgWeight: 0,
        legacyKg: 0,
        under1KgFlatRate: settings.under1KgFlatRate || 20,
        under1KgPayout: 0,
        above1KgPayout: 0,
        slabLabel: 'No eligible KG',
        ratePerKg: 0,
        payout: 0
    };

    const totalPayout = monthlyBreakdown.reduce((sum, month) => sum + month.payout, 0);
    const totalEligibleKg = monthlyBreakdown.reduce((sum, month) => sum + month.kg, 0);
    const currentMonthSlabWeight = roundWeight(currentMonth.above1KgWeight + currentMonth.legacyKg);
    const nextSlab = getNextMonthlySlab(currentMonthSlabWeight, settings.monthlySlabs);

    return {
        currentMonth,
        totalEligibleKg: roundWeight(totalEligibleKg),
        totalEligibleShipments: seenShipmentIds.size,
        totalPayout: roundMoney(totalPayout),
        nextSlab: nextSlab
            ? {
                label: nextSlab.label,
                minKg: nextSlab.minKg,
                ratePerKg: nextSlab.ratePerKg,
                kgRemaining: roundMoney(Math.max(0, nextSlab.minKg - currentMonthSlabWeight))
            }
            : null,
        under1KgFlatRate: settings.under1KgFlatRate || 20,
        under1KgEffectiveDate: settings.under1KgEffectiveDate,
        monthlySlabs: settings.monthlySlabs,
        monthlyBreakdown: monthlyBreakdown.slice(0, 6),
        calculationNote: 'Shipments under 1 KG receive a flat Rs. 20 incentive per shipment. Shipments 1 KG and above follow monthly weight slabs.'
    };
};

const createPartnerCustomer = async (req, res) => {
    try {
        const { name, email, phone, password, accountType = 'personal', billingAddress, isWalkIn } = req.body;

        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = normalizePhoneNumber(phone);

        if (!name || !normalizedEmail || !normalizedPhone) {
            return res.status(400).json({ message: 'name, email, and phone are required' });
        }

        const cleanedPhone = phone.toString().replace(/\D/g, '');
        if (cleanedPhone.length < 9 || cleanedPhone.length > 15) {
            return res.status(400).json({ message: 'Invalid phone number format. Please provide a valid number.' });
        }

        const userExists = await checkUserExists(User, normalizedEmail, normalizedPhone);
        if (userExists) {
            if (userExists.email && isEmailMatch(userExists.email, normalizedEmail)) {
                return res.status(400).json({ message: 'Customer already exists with this email address' });
            }
            return res.status(400).json({ message: 'Customer already exists with this phone number' });
        }

        let user;
        let retryCount = 0;

        while (!user && retryCount < 5) {
            try {
                const customerPassword = password || crypto.randomBytes(6).toString('hex');
                user = await User.create({
                    name: name.trim(),
                    email: normalizedEmail,
                    phone: normalizedPhone,
                    password: customerPassword,
                    plainPassword: customerPassword,
                    customerId: generateCustomerId(Boolean(isWalkIn)),
                    accountType,
                    partnerId: req.partner._id,
                    partnerCode: req.partner.partnerCode,
                    tag: '923971e40ebbd2f61e7215f5763567d1', // Franchise tag hash
                    acquisitionSourceType: 'partner_referral',
                    acquiredByType: 'Partner',
                    acquiredById: req.partner._id,
                    assignedTo: req.partner.assignedSalesManager || req.partner.assignedAdmin || null,
                    branch: req.partner.branch || null,
                    referralSource: isWalkIn ? 'Walk-In' : 'Partner Portal',
                    kycData: billingAddress ? { billingAddress } : undefined
                });
            } catch (error) {
                if (error.code === 11000 && error.keyPattern?.customerId) {
                    retryCount += 1;
                    continue;
                }
                throw error;
            }
        }

        if (!user) {
            return res.status(500).json({ message: 'Failed to generate unique Customer ID. Please try again.' });
        }

        await logActivity(req, {
            action: 'PARTNER_CREATE_CUSTOMER',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                customerId: user.customerId,
                customerEmail: user.email,
                partnerCode: req.partner.partnerCode
            },
            actor: { ...req.partner.toObject(), role: 'partner' }
        });

        res.status(201).json({
            success: true,
            message: 'Customer registered successfully',
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            customerId: user.customerId,
            partnerCode: user.partnerCode,
            branch: user.branch
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPartnerCustomers = async (req, res) => {
    try {
        const { page = 1, limit = 10, search } = req.query;
        const query = { partnerId: req.partner._id };

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
                { customerId: searchRegex }
            ];
        }

        const count = await User.countDocuments(query);
        const users = await User.find(query)
            .select('-password')
            .sort({ createdAt: -1 })
            .limit(Number(limit))
            .skip((Number(page) - 1) * Number(limit));

        const userIds = users.map((u) => u._id);
        const bookingStats = await Shipment.aggregate([
            { $match: { user: { $in: userIds } } },
            {
                $group: {
                    _id: '$user',
                    shipmentCount: { $sum: 1 },
                    totalSpend: {
                        $sum: {
                            $convert: {
                                input: { $trim: { input: { $toString: '$serviceDetails.price' }, chars: '₹, ' } },
                                to: 'double',
                                onError: 0,
                                onNull: 0
                            }
                        }
                    },
                    lastShipmentAt: { $max: '$createdAt' }
                }
            }
        ]);

        const statsMap = bookingStats.reduce((acc, item) => {
            acc[item._id.toString()] = item;
            return acc;
        }, {});

        const customers = users.map((user) => {
            const stat = statsMap[user._id.toString()] || {};
            return {
                ...user.toObject(),
                shipmentCount: stat.shipmentCount || 0,
                totalSpend: stat.totalSpend || 0,
                lastShipmentAt: stat.lastShipmentAt || null
            };
        });

        res.json({
            customers,
            totalPages: Math.ceil(count / Number(limit)),
            currentPage: Number(page),
            totalCustomers: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getPartnerDashboard = async (req, res) => {
    try {
        const partner = await Partner.findById(req.partner._id).select('-password');
        const customersCount = await User.countDocuments({ partnerId: req.partner._id });
        const activeCustomers = await Shipment.distinct('user', { partnerId: req.partner._id });
        const shipments = await Shipment.find({ partnerId: req.partner._id })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('user', 'name customerId');

        const shipmentStats = await Shipment.aggregate([
            { $match: { partnerId: req.partner._id } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    revenue: {
                        $sum: {
                            $convert: {
                                input: { $trim: { input: { $toString: '$serviceDetails.price' }, chars: '₹, ' } },
                                to: 'double',
                                onError: 0,
                                onNull: 0
                            }
                        }
                    },
                    weight: {
                        $sum: {
                            $convert: {
                                input: { $trim: { input: { $toString: '$serviceDetails.chargeableWeight' }, chars: ' kKgG,' } },
                                to: 'double',
                                onError: 0,
                                onNull: 0
                            }
                        }
                    }
                }
            }
        ]);

        const statsByStatus = shipmentStats.reduce((acc, item) => {
            acc[item._id || 'Unknown'] = item.count;
            return acc;
        }, {});

        const totalRevenue = shipmentStats.reduce((sum, item) => sum + (item.revenue || 0), 0);
        const totalWeight = shipmentStats.reduce((sum, item) => sum + (item.weight || 0), 0);
        
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);

        const monthlyRevenueAgg = await Shipment.aggregate([
            { $match: { partnerId: req.partner._id, createdAt: { $gte: monthStart } } },
            {
                $group: {
                    _id: null,
                    total: {
                        $sum: {
                            $convert: {
                                input: { $trim: { input: { $toString: '$serviceDetails.price' }, chars: '₹, ' } },
                                to: 'double',
                                onError: 0,
                                onNull: 0
                            }
                        }
                    }
                }
            }
        ]);

        const rewardSummary = await buildPartnerRewardSummary(req.partner._id);

        res.json({
            partner: {
                _id: partner._id,
                companyName: partner.companyName,
                displayName: partner.displayName,
                ownerName: partner.ownerName,
                partnerCode: partner.partnerCode,
                walletBalance: partner.walletBalance,
                availableCredit: partner.availableCredit,
                outstandingAmount: partner.outstandingAmount,
                branch: partner.branch,
                partnerType: partner.partnerType,
                kycStatus: partner.kycStatus,
                uploadedByAdmin: Boolean(
                    partner.kycData?.uploadedByAdmin &&
                    (partner.kycData?.documentNumber || partner.kycData?.panNumber || partner.kycData?.aadharFrontImage || partner.kycData?.panCardImage)
                ),
                partnerConfirmed: Boolean(partner.kycData?.partnerConfirmed),
                kycData: partner.kycData || {}
            },
            kpis: {
                totalCustomers: customersCount,
                activeCustomers: activeCustomers.length,
                totalShipments: shipmentStats.reduce((sum, item) => sum + item.count, 0),
                totalRevenue,
                totalWeight,
                monthlyRevenue: monthlyRevenueAgg[0]?.total || 0,
                openTickets: 0
            },
            shipmentStatusCounts: statsByStatus,
            recentShipments: shipments,
            rewardSummary
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getPartnerWallet = async (req, res) => {
    try {
        const { page = 1, limit = 10, status = 'All' } = req.query;
        
        const partner = await Partner.findById(req.partner._id).select('walletBalance creditLimit availableCredit outstandingAmount walletMode');
        
        const query = {
            walletOwnerId: req.partner._id,
            walletOwnerType: 'Partner'
        };
        
        if (status && status !== 'All') {
            query.status = status;
        }

        let transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .skip((parseInt(page) - 1) * parseInt(limit))
            .limit(parseInt(limit))
            .lean();

        // Attach proofUrl if it was a wallet recharge
        const referenceIds = transactions.map(t => t.referenceId).filter(Boolean);
        if (referenceIds.length > 0) {
            const paymentRequests = await PaymentRequest.find({ orderId: { $in: referenceIds } }).select('orderId proofUrl').lean();
            const proofMap = paymentRequests.reduce((acc, pr) => {
                acc[pr.orderId] = pr.proofUrl;
                return acc;
            }, {});
            transactions = transactions.map(t => ({
                ...t,
                proofUrl: proofMap[t.referenceId] || null
            }));
        }

        const totalItems = await Transaction.countDocuments(query);

        res.json({
            wallet: partner,
            transactions,
            totalPages: Math.ceil(totalItems / parseInt(limit)),
            totalItems
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const requestPartnerWalletRecharge = async (req, res) => {
    try {
        const { orderId, amount, transactionId, paymentDate, remarks, paymentMode, senderBankName, senderAccountName } = req.body;

        if (!req.file) {
            return res.status(400).json({ message: 'Please upload a payment proof' });
        }

        const proofUrl = req.file.path;
        const fileType = req.file.mimetype;
        const paymentAmount = Number(amount);

        const partner = await Partner.findById(req.partner._id);
        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        partner.walletBalance = (partner.walletBalance || 0) + paymentAmount;
        await partner.save();

        await Transaction.create({
            partnerId: partner._id,
            walletOwnerId: partner._id,
            walletOwnerType: 'Partner',
            amount: paymentAmount,
            type: 'credit',
            description: `Wallet Recharge (Pending Verification): ${orderId}`,
            referenceId: orderId,
            status: 'success',
            balanceAfter: partner.walletBalance,
            performedBy: partner._id,
            performedByModel: 'Partner'
        });

        await PaymentRequest.create({
            partnerId: partner._id,
            walletOwnerId: partner._id,
            walletOwnerType: 'Partner',
            orderId,
            amount: paymentAmount,
            transactionId,
            paymentDate,
            proofUrl,
            fileType,
            remarks,
            paymentMode,
            senderBankName,
            senderAccountName,
            status: 'Review'
        });

        res.status(201).json({ message: 'Recharge request submitted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const submitPartnerSupport = async (req, res) => {
    try {
        const { customerId, subject, description } = req.body;
        
        if (!subject || !description) {
            return res.status(400).json({ message: 'Subject and description are required.' });
        }

        let customerDetails = 'N/A';
        if (customerId) {
            const customer = await User.findOne({ _id: customerId, partnerId: req.partner._id });
            if (customer) {
                customerDetails = `${customer.name} (ID: ${customer.customerId || 'N/A'}, Email: ${customer.email})`;
            }
        }

        const partnerName = req.partner.displayName || req.partner.ownerName || 'Partner';
        const partnerEmail = req.partner.email;
        const partnerCode = req.partner.partnerCode || 'N/A';

        const emailHtml = `
            <h2>New Support Ticket from Franchise / Partner:</h2>
            <p><strong>Partner Name:</strong> ${partnerName}</p>
            <p><strong>Partner Code:</strong> ${partnerCode}</p>
            <p><strong>Partner Email:</strong> ${partnerEmail}</p>
            <p><strong>Related Customer:</strong> ${customerDetails}</p>
            <hr>
            <p><strong>Subject:</strong> ${subject}</p>
            <p><strong>Description:</strong></p>
            <p>${description.replace(/\n/g, '<br>')}</p>
        `;

        await sendEmail({
            email: 'sahildhiman502@gmail.com',
            subject: `Franchise Support Request: ${subject}`,
            html: emailHtml
        });

        res.status(200).json({ message: 'Support ticket submitted successfully.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const submitCustomerKyc = async (req, res) => {
    try {
        const {
            customerId,
            accountType,
            documentType,
            documentNumber,
            panNumber,
            panName,
            panDob,
            companyDocType,
            companyAadhaarNumber,
            gstNumber,
            gstPaymentType,
            isCSBV,
            iecNumber,
            adCode,
            lutExpiry,
            bankName,
            bankAccountNumber,
            ifscCode,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            pincode
        } = req.body;
        
        if (!customerId) {
            return res.status(400).json({ success: false, message: 'Customer ID is required.' });
        }

        const partnerId = req?.partner?._id;
        if (!partnerId) {
            return res.status(401).json({ success: false, message: 'Partner authentication required.' });
        }

        let customer = null;
        if (typeof customerId === 'string' && customerId.match(/^[0-9a-fA-F]{24}$/)) {
            customer = await User.findOne({ _id: customerId, partnerId }).select('+password');
        }
        if (!customer) {
            customer = await User.findOne({ customerId, partnerId }).select('+password');
        }
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Customer not found or you do not have permission to modify this customer.' });
        }

        const getFirst = (val) => Array.isArray(val) ? val[val.length - 1] : val;

        const normAccountType = getFirst(accountType);
        const normDocType = getFirst(documentType);
        const normDocNum = getFirst(documentNumber);
        const normPanNumber = getFirst(panNumber);
        const normPanName = getFirst(panName);
        const normPanDob = getFirst(panDob);
        const normCompanyDocType = getFirst(companyDocType);
        const normCompanyAadhaarNumber = getFirst(companyAadhaarNumber);
        const normCompanyPanNumber = getFirst(req.body.companyPanNumber);
        const normCompanyPanName = getFirst(req.body.companyPanName);
        const normGstNumber = getFirst(gstNumber);
        const normGstPaymentType = getFirst(gstPaymentType);
        const normIsCSBV = getFirst(isCSBV);
        const normIecNumber = getFirst(iecNumber);
        const normAdCode = getFirst(adCode);
        const normLutExpiry = getFirst(lutExpiry);
        const normBankName = getFirst(bankName);
        const normBankAccountNumber = getFirst(bankAccountNumber);
        const normIfscCode = getFirst(ifscCode);
        const normAddressLine1 = getFirst(addressLine1);
        const normAddressLine2 = getFirst(addressLine2);
        const normCity = getFirst(city);
        const normState = getFirst(state);
        const normCountry = getFirst(country);
        const normPincode = getFirst(pincode);

        if (normAccountType) {
            customer.accountType = normAccountType;
        }

        const currentKyc = customer?.kycData?.toObject?.() || customer?.kycData || {};

        let parsedPanDob = undefined;
        if (normPanDob && normPanDob !== 'null' && normPanDob !== 'undefined' && normPanDob !== '') {
            parsedPanDob = new Date(normPanDob);
        } else if (normPanDob === '' || normPanDob === null) {
            parsedPanDob = null;
        }

        const normBusinessType = getFirst(req.body.businessType) || currentKyc?.businessType || 'proprietorship';
        const normIsCSB4 = getFirst(req.body.isCSB4);
        const normIsCSB5 = getFirst(req.body.isCSB5);

        const kycData = {
            ...currentKyc,
            businessType: normBusinessType,
            isCSB4: normIsCSB4 !== undefined ? (normIsCSB4 === 'true' || normIsCSB4 === true) : (currentKyc?.isCSB4 || false),
            isCSB5: normIsCSB5 !== undefined ? (normIsCSB5 === 'true' || normIsCSB5 === true) : (currentKyc?.isCSB5 || false),
            documentType: normDocType || currentKyc?.documentType,
            documentNumber: normDocNum || currentKyc?.documentNumber,
            panNumber: normPanNumber !== undefined ? normPanNumber : currentKyc?.panNumber,
            panName: normPanName !== undefined ? normPanName : currentKyc?.panName,
            companyPanNumber: normCompanyPanNumber !== undefined ? normCompanyPanNumber : currentKyc?.companyPanNumber,
            companyPanName: normCompanyPanName !== undefined ? normCompanyPanName : currentKyc?.companyPanName,
            companyDocType: normCompanyDocType !== undefined ? normCompanyDocType : currentKyc?.companyDocType,
            companyAadhaarNumber: normCompanyAadhaarNumber !== undefined ? normCompanyAadhaarNumber : currentKyc?.companyAadhaarNumber,
            gstNumber: normGstNumber !== undefined ? normGstNumber : currentKyc?.gstNumber,
            gstPaymentType: normGstPaymentType || currentKyc?.gstPaymentType || 'lut',
            isCSBV: normIsCSBV !== undefined ? (normIsCSBV === 'true' || normIsCSBV === true) : (normIsCSB5 === 'true' || normIsCSB5 === true || currentKyc?.isCSBV),
            iecNumber: normIecNumber !== undefined ? normIecNumber : currentKyc?.iecNumber,
            adCode: normAdCode !== undefined ? normAdCode : currentKyc?.adCode,
            lutExpiry: normLutExpiry !== undefined ? normLutExpiry : currentKyc?.lutExpiry,
            bankName: normBankName !== undefined ? normBankName : currentKyc?.bankName,
            bankAccountNumber: normBankAccountNumber !== undefined ? normBankAccountNumber : currentKyc?.bankAccountNumber,
            ifscCode: normIfscCode !== undefined ? normIfscCode : currentKyc?.ifscCode,
            billingAddress: {
                addressLine1: normAddressLine1 || currentKyc?.billingAddress?.addressLine1 || '',
                addressLine2: normAddressLine2 || currentKyc?.billingAddress?.addressLine2 || '',
                city: normCity || currentKyc?.billingAddress?.city || '',
                state: normState || currentKyc?.billingAddress?.state || '',
                country: normCountry || currentKyc?.billingAddress?.country || '',
                pincode: normPincode || currentKyc?.billingAddress?.pincode || ''
            },
            status: (req.body.primaryApprove === 'true' || req.body.primaryApprove === true) ? 'primary_approved' : 'pending',
            kycSubmittedAt: new Date(),
            canBookShipment: (req.body.primaryApprove === 'true' || req.body.primaryApprove === true) || currentKyc?.canBookShipment || false
        };

        if (parsedPanDob !== undefined) {
            kycData.panDob = parsedPanDob;
        }

        if (req.body.primaryApprove === 'true' || req.body.primaryApprove === true) {
            kycData.primaryApproval = {
                isApproved: true,
                approvedBy: req.partner._id,
                approvedByPartnerCode: req.partner.partnerCode,
                approvedAt: new Date(),
                remarks: 'Counter verification completed by Franchise Partner.'
            };
        }

        if (currentKyc?.documentStatuses) {
            kycData.documentStatuses = currentKyc.documentStatuses;
        }
        if (currentKyc?.gstPanMismatchDetails) {
            kycData.gstPanMismatchDetails = currentKyc.gstPanMismatchDetails;
        }

        if (req?.files) {
            // Personal / Common
            if (req.files?.aadharFrontImage?.[0]?.path) kycData.aadharFrontImage = req.files.aadharFrontImage[0].path;
            if (req.files?.aadharBackImage?.[0]?.path) kycData.aadharBackImage = req.files.aadharBackImage[0].path;
            if (req.files?.panCardImage?.[0]?.path) kycData.panCardImage = req.files.panCardImage[0].path;
            if (req.files?.companyPanCardImage?.[0]?.path || req.files?.companyPanFile?.[0]?.path) {
                kycData.companyPanCardImage = req.files.companyPanCardImage?.[0]?.path || req.files.companyPanFile?.[0]?.path;
            }
            if (req.files?.certificateImage?.[0]?.path) kycData.certificateImage = req.files.certificateImage[0].path;
            if (req.files?.partnershipDeedFile?.[0]?.path) kycData.partnershipDeedFile = req.files.partnershipDeedFile[0].path;
            if (req.files?.coiFile?.[0]?.path) kycData.coiFile = req.files.coiFile[0].path;
            if (req.files?.signatureImage?.[0]?.path) kycData.signatureImage = req.files.signatureImage[0].path;
            if (req.files?.photoImage?.[0]?.path) kycData.photoImage = req.files.photoImage[0].path;

            if (req.files?.companyAadhaarFrontImage?.[0]?.path) kycData.companyAadhaarFrontImage = req.files.companyAadhaarFrontImage[0].path;
            if (req.files?.companyAadhaarBackImage?.[0]?.path) kycData.companyAadhaarBackImage = req.files.companyAadhaarBackImage[0].path;

            // Business
            if (req.files?.gstFile?.[0]?.path) kycData.gstFile = req.files.gstFile[0].path;
            if (req.files?.iecFile?.[0]?.path) kycData.iecFile = req.files.iecFile[0].path;
            if (req.files?.adCodeFile?.[0]?.path) kycData.adCodeFile = req.files.adCodeFile[0].path;
            if (req.files?.lutFile?.[0]?.path) kycData.lutFile = req.files.lutFile[0].path;
        }

        customer.kycData = kycData;
        customer.kycVerified = false;

        customer.markModified('kycData');
        await customer.save();

        console.log(`[PartnerPortal] Customer KYC submitted. Status: ${kycData.status}, CanBook: ${kycData.canBookShipment}`);

        await logActivity(req, {
            action: 'PARTNER_SUBMIT_CUSTOMER_KYC',
            target: customer?._id?.toString?.() || customer?._id,
            targetModel: 'User',
            details: {
                customerId: customer?.customerId,
                documentType: kycData?.documentType,
                status: kycData?.status
            },
            actor: req?.partner?.toObject ? { ...req.partner.toObject(), role: 'partner' } : { ...req?.partner, role: 'partner' }
        });

        res.status(200).json({
            success: true,
            message: 'Customer KYC submitted successfully',
            kycStatus: kycData.status,
            kycData: customer.kycData,
            canBookShipment: kycData.canBookShipment
        });

    } catch (error) {
        console.error('[PartnerPortal] Error in submitCustomerKyc:', error);
        res.status(error?.statusCode || error?.status || 500).json({
            success: false,
            message: error?.message || 'Failed to submit Customer KYC'
        });
    }
};

const approveCustomerPrimaryKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const { remarks } = req.body;

        console.log(`[PartnerPortal] Primary KYC Approval requested for Customer ID: ${id} by Partner: ${req.partner.partnerCode}`);

        const customer = await User.findOne({ _id: id, partnerId: req.partner._id });
        if (!customer) {
            console.warn(`[PartnerPortal] Customer ${id} not found or unauthorized for partner ${req.partner._id}`);
            return res.status(404).json({ message: 'Customer not found or unauthorized.' });
        }

        customer.kycData = customer.kycData || {};
        customer.kycData.status = 'primary_approved';
        customer.kycData.canBookShipment = true;
        customer.kycData.primaryApproval = {
            isApproved: true,
            approvedBy: req.partner._id,
            approvedByPartnerCode: req.partner.partnerCode,
            approvedAt: new Date(),
            remarks: remarks || 'Counter verified by Franchise Partner.'
        };

        await customer.save();

        console.log(`[PartnerPortal] Customer ${customer.customerId || customer._id} Primary Approved. Booking enabled.`);

        await logActivity(req, {
            action: 'PARTNER_PRIMARY_APPROVE_CUSTOMER_KYC',
            target: customer._id.toString(),
            targetModel: 'User',
            details: {
                customerId: customer.customerId,
                status: 'primary_approved',
                partnerCode: req.partner.partnerCode
            },
            actor: { ...req.partner.toObject(), role: 'partner' }
        });

        res.status(200).json({
            success: true,
            message: 'Customer KYC Primary Approved successfully. Booking is now enabled!',
            customer
        });
    } catch (error) {
        console.error('[PartnerPortal] Error in approveCustomerPrimaryKyc:', error);
        res.status(500).json({ message: 'Failed to approve customer primary KYC', error: error.message });
    }
};

const uploadAdditionalCustomerKycDocs = async (req, res) => {
    try {
        const { id } = req.params;
        const { docName, notes } = req.body;

        console.log(`[PartnerPortal] Additional docs upload for Customer ID: ${id} by Partner: ${req.partner.partnerCode}`);

        const customer = await User.findOne({ _id: id, partnerId: req.partner._id });
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found or unauthorized.' });
        }

        let fileUrl = '';
        if (req.file) {
            fileUrl = req.file.path;
        } else if (req.files && req.files.additionalDoc) {
            fileUrl = req.files.additionalDoc[0].path;
        }

        customer.kycData = customer.kycData || {};
        customer.kycData.additionalDocuments = customer.kycData.additionalDocuments || [];

        if (fileUrl) {
            customer.kycData.additionalDocuments.push({
                docName: docName || 'Additional Document',
                fileUrl,
                uploadedBy: 'partner',
                uploadedAt: new Date(),
                notes: notes || ''
            });
        }

        // Keep booking enabled and reset status to primary_approved for HO review
        customer.kycData.canBookShipment = true;
        customer.kycData.status = 'primary_approved';

        await customer.save();

        console.log(`[PartnerPortal] Additional doc uploaded for customer ${customer.customerId}. Status: primary_approved.`);

        await logActivity(req, {
            action: 'PARTNER_UPLOAD_ADDITIONAL_CUSTOMER_KYC_DOCS',
            target: customer._id.toString(),
            targetModel: 'User',
            details: {
                customerId: customer.customerId,
                docName
            },
            actor: { ...req.partner.toObject(), role: 'partner' }
        });

        res.status(200).json({
            success: true,
            message: 'Additional document uploaded successfully.',
            customer
        });
    } catch (error) {
        console.error('[PartnerPortal] Error in uploadAdditionalCustomerKycDocs:', error);
        res.status(500).json({ message: 'Failed to upload additional documents', error: error.message });
    }
};

const getPartnerPaymentHistory = async (req, res) => {
    try {
        const { page = 1, limit = 10, source, status } = req.query;
        const skip = (page - 1) * Number(limit);

        const query = {
            partnerId: req.partner._id
        };

        if (source) {
            query.source = source;
        }

        if (status) {
            query.status = status;
        }

        const [payments, total] = await Promise.all([
            PaymentRequest.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            PaymentRequest.countDocuments(query)
        ]);

        res.json({
            payments,
            totalPages: Math.ceil(total / Number(limit)),
            currentPage: Number(page),
            totalItems: total
        });
    } catch (error) {
        res.status(500).json({ message: error.message || "Internal Server Error" });
    }
};

const confirmPartnerKyc = async (req, res) => {
    try {
        const partner = await Partner.findById(req.partner._id);
        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        if (!partner.kycData) {
            partner.kycData = {};
        }

        partner.kycData.partnerConfirmed = true;
        partner.kycData.partnerConfirmedAt = new Date();
        partner.kycData.partnerConfirmedBy = req.partner._id;
        partner.kycStatus = 'verified';
        partner.kycVerified = true;
        partner.kycData.identityVerified = true;
        partner.kycData.panVerified = true;
        if (partner.kycData.gstNumber || partner.kycData.gstFile) {
            partner.kycData.documentsVerified = true;
        }
        partner.markModified('kycData');
        
        await partner.save();

        await logActivity(req, {
            action: 'PARTNER_CONFIRM_KYC',
            target: partner._id.toString(),
            targetModel: 'Partner',
            details: {
                partnerCode: partner.partnerCode,
                companyName: partner.companyName
            },
            actor: { ...req.partner.toObject(), role: 'partner' }
        });

        res.status(200).json({
            success: true,
            message: 'KYC documents confirmed and verified successfully.',
            partner
        });
    } catch (error) {
        console.error('Error in confirmPartnerKyc:', error);
        res.status(500).json({ message: error.message || 'Failed to confirm KYC documents' });
    }
};

module.exports = {
    createPartnerCustomer,
    getPartnerCustomers,
    getPartnerDashboard,
    getPartnerWallet,
    getPartnerPaymentHistory,
    requestPartnerWalletRecharge,
    submitPartnerSupport,
    submitCustomerKyc,
    approveCustomerPrimaryKyc,
    uploadAdditionalCustomerKycDocs,
    confirmPartnerKyc,
    // Exported for reward calculation unit testing and verification
    buildPartnerRewardSummary,
    calculateShipmentWeight,
    resolveMonthlySlab,
    getNextMonthlySlab,
    DEFAULT_REWARD_SETTINGS
};
