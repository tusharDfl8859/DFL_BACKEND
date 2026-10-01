const mongoose = require('mongoose');
const DraftShipment = require('../models/DraftShipment');

// @desc    Create or Update a draft
// @route   POST /api/drafts
// @access  Private
const createDraft = async (req, res) => {
    try {
        const { shipperDetails, consigneeDetails, shipmentDetails, savedRate, userId, isConcierge, draftId } = req.body;

        // If admin is saving a draft for a user, they must provide a userId
        const targetUserId = (req.user.isAdmin && userId) ? userId : req.user._id;

        if (!targetUserId) {
            return res.status(400).json({ message: 'User context is required for saving drafts' });
        }

        let draft;
        if (draftId && mongoose.Types.ObjectId.isValid(draftId)) {
            // Update existing draft
            draft = await DraftShipment.findById(draftId);
            if (draft) {
                // Verify ownership or admin status
                if (draft.user.toString() !== req.user._id.toString() && !req.user.isAdmin) {
                    return res.status(403).json({ message: 'Not authorized to update this draft' });
                }
                
                draft.shipperDetails = shipperDetails;
                draft.consigneeDetails = consigneeDetails;
                draft.shipmentDetails = shipmentDetails;
                draft.savedRate = savedRate;
                draft.isConcierge = isConcierge ?? draft.isConcierge;
                await draft.save();
            } else {
                // ID provided but not found, create new
                draft = await DraftShipment.create({
                    user: targetUserId,
                    shipperDetails,
                    consigneeDetails,
                    shipmentDetails,
                    savedRate,
                    isConcierge: isConcierge ?? false
                });
            }
        } else {
            // Create new draft
            draft = await DraftShipment.create({
                user: targetUserId,
                shipperDetails,
                consigneeDetails,
                shipmentDetails,
                savedRate,
                isConcierge: isConcierge ?? false
            });
        }

        res.status(201).json(draft);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get user drafts
// @route   GET /api/drafts
// @access  Private
const getDrafts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const baseQuery = {
            user: req.user._id,
            $or: [{ partner: null }, { partner: { $exists: false } }]
        };

        const count = await DraftShipment.countDocuments(baseQuery);
        const drafts = await DraftShipment.find(baseQuery)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            drafts,
            currentPage: page,
            totalPages: Math.ceil(count / limit),
            totalDrafts: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get single draft
// @route   GET /api/drafts/:id
// @access  Private
const getDraftById = async (req, res) => {
    try {
        const draft = await DraftShipment.findById(req.params.id).populate('user');

        if (draft && !draft.partner && (draft.user?._id?.toString() === req.user._id.toString() || req.user.isAdmin)) {
            res.json(draft);
        } else {
            res.status(404).json({ message: 'Draft not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete draft
// @route   DELETE /api/drafts/:id
// @access  Private
const deleteDraft = async (req, res) => {
    try {
        const draft = await DraftShipment.findById(req.params.id);

        if (draft && !draft.partner && (draft.user?.toString() === req.user._id.toString() || req.user.isAdmin)) {
            await draft.deleteOne();
            res.json({ message: 'Draft removed' });
        } else {
            res.status(404).json({ message: 'Draft not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get all concierge drafts for admin
// @route   GET /api/drafts/concierge
// @access  Private Admin
const getConciergeDrafts = async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(401).json({ message: 'Not authorized as admin' });
        }
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const skip = (page - 1) * limit;
        const search = req.query.search || '';
        const nonPartnerCondition = {
            $or: [
                { partner: null },
                { partner: { $exists: false } }
            ]
        };
        let query = { ...nonPartnerCondition };

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            const User = require('../models/User');

            // Look up matching users
            const users = await User.find({
                $or: [
                    { name: searchRegex },
                    { email: searchRegex },
                    { customerId: searchRegex }
                ]
            }).select('_id');

            const userIds = users.map(u => u._id);

            // Match draft by user ID or by consignee name directly in DraftShipment
            query = {
                $and: [
                    nonPartnerCondition,
                    {
                        $or: [
                            { user: { $in: userIds } },
                            { 'consigneeDetails.consigneeName': searchRegex }
                        ]
                    }
                ]
            };
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
            totalPages: Math.ceil(count / limit),
            totalDrafts: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    createDraft,
    getDrafts,
    getDraftById,
    deleteDraft,
    getConciergeDrafts
};
