const mongoose = require('mongoose');
const Partner = require('../../models/Partner');
const {
    createPartner,
    getPartners,
    updatePartner
} = require('../../controllers/admin/partnerController');

describe('Franchise & ASP Partner Management Unit & Integration Tests', () => {
    let mockRes;
    let mockAdmin;
    let mockSuperAdmin;

    beforeEach(() => {
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };

        mockAdmin = {
            _id: new mongoose.Types.ObjectId(),
            email: 'admin_ops@dfl.com',
            role: 'admin',
            name: 'Ops Admin'
        };

        mockSuperAdmin = {
            _id: new mongoose.Types.ObjectId(),
            email: 'super_admin@dfl.com',
            role: 'super_admin',
            name: 'Super Administrator'
        };
    });

    describe('1. Model Schema & Dynamic Branch Support', () => {
        it('should allow creating partner with custom branch outside legacy enum', async () => {
            const partner = await Partner.create({
                partnerType: 'franchise',
                partnerCode: 'DFLP-BEN01',
                companyName: 'Bengaluru Logistics Hub',
                ownerName: 'Suresh Kumar',
                email: 'bengaluru_hub@example.com',
                phone: '9876543210',
                password: 'Password123!',
                branch: 'Bengaluru Urban'
            });

            expect(partner).toBeDefined();
            expect(partner.branch).toBe('Bengaluru Urban');
            expect(partner.partnerType).toBe('franchise');
        });

        it('should support ASP partner type with any branch name', async () => {
            const partner = await Partner.create({
                partnerType: 'asp',
                partnerCode: 'DFLP-PUN01',
                companyName: 'Pune Courier ASP',
                ownerName: 'Rahul Patil',
                email: 'pune_asp@example.com',
                phone: '9876543211',
                password: 'Password123!',
                branch: 'Pune Hinjewadi'
            });

            expect(partner).toBeDefined();
            expect(partner.partnerType).toBe('asp');
            expect(partner.branch).toBe('Pune Hinjewadi');
        });
    });

    describe('2. Address Normalization in createPartner & updatePartner', () => {
        it('should normalize root-level address fields into billingAddress on creation', async () => {
            const req = {
                admin: mockSuperAdmin,
                body: {
                    partnerType: 'franchise',
                    companyName: 'Jaipur Courier Services',
                    ownerName: 'Mahesh Sharma',
                    email: 'jaipur_cs@example.com',
                    phone: '9876543212',
                    password: 'Password123!',
                    branch: 'Jaipur',
                    addressLine1: 'Plot 42, Transport Nagar',
                    addressLine2: 'Near GPO',
                    city: 'Jaipur',
                    state: 'Rajasthan',
                    country: 'India',
                    pincode: '302003'
                }
            };

            await createPartner(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(201);
            const created = mockRes.json.mock.calls[0][0];
            expect(created.billingAddress).toBeDefined();
            expect(created.billingAddress.addressLine1).toBe('Plot 42, Transport Nagar');
            expect(created.billingAddress.city).toBe('Jaipur');
            expect(created.billingAddress.state).toBe('Rajasthan');
            expect(created.billingAddress.pincode).toBe('302003');
        });

        it('should normalize root-level address updates in updatePartner', async () => {
            const partner = await Partner.create({
                partnerType: 'franchise',
                partnerCode: 'DFLP-UPD01',
                companyName: 'Update Test Hub',
                ownerName: 'Original Owner',
                email: 'update_test@example.com',
                phone: '9876543213',
                password: 'Password123!',
                branch: 'Noida'
            });

            const req = {
                admin: mockSuperAdmin,
                params: { id: partner._id.toString() },
                body: {
                    addressLine1: 'Tower B, Cyber City',
                    city: 'Gurugram',
                    state: 'Haryana',
                    pincode: '122002'
                }
            };

            await updatePartner(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const updated = mockRes.json.mock.calls[0][0];
            expect(updated.billingAddress.addressLine1).toBe('Tower B, Cyber City');
            expect(updated.billingAddress.city).toBe('Gurugram');
            expect(updated.billingAddress.state).toBe('Haryana');
            expect(updated.billingAddress.pincode).toBe('122002');
        });
    });

    describe('3. Dynamic Branch & State Filtering with Regex', () => {
        beforeEach(async () => {
            await Partner.create([
                {
                    partnerType: 'franchise',
                    partnerCode: 'DFLP-FLT01',
                    companyName: 'Noida Logistics 1',
                    ownerName: 'Owner 1',
                    email: 'noida1@example.com',
                    phone: '9876543221',
                    password: 'Password123!',
                    branch: 'Noida',
                    billingAddress: { city: 'Noida', state: 'Uttar Pradesh', pincode: '201301' },
                    status: 'active'
                },
                {
                    partnerType: 'franchise',
                    partnerCode: 'DFLP-FLT02',
                    companyName: 'Noida Logistics 2',
                    ownerName: 'Owner 2',
                    email: 'noida2@example.com',
                    phone: '9876543222',
                    password: 'Password123!',
                    branch: 'NOIDA',
                    billingAddress: { city: 'Noida', state: 'Uttar Pradesh', pincode: '201302' },
                    status: 'active'
                },
                {
                    partnerType: 'franchise',
                    partnerCode: 'DFLP-FLT03',
                    companyName: 'Jaipur Logistics',
                    ownerName: 'Owner 3',
                    email: 'jaipur1@example.com',
                    phone: '9876543223',
                    password: 'Password123!',
                    branch: 'Jaipur',
                    billingAddress: { city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
                    status: 'active'
                }
            ]);
        });

        it('should perform case-insensitive branch filtering', async () => {
            const req = {
                query: {
                    branch: 'noida',
                    page: 1,
                    limit: 10
                }
            };

            await getPartners(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const response = mockRes.json.mock.calls[0][0];
            expect(response.totalPartners).toBe(2);
            expect(response.partners.length).toBe(2);
            expect(response.partners.every(p => p.branch.toLowerCase() === 'noida')).toBe(true);
        });

        it('should perform case-insensitive state filtering', async () => {
            const req = {
                query: {
                    state: 'rajasthan',
                    page: 1,
                    limit: 10
                }
            };

            await getPartners(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const response = mockRes.json.mock.calls[0][0];
            expect(response.totalPartners).toBe(1);
            expect(response.partners[0].companyName).toBe('Jaipur Logistics');
        });

        it('should safely escape regex special characters in branch query', async () => {
            const req = {
                query: {
                    branch: 'Delhi(North)*+',
                    page: 1,
                    limit: 10
                }
            };

            await getPartners(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const response = mockRes.json.mock.calls[0][0];
            expect(response.totalPartners).toBe(0);
        });
    });

    describe('4. Dataset-Wide Top Counters Aggregation (Promise.all)', () => {
        beforeEach(async () => {
            const partners = [];
            for (let i = 1; i <= 15; i++) {
                partners.push({
                    partnerType: i <= 12 ? 'franchise' : 'asp',
                    partnerCode: `DFLP-CNT${String(i).padStart(2, '0')}`,
                    companyName: `Partner Company ${i}`,
                    ownerName: `Owner ${i}`,
                    email: `partner_count_${i}@example.com`,
                    phone: `98765433${String(i).padStart(2, '0')}`,
                    password: 'Password123!',
                    branch: i % 2 === 0 ? 'Noida' : 'Jaipur',
                    status: i <= 13 ? 'active' : 'inactive'
                });
            }
            await Partner.create(partners);
        });

        it('should return full dataset count regardless of page limit', async () => {
            const req = {
                query: {
                    page: 1,
                    limit: 5 // Sliced page limit
                }
            };

            await getPartners(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const response = mockRes.json.mock.calls[0][0];
            expect(response.partners.length).toBe(5);
            expect(response.totalPartners).toBe(15);
            expect(response.activePartners).toBe(13);
            expect(response.franchisePartners).toBe(12);
            expect(response.totalPages).toBe(3);
        });
    });

    describe('5. RBAC Authorization on updatePartner', () => {
        let testPartner;

        beforeEach(async () => {
            testPartner = await Partner.create({
                partnerType: 'franchise',
                partnerCode: 'DFLP-RBAC01',
                companyName: 'Secure Logistics Ltd',
                ownerName: 'Vikram Singh',
                email: 'secure_partner@example.com',
                phone: '9876543299',
                password: 'Password123!',
                branch: 'Noida',
                creditLimit: 50000,
                status: 'active'
            });
        });

        it('should allow Super Admin to update companyName, branch, and creditLimit', async () => {
            const req = {
                admin: mockSuperAdmin,
                params: { id: testPartner._id.toString() },
                body: {
                    companyName: 'Updated Secure Logistics Ltd',
                    branch: 'Mumbai Central',
                    creditLimit: 100000
                }
            };

            await updatePartner(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const updated = mockRes.json.mock.calls[0][0];
            expect(updated.companyName).toBe('Updated Secure Logistics Ltd');
            expect(updated.branch).toBe('Mumbai Central');
            expect(updated.creditLimit).toBe(100000);
        });

        it('should reject non-super-admin from updating profile fields with HTTP 403 Forbidden', async () => {
            const req = {
                admin: mockAdmin, // regular admin role
                params: { id: testPartner._id.toString() },
                body: {
                    companyName: 'Unauthorized Change'
                }
            };

            await updatePartner(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(403);
            const error = mockRes.json.mock.calls[0][0];
            expect(error.message).toContain('Only Super Admin has permission to edit partner details');
        });

        it('should allow regular Admin to perform status-only updates (e.g. inactive)', async () => {
            const req = {
                admin: mockAdmin,
                params: { id: testPartner._id.toString() },
                body: {
                    status: 'inactive'
                }
            };

            await updatePartner(req, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            const updated = mockRes.json.mock.calls[0][0];
            expect(updated.status).toBe('inactive');
        });
    });
});
