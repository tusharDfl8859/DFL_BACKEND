const express = require('express');
const router = express.Router();
const {
    getRecipients,
    createRecipient,
    toggleRecipientStatus,
    deleteRecipient,
    triggerPickupReportManually
} = require('../controllers/reportRecipientController');
const { protectAdmin, checkPermission } = require('../middleware/adminMiddleware');

// All recipient management routes require Admin auth + 'pickup_reports:manage' permission (super_admin bypasses automatically)
router.use(protectAdmin);
router.use(checkPermission('pickup_reports:manage', 'reports:daily'));

router.route('/')
    .get(getRecipients)
    .post(createRecipient);

router.route('/trigger-now')
    .post(triggerPickupReportManually);

router.route('/:id/toggle')
    .patch(toggleRecipientStatus);

router.route('/:id')
    .delete(deleteRecipient);

module.exports = router;
