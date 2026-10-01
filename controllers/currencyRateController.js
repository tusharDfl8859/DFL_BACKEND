const currencyRateService = require('../services/currency/currencyRateService');
const { syncUsdInrCurrencyRate } = require('../jobs/currencyRateJob');

/**
 * @desc Get current USD to INR currency conversion status
 * @route GET /api/admin/currency-rates/USD-INR
 * @access Private/Admin
 */
exports.getUsdInrRate = async (req, res) => {
    try {
        const data = await currencyRateService.getCurrencyRateData();
        res.json({
            success: true,
            data
        });
    } catch (err) {
        console.error('[CurrencyRateController] Error fetching currency rate:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch currency rate configuration.' });
    }
};

/**
 * @desc Set manual USD -> INR exchange rate override
 * @route PATCH /api/admin/currency-rates/USD-INR/manual
 * @access Private/Admin
 */
exports.setManualOverrideRate = async (req, res) => {
    try {
        const { manualRate } = req.body;
        const parsedRate = parseFloat(manualRate);

        if (manualRate === undefined || manualRate === null || Number.isNaN(parsedRate)) {
            return res.status(400).json({ success: false, message: 'Manual rate is required and must be a valid number.' });
        }
        if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
            return res.status(400).json({ success: false, message: 'Manual rate must be a positive number.' });
        }
        if (parsedRate < 50 || parsedRate > 200) {
            return res.status(400).json({ success: false, message: 'Manual rate must be between ₹50 and ₹200 USD/INR.' });
        }

        const adminUserId = req.user ? req.user._id : null;
        const updatedData = await currencyRateService.setManualOverride(parsedRate, adminUserId);

        res.json({
            success: true,
            message: `Manual USD to INR exchange rate set to ₹${updatedData.manualRate}`,
            data: updatedData
        });
    } catch (err) {
        console.error('[CurrencyRateController] Error setting manual rate:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Failed to update manual exchange rate.' });
    }
};

/**
 * @desc Reset manual override and restore automatic market rate mode
 * @route POST /api/admin/currency-rates/USD-INR/use-auto
 * @access Private/Admin
 */
exports.useAutoRate = async (req, res) => {
    try {
        const adminUserId = req.user ? req.user._id : null;
        const updatedData = await currencyRateService.resetManualOverride(adminUserId);

        res.json({
            success: true,
            message: 'Manual override disabled. Restored automatic market exchange rate.',
            data: updatedData
        });
    } catch (err) {
        console.error('[CurrencyRateController] Error resetting manual rate:', err.message);
        res.status(500).json({ success: false, message: 'Failed to reset manual exchange rate.' });
    }
};

/**
 * @desc Force immediate live refresh of USD -> INR exchange rate
 * @route POST /api/admin/currency-rates/USD-INR/refresh
 * @access Private/Admin
 */
exports.refreshRateNow = async (req, res) => {
    try {
        const updatedData = await syncUsdInrCurrencyRate();
        res.json({
            success: true,
            message: 'Live USD to INR exchange rate refreshed successfully.',
            data: updatedData
        });
    } catch (err) {
        console.error('[CurrencyRateController] Error refreshing exchange rate:', err.message);
        res.status(500).json({ success: false, message: 'Failed to refresh live exchange rate.' });
    }
};

/**
 * @desc Toggle auto-update schedule on/off
 * @route PATCH /api/admin/currency-rates/USD-INR/auto-update
 * @access Private/Admin
 */
exports.toggleAutoUpdate = async (req, res) => {
    try {
        const { autoUpdateEnabled } = req.body;
        const adminUserId = req.user ? req.user._id : null;
        const updatedData = await currencyRateService.setAutoUpdateEnabled(autoUpdateEnabled, adminUserId);

        res.json({
            success: true,
            message: `Automatic USD to INR update ${autoUpdateEnabled ? 'enabled' : 'disabled'}.`,
            data: updatedData
        });
    } catch (err) {
        console.error('[CurrencyRateController] Error toggling auto update:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update auto-update setting.' });
    }
};
