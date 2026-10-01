const express = require('express');
const router = express.Router();
const { protectAdmin, authorize } = require('../middleware/adminMiddleware');
const controller = require('../controllers/admin/carrierRegistryController');

router.use(protectAdmin);

router.get('/', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.listCarriers);
router.post('/', authorize('super_admin'), controller.createCarrier);
router.put('/:id', authorize('super_admin'), controller.updateCarrier);
router.delete('/:id', authorize('super_admin'), controller.deleteCarrier);
router.post('/:id/emails', authorize('super_admin'), controller.addCarrierEmail);
router.delete('/:id/emails', authorize('super_admin'), controller.removeCarrierEmail);

module.exports = router;
