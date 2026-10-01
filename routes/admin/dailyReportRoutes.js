const express = require('express');
const router = express.Router();
const { runDailyReportJob, generateDailyReportExcel } = require('../../workers/dailyReportWorker');
const { protect, admin } = require('../../middleware/authMiddleware');
const Shipment = require('../../models/Shipment');

// @route   POST /api/admin/reports/daily/trigger
// @desc    Manually run the daily report email job
// @access  Private/Admin
router.post('/trigger', protect, admin, async (req, res) => {
    try {
        const result = await runDailyReportJob();
        if (result.success) {
            return res.json({ success: true, message: `Daily report generated and sent successfully. Processed ${result.count} shipments.` });
        } else {
            return res.status(500).json({ success: false, message: result.error || 'Failed to trigger daily report.' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// @route   GET /api/admin/reports/daily/download
// @desc    Download the daily report Excel sheet directly
// @access  Private/Admin
router.get('/download', protect, admin, async (req, res) => {
    try {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC + 5:30
        const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
        const istNow = new Date(utcTime + istOffset);

        const istYesterday = new Date(istNow);
        istYesterday.setDate(istYesterday.getDate() - 1);

        const startOfYesterdayIST = new Date(istYesterday);
        startOfYesterdayIST.setHours(0, 0, 0, 0);
        const startOfYesterday = new Date(startOfYesterdayIST.getTime() - istOffset);

        const endOfYesterdayIST = new Date(istYesterday);
        endOfYesterdayIST.setHours(23, 59, 59, 999);
        const endOfYesterday = new Date(endOfYesterdayIST.getTime() - istOffset);

        const shipments = await Shipment.find({
            createdAt: { $gte: startOfYesterday, $lte: endOfYesterday }
        }).populate('user', 'name kycData').lean();

        const excelBuffer = generateDailyReportExcel(shipments);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Daily_Report_${Date.now()}.xlsx`);
        res.send(excelBuffer);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
