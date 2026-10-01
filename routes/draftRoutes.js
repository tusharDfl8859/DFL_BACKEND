const express = require('express');
const router = express.Router();
const {
    createDraft,
    getDrafts,
    getDraftById,
    deleteDraft,
    getConciergeDrafts
} = require('../controllers/draftController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
    .post(protect, createDraft)
    .get(protect, getDrafts);

router.route('/concierge')
    .get(protect, getConciergeDrafts);

router.route('/:id')
    .get(protect, getDraftById)
    .delete(protect, deleteDraft);

module.exports = router;
