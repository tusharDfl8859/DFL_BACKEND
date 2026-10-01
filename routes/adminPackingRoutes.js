const express = require('express');
const router = express.Router();
const { protectAdmin, authorize } = require('../middleware/adminMiddleware');
const controller = require('../controllers/admin/packingController');

router.use(protectAdmin);

router.get('/carriers', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.listCarriers);
router.get('/box-configs', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.listBoxConfigs);
router.post('/box-configs', authorize('super_admin', 'admin'), controller.createBoxConfigHandler);

router.get('/boxes', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.listPackingBoxes);
router.post('/boxes', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.createPackingBoxHandler);
router.get('/boxes/:id', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.getPackingBoxById);
router.get('/boxes/:id/shipments', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.getPackingBoxShipments);
router.get('/boxes/:id/download', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.downloadPackingBoxData);
router.post('/boxes/:id/scan', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.scanShipmentIntoBox);
router.delete('/boxes/:id/shipments/:shipmentId', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.deleteShipmentFromBox);
router.post('/boxes/:id/mark-full', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.markBoxFullHandler);
router.post('/boxes/:id/reopen', authorize('super_admin', 'admin'), controller.reopenBoxHandler);
router.post('/boxes/:id/seal', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.sealBoxHandler);
router.post('/boxes/:id/dispatch', authorize('super_admin', 'admin', 'operation', 'sales_manager'), controller.dispatchBoxHandler);

module.exports = router;
