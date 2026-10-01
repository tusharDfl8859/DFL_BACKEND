const { getEffectivePermissions, ROLE_PERMISSIONS } = require('../../utils/permissions');

jest.mock('../../config/cloudinaryConfig', () => ({
    cloudinary: {
        uploader: {
            upload_stream: jest.fn(),
            destroy: jest.fn().mockResolvedValue({ result: 'ok' })
        }
    },
    CloudinaryStorage: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../../utils/pdfGenerator', () => ({
    generateInvoicePDF: jest.fn().mockResolvedValue('https://res.cloudinary.com/dfl/raw/upload/invoices/inv_mock.pdf'),
    createInvoiceBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Mock Invoice Buffer')),
    generateDisputeInvoicePDF: jest.fn().mockResolvedValue('https://res.cloudinary.com/dfl/raw/upload/disputes/disp_mock.pdf'),
    createCommercialInvoiceBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Mock Commercial Buffer'))
}));

jest.mock('../../models/Shipment', () => ({
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));

jest.mock('../../models/User', () => ({
    find: jest.fn()
}));

jest.mock('../../models/Dispute', () => ({
    find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockResolvedValue([]),
        lean: jest.fn().mockResolvedValue([])
    })
}));

jest.mock('axios', () => ({
    get: jest.fn().mockResolvedValue({ data: Buffer.from('%PDF-1.4 Mock Axios Remote PDF') })
}));

const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const adminShippingBillController = require('../../controllers/admin/shippingBillController');
const documentController = require('../../controllers/documentController');
const { autoGenerateAndLockInvoice } = require('../../utils/invoiceAutoGenerator');
const { generateInvoicePDF, createInvoiceBuffer } = require('../../utils/pdfGenerator');
const { cloudinary } = require('../../config/cloudinaryConfig');
const axios = require('axios');

const buildRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.write = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    res.pipe = jest.fn().mockReturnValue(res);
    return res;
};

