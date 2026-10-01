jest.mock('../../models/Shipment', () => ({
    findByIdAndDelete: jest.fn(),
}));

jest.mock('../../models/User', () => ({}));
jest.mock('../../utils/activityLogger', () => ({}));
jest.mock('../../utils/dateUtils', () => ({}));
jest.mock('xlsx', () => ({}));
jest.mock('../../utils/cacheService', () => ({}));
jest.mock('archiver', () => ({}));
jest.mock('axios', () => ({}));
jest.mock('../../utils/pdfGenerator', () => ({}));
jest.mock('../../services/whatsappService', () => ({}));
jest.mock('../../utils/shipmentDelayCalculator', () => ({}));
jest.mock('mongoose', () => ({}));

const Shipment = require('../../models/Shipment');
const { deleteShipment } = require('../../controllers/admin/shipmentController');

describe('admin shipment deleteShipment', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('deletes a shipment by id and returns success', async () => {
        Shipment.findByIdAndDelete.mockResolvedValue({
            _id: 'shipment-db-id',
            shipmentId: 'DFL40573928',
        });

        const req = {
            params: {
                id: 'DFL40573928',
            },
        };
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await deleteShipment(req, res);

        expect(Shipment.findByIdAndDelete).toHaveBeenCalledWith('DFL40573928');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            message: 'Shipment deleted successfully',
            id: 'DFL40573928',
        });
    });

    it('returns 404 when shipment does not exist', async () => {
        Shipment.findByIdAndDelete.mockResolvedValue(null);

        const req = {
            params: {
                id: 'DFL00000000',
            },
        };
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await deleteShipment(req, res);

        expect(Shipment.findByIdAndDelete).toHaveBeenCalledWith('DFL00000000');
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            message: 'Shipment not found',
        });
    });
});
