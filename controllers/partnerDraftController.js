const mongoose = require('mongoose');
const DraftShipment = require('../models/DraftShipment');

// @desc    Create or update a draft for the logged-in partner
// @route   POST /api/partners/drafts
// @access  Private (Partner)
const createPartnerDraft = async (req, res) => {
    try {
        if (!req.partner || !req.partner._id) {
            return res.status(401).json({ message: 'Not authorized as partner' });
        }

        const {
            shipperDetails,
            consigneeDetails,
            shipmentDetails,
            savedRate,
            customerType,
            userId,
            partnerMargin,
            draftId
        } = req.body;

        let draft;
        if (draftId && mongoose.Types.ObjectId.isValid(draftId)) {
            draft = await DraftShipment.findById(draftId);
            if (draft) {
                // Ensure the draft belongs exclusively to this partner
                if (!draft.partner || draft.partner.toString() !== req.partner._id.toString()) {
                    return res.status(403).json({ message: 'Not authorized to update this draft' });
                }

                draft.shipperDetails = shipperDetails ?? draft.shipperDetails;
                draft.consigneeDetails = consigneeDetails ?? draft.consigneeDetails;
                draft.shipmentDetails = shipmentDetails ?? draft.shipmentDetails;
                draft.savedRate = savedRate ?? draft.savedRate;
                draft.customerType = customerType ?? draft.customerType;
                if (userId) draft.user = userId;
                if (partnerMargin !== undefined) draft.partnerMargin = Number(partnerMargin) || 0;

                await draft.save();
                return res.status(200).json(draft);
            }
        }

        // Create a new partner-isolated draft
        draft = await DraftShipment.create({
            partner: req.partner._id,
            user: userId && mongoose.Types.ObjectId.isValid(userId) ? userId : null,
            customerType: customerType || null,
            partnerMargin: partnerMargin ? Number(partnerMargin) || 0 : 0,
            shipperDetails,
            consigneeDetails,
            shipmentDetails,
            savedRate,
            isConcierge: false,
            bookingSource: 'PARTNER_PORTAL'
        });

        res.status(201).json(draft);
    } catch (error) {
        console.error('[PartnerDraft] createPartnerDraft error:', error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get drafts exclusively for the logged-in partner
// @route   GET /api/partners/drafts
// @access  Private (Partner)
const getPartnerDrafts = async (req, res) => {
    try {
        if (!req.partner || !req.partner._id) {
            return res.status(401).json({ message: 'Not authorized as partner' });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, parseInt(req.query.limit) || 10);
        const skip = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        const query = {
            partner: req.partner._id
        };

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { 'consigneeDetails.consigneeName': searchRegex },
                { 'shipperDetails.shipperName': searchRegex },
                { 'consigneeDetails.companyName': searchRegex }
            ];
        }

        const count = await DraftShipment.countDocuments(query);
        const drafts = await DraftShipment.find(query)
            .populate('user', 'name email customerId')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            drafts,
            currentPage: page,
            totalPages: Math.ceil(count / limit) || 1,
            totalDrafts: count
        });
    } catch (error) {
        console.error('[PartnerDraft] getPartnerDrafts error:', error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get a single partner draft by ID
// @route   GET /api/partners/drafts/:id
// @access  Private (Partner)
const getPartnerDraftById = async (req, res) => {
    try {
        if (!req.partner || !req.partner._id) {
            return res.status(401).json({ message: 'Not authorized as partner' });
        }

        const draft = await DraftShipment.findById(req.params.id).populate('user', 'name email customerId');

        if (draft && draft.partner && draft.partner.toString() === req.partner._id.toString()) {
            res.json(draft);
        } else {
            res.status(404).json({ message: 'Draft not found' });
        }
    } catch (error) {
        console.error('[PartnerDraft] getPartnerDraftById error:', error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete a partner draft
// @route   DELETE /api/partners/drafts/:id
// @access  Private (Partner)
const deletePartnerDraft = async (req, res) => {
    try {
        if (!req.partner || !req.partner._id) {
            return res.status(401).json({ message: 'Not authorized as partner' });
        }

        const draft = await DraftShipment.findById(req.params.id);

        if (draft && draft.partner && draft.partner.toString() === req.partner._id.toString()) {
            await draft.deleteOne();
            res.json({ message: 'Draft removed' });
        } else {
            res.status(404).json({ message: 'Draft not found' });
        }
    } catch (error) {
        console.error('[PartnerDraft] deletePartnerDraft error:', error);
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    createPartnerDraft,
    getPartnerDrafts,
    getPartnerDraftById,
    deletePartnerDraft
};
