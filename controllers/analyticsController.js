const VisitLog = require('../models/VisitLog');

// @desc    Track a visit
// @route   POST /api/analytics/track
// @access  Public
const trackVisit = async (req, res) => {
    try {
        const { source, path, metaData } = req.body;
        
        // Get IP address
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        await VisitLog.create({
            ip,
            userAgent,
            source: source || 'direct',
            path: path || '/',
            metaData
        });

        res.status(200).json({ success: true });
    } catch (error) {
        // Don't block the client on error, just log it
        res.status(200).json({ success: false, error: 'Tracking failed' });
    }
};

module.exports = {
    trackVisit
};
