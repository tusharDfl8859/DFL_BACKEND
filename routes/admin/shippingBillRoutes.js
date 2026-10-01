const express = require('express');
const router = express.Router();
const { protectAdmin, checkPermission } = require('../../middleware/adminMiddleware');
const shippingBillUpload = require('../../middleware/shippingBillUploadMiddleware');
const controller = require('../../controllers/admin/shippingBillController');

router.use(protectAdmin);
router.use(checkPermission('shipping_bill:manage'));

router.get('/', controller.getAdminCSBVShipments);
router.post('/upload', shippingBillUpload.single('file'), controller.uploadShippingBill);
router.delete('/:id', controller.deleteShippingBill);

module.exports = router;
