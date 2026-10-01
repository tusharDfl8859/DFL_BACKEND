const Shipment = require('../../models/Shipment');
const { generateShippingLabel } = require('../../utils/labelGenerator');

/**
 * @desc    Generate and download DFL own shipping label PDF
 * @route   GET /api/admin/shipments/:id/generate-label
 * @access  Private/Admin
 */
const generateLabel = async (req, res) => {
    try {
        const shipment = await Shipment.findById(req.params.id)
            .populate('user', 'name email companyName customerId');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        const pdfBuffer = await generateShippingLabel(shipment);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=DFL_Label_${shipment.shipmentId}.pdf`);
        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ message: 'Error generating label', error: error.message });
    }
};

module.exports = { generateLabel };
