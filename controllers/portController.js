const portService = require('../services/portService');

// @desc    Search world ports fast (in-memory)
// @route   GET /api/ports/search?q=XYZ
// @access  Protected (Admin/Member)
const searchPorts = (req, res) => {
    try {
        const query = req.query.q || '';
        const limitStr = req.query.limit || '20';
        const limit = parseInt(limitStr, 10) || 20;
        // This call takes <1ms and operates synchronously entirely in RAM
        const results = portService.searchPorts(query, limit);
        res.json({
            count: results.length,
            results: results
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error processing port search' });
    }
};

module.exports = {
    searchPorts
};