describe('Comprehensive Test Suite: Invoices, CSB-V Shipping Bills & Downloads', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // =========================================================================
    // 1. AUTOMATIC INVOICE GENERATION & TAX ENGINE TESTS (invoiceAutoGenerator)
    // =========================================================================
    describe('1. Automatic Invoice Generation & Tax Engine (Zero Zoho Dependency)', () => {
        it('should calculate 18% reverse inclusive GST and assign CGST+SGST for Uttar Pradesh (09) billing', async () => {
            const mockShipment = {
                _id: 'shipment-up-1',
                shipmentId: 'DFL1001',
                serviceDetails: { price: '₹1180.00', countrySurcharge: '100' },
                shipmentDetails: { gstPaymentType: 'regular' },
                shipperDetails: {
                    shipperName: 'Rahul Sharma',
                    companyName: 'Sharma Exports',
                    addressLine1: 'Sector 62',
                    city: 'Noida',
                    state: 'Uttar Pradesh',
                    country: 'India',
                    pincode: '201301',
                    mobileNo: '9876543210',
                    email: 'rahul@sharma.in'
                },
                user: {
                    name: 'Rahul Sharma',
                    kycData: { gstNumber: '09AAACH7409R1ZZ' }
                },
                markModified: jest.fn(),
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            const result = await autoGenerateAndLockInvoice('shipment-up-1');

            expect(result).not.toBeNull();
            expect(generateInvoicePDF).toHaveBeenCalledWith(
                expect.objectContaining({
                    invoiceId: 'INV-DFL1001',
                    totalAmount: 1180,
                    subtotal: 1000,
                    tax: expect.objectContaining({
                        type: 'CGST + SGST',
                        rate: 18,
                        amount: 180
                    }),
                    lineItems: expect.arrayContaining([
                        expect.objectContaining({ description: 'Shipping Charges', amount: 900 }),
                        expect.objectContaining({ description: 'Fuel/Country Surcharge', amount: 100 })
                    ]),
                    status: 'Generated'
                }),
                mockShipment
            );
            expect(mockShipment.invoice.status).toBe('Generated');
            expect(mockShipment.invoice.pdfUrl).toBe('https://res.cloudinary.com/dfl/raw/upload/invoices/inv_mock.pdf');
            expect(mockShipment.save).toHaveBeenCalled();
        });

        it('should calculate 18% reverse inclusive GST across standard shipments', async () => {
            const mockShipment = {
                _id: 'shipment-std-1',
                shipmentId: 'DFL83665602',
                serviceDetails: { price: '470.11', countrySurcharge: 0 },
                shipmentDetails: { gstPaymentType: 'regular' },
                shipperDetails: {
                    shipperName: 'Sahil Dhiman',
                    city: 'New Delhi',
                    state: 'Delhi',
                    country: 'India'
                },
                user: { name: 'Sahil Dhiman' },
                markModified: jest.fn(),
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            const result = await autoGenerateAndLockInvoice('shipment-std-1');

            expect(result).not.toBeNull();
            expect(generateInvoicePDF).toHaveBeenCalledWith(
                expect.objectContaining({
                    invoiceId: 'INV-DFL83665602',
                    totalAmount: 470.11,
                    subtotal: 398.40,
                    tax: expect.objectContaining({
                        type: 'IGST',
                        rate: 18,
                        amount: 71.71
                    }),
                    status: 'Generated'
                }),
                mockShipment
            );
            expect(mockShipment.invoice.status).toBe('Generated');
        });

        it('should assign IGST (18%) for interstate non-UP shipments', async () => {
            const mockShipment = {
                _id: 'shipment-interstate-1',
                shipmentId: 'DFL2002',
                serviceDetails: { price: '2360.00', countrySurcharge: 0 },
                shipmentDetails: { gstPaymentType: 'regular' },
                shipperDetails: {
                    shipperName: 'Anil Kumar',
                    city: 'Bengaluru',
                    state: 'Karnataka', // Non-UP
                    country: 'India'
                },
                user: { kycData: { gstNumber: '29ABCDE1234F1Z5' } },
                markModified: jest.fn(),
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            const result = await autoGenerateAndLockInvoice('shipment-interstate-1');

            expect(result).not.toBeNull();
            expect(generateInvoicePDF).toHaveBeenCalledWith(
                expect.objectContaining({
                    tax: expect.objectContaining({
                        type: 'IGST',
                        rate: 18,
                        amount: 360
                    })
                }),
                mockShipment
            );
        });
    });

    // =========================================================================
    // 2. SINGLE INVOICE DOWNLOAD & DRAFT GUARD TESTS (documentController)
    // =========================================================================
    describe('2. Single Invoice Download & Draft Guard', () => {
        it('getSingleInvoicePDF should reject download with 403 if user is not authorized', async () => {
            const req = {
                user: { _id: 'unauthorized-user', isAdmin: false, role: 'user' },
                params: { id: '507f1f77bcf86cd799439011' }
            };
            const res = buildRes();

            const mockShipment = {
                _id: '507f1f77bcf86cd799439011',
                user: { _id: 'owner-user' }
            };

            Shipment.findById.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            await documentController.getSingleInvoicePDF(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: expect.stringContaining('Not authorized')
            }));
        });

        it('getSingleInvoicePDF should reject download with 400 if invoice is in Draft/ungenerated state for customer', async () => {
            const req = {
                user: { _id: 'owner-user', isAdmin: false, role: 'user' },
                params: { id: 'ship-draft-1' }
            };
            const res = buildRes();

            const mockShipment = {
                _id: 'ship-draft-1',
                shipmentId: 'ship-draft-1',
                user: { _id: 'owner-user' },
                invoice: { status: 'Draft' } // Ungenerated
            };

            Shipment.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            await documentController.getSingleInvoicePDF(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: expect.stringContaining('currently in draft')
            }));
        });

        it('getSingleInvoicePDF should stream PDF attachment when invoice is Generated', async () => {
            const req = {
                user: { _id: 'owner-user', isAdmin: false, role: 'user' },
                params: { id: 'DFL999' }
            };
            const res = buildRes();

            const mockShipment = {
                _id: 'ship-gen-1',
                shipmentId: 'DFL999',
                user: { _id: 'owner-user' },
                invoice: {
                    status: 'Generated',
                    pdfUrl: 'https://res.cloudinary.com/dfl/raw/upload/invoices/test.pdf'
                }
            };

            Shipment.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            await documentController.getSingleInvoicePDF(req, res);

            expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
                'Content-Type': 'application/pdf',
                'Content-Disposition': expect.stringContaining('INVOICE_DFL999.pdf')
            }));
            expect(res.send).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 3. CUSTOMER DOCUMENTS & FILTER TESTS (documentController.getCustomerDocuments)
    // =========================================================================
    describe('3. Customer Documents Queries & Isolation', () => {
        it('getCustomerDocuments should filter for invoice.status: Generated when fetching regular invoices', async () => {
            const req = {
                user: { _id: 'user-100' },
                query: { page: '1', limit: '20', category: 'all', dispute: 'all' }
            };
            const res = buildRes();

            const mockQuery = {
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([])
            };

            Shipment.find.mockReturnValue(mockQuery);
            Shipment.countDocuments.mockResolvedValue(0);

            await documentController.getCustomerDocuments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(expect.objectContaining({
                user: 'user-100',
                'invoice.status': 'Generated' // Drafts hidden
            }));
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('getCustomerDocuments should filter for CSB-V and Available shipping bills when docType: shipping_bill', async () => {
            const req = {
                user: { _id: 'user-100' },
                query: { page: '1', limit: '20', docType: 'shipping_bill' }
            };
            const res = buildRes();

            const mockQuery = {
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([])
            };

            Shipment.find.mockReturnValue(mockQuery);
            Shipment.countDocuments.mockResolvedValue(0);

            await documentController.getCustomerDocuments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(expect.objectContaining({
                user: 'user-100',
                'shipmentDetails.shipmentCategory': 'csb5',
                'shippingBill.status': 'Available' // Pending hidden
            }));
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('getCustomerDocuments should filter by search query (AWB / Consignee) and date range', async () => {
            const req = {
                user: { _id: 'user-100' },
                query: {
                    page: '1',
                    limit: '20',
                    search: 'DFL83665602',
                    startDate: '2026-09-01',
                    endDate: '2026-09-16'
                }
            };
            const res = buildRes();

            const mockQuery = {
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([])
            };

            Shipment.find.mockReturnValue(mockQuery);
            Shipment.countDocuments.mockResolvedValue(0);

            await documentController.getCustomerDocuments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(expect.objectContaining({
                user: 'user-100',
                'invoice.status': 'Generated',
                $or: expect.arrayContaining([
                    expect.objectContaining({ 'shipmentDetails.awbNumber': { $regex: 'DFL83665602', $options: 'i' } })
                ]),
                createdAt: expect.objectContaining({
                    $gte: expect.any(Date),
                    $lte: expect.any(Date)
                })
            }));
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // =========================================================================
    // 4. BULK ZIP DOWNLOADS TESTS (Invoices & Shipping Bills)
    // =========================================================================
    describe('4. Bulk ZIP Downloads (Invoices & CSB-V Shipping Bills)', () => {
        it('bulkDownloadInvoices should reject if selectedIds is empty in selected mode', async () => {
            const req = {
                user: { _id: 'user-100' },
                body: { selectionMode: 'selected', selectedIds: [] }
            };
            const res = buildRes();

            await documentController.bulkDownloadInvoices(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: expect.stringContaining('select at least one shipment')
            }));
        });

        it('bulkDownloadInvoices should reject if selectedIds exceeds 100 limit', async () => {
            const req = {
                user: { _id: 'user-100' },
                body: {
                    selectionMode: 'selected',
                    selectedIds: new Array(101).fill('shipment-id')
                }
            };
            const res = buildRes();

            await documentController.bulkDownloadInvoices(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('capped at a maximum of 100')
            }));
        });

        it('bulkDownloadShippingBills should reject if selectedIds is empty', async () => {
            const req = {
                user: { _id: 'user-100' },
                body: { selectionMode: 'selected', selectedIds: [] }
            };
            const res = buildRes();

            await documentController.bulkDownloadShippingBills(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: expect.stringContaining('select at least one CSB-V shipment')
            }));
        });
    });

    // =========================================================================
    // 5. ADMIN CSB-V SHIPPING BILLS CONTROLLER TESTS
    // =========================================================================
    describe('5. Admin CSB-V Shipping Bills Controller', () => {
        it('getAdminCSBVShipments should return pending shipments and accurate counts', async () => {
            const req = { query: { tab: 'pending', page: '1', limit: '20' } };
            const res = buildRes();

            const mockQuery = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([{ _id: 'csb-1', shippingBill: { status: 'Pending' } }])
            };

            Shipment.find
                .mockReturnValueOnce(mockQuery)
                .mockReturnValueOnce({ distinct: jest.fn().mockResolvedValue(['user-1']) });

            Shipment.countDocuments
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0);

            User.find.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([{ _id: 'user-1', name: 'Exporter 1' }])
            });

            await adminShippingBillController.getAdminCSBVShipments(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                pendingCount: 1,
                completedCount: 0
            }));
        });

        it('uploadShippingBill should update shipment with Cloudinary URL and set status to Available', async () => {
            const req = {
                body: { shipmentId: 'csb-1' },
                file: {
                    path: 'https://res.cloudinary.com/dfl/raw/upload/csbv_1001.pdf',
                    filename: 'shipping_bills/csbv_1001.pdf',
                    originalname: 'CSBV_1001.pdf',
                    size: 250000
                },
                admin: { _id: 'admin-1', name: 'Ops SuperAdmin' }
            };
            const res = buildRes();

            const mockShipment = {
                _id: 'csb-1',
                shipmentDetails: { shipmentCategory: 'csb5', awbNumber: 'AWB9900' },
                shippingBill: { status: 'Pending' },
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findOne.mockResolvedValue(mockShipment);

            await adminShippingBillController.uploadShippingBill(req, res);

            expect(mockShipment.shippingBill.status).toBe('Available');
            expect(mockShipment.shippingBill.url).toBe('https://res.cloudinary.com/dfl/raw/upload/csbv_1001.pdf');
            expect(mockShipment.save).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('deleteShippingBill should destroy Cloudinary file and reset status to Pending', async () => {
            const req = { params: { id: 'csb-1' } };
            const res = buildRes();

            const mockShipment = {
                _id: 'csb-1',
                shippingBill: {
                    status: 'Available',
                    publicId: 'shipping_bills/csbv_old',
                    url: 'https://res.cloudinary.com/dfl/raw/upload/old.pdf'
                },
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findById.mockResolvedValue(mockShipment);

            await adminShippingBillController.deleteShippingBill(req, res);

            expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('shipping_bills/csbv_old', expect.any(Object));
            expect(mockShipment.shippingBill.status).toBe('Pending');
            expect(mockShipment.shippingBill.url).toBeNull();
            expect(mockShipment.save).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // =========================================================================
    // 6. RBAC PERMISSIONS TESTS
    // =========================================================================
    describe('6. RBAC Permissions (shipping_bill:manage)', () => {
        it('should grant shipping_bill:manage permission to super_admin by default', () => {
            const admin = { role: 'super_admin', permissions: [] };
            expect(getEffectivePermissions(admin)).toContain('shipping_bill:manage');
        });

        it('should allow custom positive override for member role', () => {
            const member = { role: 'member', permissions: ['shipping_bill:manage'] };
            expect(getEffectivePermissions(member)).toContain('shipping_bill:manage');
        });

        it('should allow negative override to revoke from super_admin', () => {
            const admin = { role: 'super_admin', permissions: ['-shipping_bill:manage'] };
            expect(getEffectivePermissions(admin)).not.toContain('shipping_bill:manage');
        });
    });
});
