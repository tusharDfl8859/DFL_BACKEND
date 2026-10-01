const express = require('express');
const router = express.Router();
const { getFinanceSummary, getCustomerFinanceDetails, getAllShipmentsFinance, exportFinanceData } = require('../../controllers/admin/financeController');
const { sendFinanceOtp, verifyFinanceOtp } = require('../../controllers/admin/authController');
const { protectAdmin, authorize, protectFinanceAccess, checkPermission } = require('../../middleware/adminMiddleware');

// Restricted to Super Admin and Admin (Accounts/Finance)
router.use(protectAdmin);
router.use(authorize('super_admin', 'admin'));
router.use(protectFinanceAccess);

router.get('/summary', getFinanceSummary);
router.get('/all-shipments', getAllShipmentsFinance);
router.get('/customer/:userId', getCustomerFinanceDetails);
router.get('/export', checkPermission('data:export', 'finance:export'), exportFinanceData);

// OTP Verification Routes
router.post('/otp', sendFinanceOtp);
router.post('/verify-otp', verifyFinanceOtp);

router.use(protectFinanceAccess);
router.get('/summary', getFinanceSummary);
router.get('/all-shipments', getAllShipmentsFinance);
router.get('/customer/:userId', getCustomerFinanceDetails);
router.get('/export', exportFinanceData);

module.exports = router;
