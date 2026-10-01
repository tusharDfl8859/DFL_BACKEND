const mongoose = require('mongoose');
const Manifest = require('../../models/Manifest');
const Shipment = require('../../models/Shipment');
const manifestController = require('../../controllers/manifestController');
const bulkController = require('../../controllers/admin/bulkController');

jest.mock('../../models/Manifest');
jest.mock('../../models/Shipment');
jest.mock('../../utils/activityLogger', () => ({
    logActivity: jest.fn().mockResolvedValue(true)
}));

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.pipe = jest.fn().mockReturnValue(res);
    return res;
};

describe('Pickup Manifest Lifecycle, Open/Close State & Admin Label Tests', () => {
    const userId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    const manifestId = new mongoose.Types.ObjectId();
    const shipmentId1 = new mongoose.Types.ObjectId();
    const shipmentId2 = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('1. Manifest Creation (DFL Pickup & Self-Drop in OPEN State)', () => {
        test('should reject creation when pickupAddress is missing', async () => {
            const req = {
                user: { _id: userId },
                body: { pickupAddress: '' }
            };
            const res = buildMockRes();

            await manifestController.createManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/pickup address is required/i)
            }));
        });

        test('should create OPEN manifest with DFL Pickup for Delhi NCR address', async () => {
            const req = {
                user: { _id: userId },
                body: {
                    pickupAddress: 'Sector 62, Noida, Gautam Buddha Nagar, UP',
                    shipmentIds: []
                }
            };
            const res = buildMockRes();

            const mockSave = jest.fn().mockResolvedValue({
                _id: manifestId,
                manifestId: 'MAN-20260902-1234',
                user: userId,
                pickupAddress: 'Sector 62, Noida, Gautam Buddha Nagar, UP',
                pickupType: 'DFL Pickup',
                pickupBy: 'DFL Pickup',
                status: 'OPEN',
                shipments: [],
                populate: jest.fn().mockResolvedValue(this)
            });

            Manifest.mockImplementation(() => ({
                save: mockSave,
                populate: jest.fn().mockResolvedValue({
                    _id: manifestId,
                    status: 'OPEN',
                    pickupType: 'DFL Pickup'
                })
            }));

            await manifestController.createManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(201);
        });

        test('determineDefaultPickupMode correctly detects DFL pickup cities', () => {
            const ncrResult = manifestController.determineDefaultPickupMode('C-20, Sector 18, Gurgaon, Haryana');
            expect(ncrResult.pickupType).toBe('DFL Pickup');

            const jaipurResult = manifestController.determineDefaultPickupMode('Malviya Nagar, Jaipur, Rajasthan');
            expect(jaipurResult.pickupType).toBe('DFL Pickup');

            const nonDflResult = manifestController.determineDefaultPickupMode('MG Road, Bengaluru, Karnataka');
            expect(nonDflResult.pickupType).toBe('3rd Party Pickup');
        });
    });

    describe('2. Order Attachment & Limit Enforcement (Open State)', () => {
        test('should add available orders and recalculate manifest totals', async () => {
            const existingManifest = {
                _id: manifestId,
                user: userId,
                status: 'OPEN',
                shipments: [],
                manifestValue: '0.00',
                save: jest.fn().mockResolvedValue(true),
                populate: jest.fn().mockResolvedValue(true)
            };

            const mockShipment = {
                _id: shipmentId1,
                user: userId,
                serviceDetails: { price: '1500.00' },
                shipmentDetails: { noOfBoxes: 2, boxes: [{ weight: 3 }, { weight: 2 }] }
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(existingManifest)
            });
            Shipment.find.mockResolvedValue([mockShipment]);
            Shipment.updateMany.mockResolvedValue({ modifiedCount: 1 });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId },
                body: { shipmentIds: [shipmentId1.toString()] }
            };
            const res = buildMockRes();

            await manifestController.addOrdersToManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(existingManifest.save).toHaveBeenCalled();
            expect(existingManifest.totalOrders).toBe(1);
            expect(existingManifest.packetCount).toBe(2);
            expect(existingManifest.totalWeight).toBe(5);
        });

        test('should reject adding orders if manifest is already CLOSED', async () => {
            const closedManifest = {
                _id: manifestId,
                user: userId,
                status: 'CLOSED',
                shipments: []
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(closedManifest)
            });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId },
                body: { shipmentIds: [shipmentId1.toString()] }
            };
            const res = buildMockRes();

            await manifestController.addOrdersToManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/cannot add orders.*closed/i)
            }));
        });

        test('should reject adding orders that exceed ₹50,000 maximum value limit', async () => {
            const openManifest = {
                _id: manifestId,
                user: userId,
                status: 'OPEN',
                shipments: [],
                manifestValue: '40000.00'
            };

            const expensiveShipment = {
                _id: shipmentId1,
                user: userId,
                serviceDetails: { price: '55000.00' },
                shipmentDetails: {}
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(openManifest)
            });
            Shipment.find.mockResolvedValue([expensiveShipment]);

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId },
                body: { shipmentIds: [shipmentId1.toString()] }
            };
            const res = buildMockRes();

            await manifestController.addOrdersToManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/cannot exceed ₹50,000/i)
            }));
        });
    });

    describe('3. Manifest Close Lifecycle (OPEN -> CLOSED)', () => {
        test('should close an OPEN manifest successfully and timestamp closedAt', async () => {
            const openManifest = {
                _id: manifestId,
                user: userId,
                status: 'OPEN',
                shipments: [
                    { _id: shipmentId1, serviceDetails: { price: '2000' }, shipmentDetails: { noOfBoxes: 1, boxes: [{ weight: 2 }] } }
                ],
                save: jest.fn().mockResolvedValue(true),
                populate: jest.fn().mockResolvedValue(true)
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(openManifest)
            });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId }
            };
            const res = buildMockRes();

            await manifestController.closeManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(openManifest.status).toBe('CLOSED');
            expect(openManifest.closedAt).toBeInstanceOf(Date);
            expect(openManifest.closedBy).toEqual(userId);
            expect(openManifest.save).toHaveBeenCalled();
        });

        test('should reject closing an already CLOSED or BOOKED manifest', async () => {
            const alreadyClosed = {
                _id: manifestId,
                user: userId,
                status: 'CLOSED',
                shipments: []
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(alreadyClosed)
            });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId }
            };
            const res = buildMockRes();

            await manifestController.closeManifest(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/already closed/i)
            }));
        });
    });

    describe('4. Admin Manifest Visibility & Filters (getAllManifests)', () => {
        test('should allow admin to filter closed manifests and view complete list', async () => {
            const mockClosedManifests = [
                {
                    _id: manifestId,
                    manifestId: 'MAN-20260902-8888',
                    status: 'CLOSED',
                    pickupStatus: 'Pending',
                    pickupType: 'DFL Pickup',
                    totalOrders: 3,
                    packetCount: 5,
                    user: { name: 'Customer Test', email: 'cust@test.com' }
                }
            ];

            const mockQuery = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                skip: jest.fn().mockResolvedValue(mockClosedManifests)
            };

            Manifest.countDocuments.mockResolvedValue(1);
            Manifest.find.mockReturnValue(mockQuery);

            const req = {
                admin: { role: 'super_admin' },
                query: { status: 'CLOSED', page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await bulkController.getAllManifests(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                manifests: mockClosedManifests,
                totalPages: 1,
                currentPage: 1
            }));
            expect(Manifest.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'CLOSED' }));
        });
    });

    describe('5. Box Label PDF & Pickup Manifest Generation for User & Admin', () => {
        test('should block unauthorized user from downloading another customer box label (Customer Isolation)', async () => {
            const otherUserManifest = {
                _id: manifestId,
                user: { _id: otherUserId },
                status: 'CLOSED',
                shipments: []
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(otherUserManifest)
            });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId } // Logged in user is NOT owner and NOT admin
            };
            const res = buildMockRes();

            await manifestController.downloadBoxLabelPdf(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/access denied/i)
            }));
        });

        test('should stream 4x6 Box Label PDF for authorized user/admin when manifest is ready', async () => {
            const validManifest = {
                _id: manifestId,
                manifestId: 'MAN-20260902-9999',
                user: { _id: userId, name: 'John Doe', phone: '9876543210' },
                status: 'CLOSED',
                packetCount: 2,
                manifestValue: '3500.00',
                shipments: [
                    {
                        shipperDetails: { name: 'Sender', addressLine1: 'Noida' },
                        consigneeDetails: { name: 'Receiver' }
                    }
                ]
            };

            Manifest.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(validManifest)
            });

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId }
            };
            const res = buildMockRes();

            await manifestController.downloadBoxLabelPdf(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
            expect(res.setHeader).toHaveBeenCalledWith(
                'Content-Disposition',
                expect.stringContaining('DFL_Box_Label_MAN-20260902-9999.pdf')
            );
        });

        test('should return existing 3rd party manifest PDF labelUrl for user or admin', async () => {
            const manifestWithLabel = {
                _id: manifestId,
                user: { _id: userId },
                status: 'CLOSED',
                labelUrl: 'https://storage.thedflgroup.com/manifests/MAN-9999.pdf',
                awbNumber: 'AWB-123456789',
                pickupBy: 'Delhivery'
            };

            Manifest.findById.mockResolvedValue(manifestWithLabel);

            const req = {
                params: { id: manifestId.toString() },
                user: { _id: userId }
            };
            const res = buildMockRes();

            await manifestController.download3rdPartyManifestPdf(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                manifestUrl: 'https://storage.thedflgroup.com/manifests/MAN-9999.pdf',
                awbNumber: 'AWB-123456789',
                pickupBy: 'Delhivery'
            }));
        });
    });
});
