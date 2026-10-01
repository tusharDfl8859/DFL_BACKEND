/**
 * Envia Controller
 * Handles HTTP requests for Envia 3rd-party pickup and manifest operations.
 */

const { enviaPickupService } = require('../../services/envia');
const Manifest = require('../../models/Manifest');

const getAuthenticatedUserId = (req) => {
    return req.user?._id || req.user?.id || req.admin?._id || null;
};

const isAdminRequester = (req) => {
    if (req.admin) return true;
    if (req.user?.isAdmin) return true;
    const role = (req.user?.role || '').toLowerCase();
    return ['admin', 'super_admin', 'operation', 'sales_manager', 'sales_executive', 'member'].includes(role) || req.user?.role === 'Admin';
};

/**
 * Generate 3rd-party pickup booking & manifest via Envia
 * POST /api/envia/manifests/:id/generate-pickup
 */
exports.generate3rdPartyPickupManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const { carrier } = req.body || {};
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({
                success: false,
                message: 'Manifest not found'
            });
        }

        const manifestUserId = manifest.user?._id ? manifest.user._id.toString() : manifest.user.toString();
        if (manifestUserId !== userId?.toString() && !isAdminRequester(req)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only generate manifests for your own account.'
            });
        }

        const result = await enviaPickupService.create3rdPartyPickupManifest(id, req.user || req.admin, carrier);

        return res.status(200).json({
            success: true,
            message: '3rd-Party Pickup Manifest generated successfully via Envia',
            data: result
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || 'Failed to generate 3rd-party pickup manifest',
            details: error.details || null
        });
    }
};

/**
 * Get real-time rates from 3rd-party carriers
 * POST /api/envia/rates
 */
exports.get3rdPartyRates = async (req, res) => {
    try {
        const { origin, packages, carrier } = req.body || {};

        if (!origin || !origin.postalCode && !origin.pincode) {
            return res.status(400).json({
                success: false,
                message: 'Origin address with postalCode / pincode is required'
            });
        }

        const rates = await enviaPickupService.getRates({ origin, packages, carrier });

        return res.status(200).json({
            success: true,
            data: rates
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || 'Failed to retrieve 3rd-party rates',
            details: error.details || null
        });
    }
};

/**
 * Get available 3rd-party carriers in India
 * GET /api/envia/carriers
 */
exports.getAvailableCarriers = async (req, res) => {
    try {
        const carriers = await enviaPickupService.getAvailableCarriers();
        return res.status(200).json({
            success: true,
            data: carriers
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || 'Failed to fetch carriers',
            details: error.details || null
        });
    }
};

/**
 * Track a 3rd-party pickup or shipment
 * GET /api/envia/track/:trackingNumber
 */
exports.trackPickup = async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        if (!trackingNumber) {
            return res.status(400).json({
                success: false,
                message: 'Tracking number is required'
            });
        }

        const trackingData = await enviaPickupService.track(trackingNumber);

        return res.status(200).json({
            success: true,
            data: trackingData
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || 'Failed to retrieve tracking details',
            details: error.details || null
        });
    }
};
