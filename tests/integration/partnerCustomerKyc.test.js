process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-partner-kyc';

jest.mock('../../queues/emailQueue', () => ({
    add: jest.fn().mockResolvedValue({ id: 'mock-email-job' })
}));

jest.mock('../../config/cloudinaryConfig', () => ({
    cloudinary: {
        uploader: {
            upload: jest.fn().mockResolvedValue({ secure_url: 'https://example.test/mock-doc.png' })
        }
    },
    CloudinaryStorage: jest.fn().mockImplementation(() => ({
        _handleFile: (req, file, cb) => cb(null, { path: 'https://example.test/mock-doc.png', size: 1024 }),
        _removeFile: (req, file, cb) => cb(null)
    }))
}));

jest.mock('../../services/carriers/carrierBookingExecutionService', () => ({
    processShipment: jest.fn().mockResolvedValue({ success: true }),
    EXECUTION_SOURCES: { CUSTOMER_DASHBOARD: 'CUSTOMER_DASHBOARD' }
}));

jest.mock('../../utils/invoiceAutoGenerator', () => ({
    autoGenerateAndLockInvoice: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../utils/brevoService', () => ({
    sendBrevoSMS: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../services/whatsappService', () => ({
    sendFirstBookingNotification: jest.fn().mockResolvedValue({ success: true })
}));

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../server');
const Partner = require('../../models/Partner');
const User = require('../../models/User');
const Shipment = require('../../models/Shipment');
const Admin = require('../../models/Admin');

describe('Partner Walk-In Customer & KYC Integration Tests', () => {
    let partner1;
    let partner1Token;
    let partner2;
    let partner2Token;

    beforeEach(async () => {
        // Create Partner 1
        partner1 = await Partner.create({
            partnerType: 'franchise',
            partnerCode: 'DFLP-TEST01',
            companyName: 'Express Logistics Hub 1',
            displayName: 'Express Hub 1',
            ownerName: 'Partner Owner One',
            email: `partner1-${Date.now()}@example.com`,
            phone: '9811111111',
            password: 'password123',
            walletBalance: 10000,
            branch: 'Noida'
        });
        partner1Token = jwt.sign({ id: partner1._id }, process.env.JWT_SECRET);

        // Create Partner 2 (for isolation/permission checks)
        partner2 = await Partner.create({
            partnerType: 'asp',
            partnerCode: 'DFLP-TEST02',
            companyName: 'Express Logistics Hub 2',
            displayName: 'Express Hub 2',
            ownerName: 'Partner Owner Two',
            email: `partner2-${Date.now()}@example.com`,
            phone: '9822222222',
            password: 'password123',
            walletBalance: 10000,
            branch: 'Noida'
        });
        partner2Token = jwt.sign({ id: partner2._id }, process.env.JWT_SECRET);
    });

    describe('POST /api/partners/customers - Customer Registration', () => {
        it('should register a new walk-in customer with partner attribution and billing address', async () => {
            const customerData = {
                name: 'Walk-In Customer 1',
                email: `walkin-${Date.now()}@example.com`,
                phone: '9876543210',
                isWalkIn: true,
                billingAddress: {
                    addressLine1: '3rd Floor, Tower B, Logix Techno Park',
                    addressLine2: 'Sector 127',
                    city: 'Noida',
                    state: 'Uttar Pradesh',
                    country: 'India',
                    pincode: '201301'
                }
            };

            const res = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send(customerData);

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('Customer registered successfully');
            expect(res.body._id).toBeDefined();
            expect(res.body.email).toBe(customerData.email.toLowerCase());
            expect(res.body.partnerCode).toBe(partner1.partnerCode);

            // Verify database state
            const savedUser = await User.findById(res.body._id);
            expect(savedUser).not.toBeNull();
            expect(savedUser.referralSource).toBe('Walk-In');
            expect(savedUser.tag).toBe('923971e40ebbd2f61e7215f5763567d1'); // Franchise tag hash
            expect(savedUser.partnerId.toString()).toBe(partner1._id.toString());
            expect(savedUser.kycData.billingAddress.city).toBe('Noida');
        });

        it('should reject duplicate customer registration by email or phone', async () => {
            const customerData = {
                name: 'Duplicate Test Cust',
                email: `dup-${Date.now()}@example.com`,
                phone: '9876543299',
                isWalkIn: true
            };

            // First registration
            const res1 = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send(customerData);
            expect(res1.statusCode).toBe(201);

            // Second registration attempt with identical email
            const res2 = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send({
                    ...customerData,
                    phone: '9876543200'
                });
            expect(res2.statusCode).toBe(400);
            expect(res2.body.message).toContain('already exists with this email address');

            // Third registration attempt with identical phone
            const res3 = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send({
                    ...customerData,
                    email: `other-${Date.now()}@example.com`
                });
            expect(res3.statusCode).toBe(400);
            expect(res3.body.message).toContain('already exists with this phone number');
        });
    });

    describe('POST /api/partners/customers/kyc - CSB-4 (Personal KYC)', () => {
        it('should submit CSB-4 Personal KYC and sanitize empty panDob without cast error', async () => {
            // Register customer first
            const regRes = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send({
                    name: 'CSB4 Test User',
                    email: `csb4-${Date.now()}@example.com`,
                    phone: '9876541111',
                    isWalkIn: true
                });
            expect(regRes.statusCode).toBe(201);
            const customerId = regRes.body._id;

            // Submit CSB-4 Personal KYC
            const kycRes = await request(app)
                .post('/api/partners/customers/kyc')
                .set('Authorization', `Bearer ${partner1Token}`)
                .field('customerId', customerId)
                .field('accountType', 'personal')
                .field('documentType', 'aadhar')
                .field('documentNumber', '987654321121')
                .field('panNumber', '')
                .field('panName', '')
                .field('panDob', '') // Test empty date string handling
                .field('addressLine1', '3rd Floor, Unit No. 331')
                .field('city', 'Noida')
                .field('state', 'Uttar Pradesh')
                .field('country', 'India')
                .field('pincode', '201301');

            expect(kycRes.statusCode).toBe(200);
            expect(kycRes.body.success).toBe(true);
            expect(kycRes.body.message).toBe('Customer KYC submitted successfully');
            expect(kycRes.body.kycStatus).toBe('pending');

            // Verify in DB
            const updatedUser = await User.findById(customerId);
            expect(updatedUser.kycData.status).toBe('pending');
            expect(updatedUser.kycData.documentType).toBe('aadhar');
            expect(updatedUser.kycData.documentNumber).toBe('987654321121');
            expect(updatedUser.kycData.panDob).toBeNull();
            expect(updatedUser.kycVerified).toBe(false);
        });
    });

    describe('POST /api/partners/customers/kyc - CSB-5 (Business KYC)', () => {
        it('should submit CSB-5 Business KYC and handle array/duplicate accountType input cleanly', async () => {
            // Register customer first
            const regRes = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send({
                    name: 'CSB5 Business User',
                    email: `csb5-${Date.now()}@example.com`,
                    phone: '9876542222',
                    isWalkIn: true
                });
            expect(regRes.statusCode).toBe(201);
            const customerId = regRes.body._id;

            // Submit CSB-5 Business KYC sending duplicate accountType fields to test array normalization
            const kycRes = await request(app)
                .post('/api/partners/customers/kyc')
                .set('Authorization', `Bearer ${partner1Token}`)
                .field('customerId', customerId)
                .field('accountType', 'business')
                .field('accountType', 'business') // Duplicate FormData key simulation
                .field('documentType', 'Aadhaar Card')
                .field('documentNumber', '123456789012')
                .field('panName', 'Business Corp')
                .field('panDob', '1990-01-15')
                .field('gstNumber', '07AAAAA0000A1Z5')
                .field('gstPaymentType', 'lut')
                .field('isCSBV', 'true')
                .field('iecNumber', 'IEC12345678')
                .field('adCode', 'AD9999')
                .field('bankName', 'HDFC Bank')
                .field('bankAccountNumber', '5010022334455')
                .field('ifscCode', 'HDFC0001234')
                .field('addressLine1', '45 Business Park')
                .field('city', 'Noida')
                .field('state', 'Uttar Pradesh')
                .field('country', 'India')
                .field('pincode', '201301');

            expect(kycRes.statusCode).toBe(200);
            expect(kycRes.body.success).toBe(true);
            expect(kycRes.body.message).toBe('Customer KYC submitted successfully');
            expect(kycRes.body.kycStatus).toBe('pending');

            // Verify in DB
            const updatedUser = await User.findById(customerId);
            expect(updatedUser.accountType).toBe('business');
            expect(updatedUser.kycData.status).toBe('pending');
            expect(updatedUser.kycData.gstNumber).toBe('07AAAAA0000A1Z5');
            expect(updatedUser.kycData.isCSBV).toBe(true);
            expect(updatedUser.kycData.iecNumber).toBe('IEC12345678');
            expect(updatedUser.kycData.bankName).toBe('HDFC Bank');
        });
    });

const Admin = require('../../models/Admin');

    describe('POST /api/partners/customers/kyc - Permissions & Error Handling', () => {
        it('should return 400 when customerId is missing', async () => {
            const res = await request(app)
                .post('/api/partners/customers/kyc')
                .set('Authorization', `Bearer ${partner1Token}`)
                .field('accountType', 'personal');

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toBe('Customer ID is required.');
        });

        it('should return 401 when partner token is missing', async () => {
            const res = await request(app)
                .post('/api/partners/customers/kyc')
                .field('customerId', '6ab272e49b1053ce498e2ce1');

            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
        });

        it('should return 404 when Partner 2 attempts to submit KYC for Partner 1 customer', async () => {
            // Customer registered under Partner 1
            const regRes = await request(app)
                .post('/api/partners/customers')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send({
                    name: 'Partner 1 Cust',
                    email: `p1cust-${Date.now()}@example.com`,
                    phone: '9876543333',
                    isWalkIn: true
                });
            expect(regRes.statusCode).toBe(201);
            const partner1CustomerId = regRes.body._id;

            // Partner 2 attempts to submit KYC for Partner 1's customer
            const res = await request(app)
                .post('/api/partners/customers/kyc')
                .set('Authorization', `Bearer ${partner2Token}`)
                .field('customerId', partner1CustomerId)
                .field('documentType', 'aadhar')
                .field('documentNumber', '123456789012');

            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toBe('Customer not found or you do not have permission to modify this customer.');
        });
    });

    describe('POST /api/partners/shipments - Walk-In Customer Booking Linkage', () => {
        it('should link the shipment directly to the selected walk-in customer user ID', async () => {
            // 1. Create a Walk-In customer under partner1
            const walkinCustomer = await User.create({
                name: 'Direct Walk-In Client',
                email: `directwalkin-${Date.now()}@example.com`,
                phone: '9876543219',
                password: 'password123',
                customerId: 'DFLC-888999',
                accountType: 'personal',
                partnerId: partner1._id,
                partnerCode: partner1.partnerCode,
                tag: '923971e40ebbd2f61e7215f5763567d1',
                referralSource: 'Walk-In',
                kycData: {
                    status: 'primary_approved',
                    canBookShipment: true
                }
            });

            // 2. Partner books shipment with customerType 'Walk-In' and userId = walkinCustomer._id
            const shipmentPayload = {
                userId: walkinCustomer._id.toString(),
                customerType: 'Walk-In',
                shipperDetails: {
                    shipperName: 'Direct Walk-In Client',
                    mobileNo: '9876543219',
                    addressLine1: 'Test Shipper Address',
                    city: 'Noida',
                    state: 'Uttar Pradesh',
                    country: 'India',
                    countryCode: 'IN',
                    pincode: '201301'
                },
                consigneeDetails: {
                    consigneeName: 'Test Consignee',
                    mobileNo: '1234567890',
                    addressLine1: '123 Main St',
                    city: 'London',
                    state: 'London',
                    country: 'United Kingdom',
                    countryCode: 'GB',
                    pincode: 'EC1A 1BB'
                },
                shipmentDetails: {
                    shipmentType: 'document',
                    shipmentCategory: 'personal',
                    invoiceNumber: `INV-${Date.now()}`,
                    boxes: [{ weight: 0.5, length: 10, width: 10, height: 5, items: [] }]
                },
                serviceDetails: {
                    serviceName: 'Express Worldwide',
                    serviceCode: 'EXP_WW',
                    carrierCode: '101',
                    carrierName: 'TPL',
                    price: 1500,
                    dflCost: 1200,
                    chargeableWeight: 0.5
                }
            };

            const res = await request(app)
                .post('/api/partners/shipments')
                .set('Authorization', `Bearer ${partner1Token}`)
                .send(shipmentPayload);

            expect(res.statusCode).toBe(201);
            expect(res.body.shipmentId || res.body._id).toBeDefined();

            // 3. Verify shipment in database is directly linked to the walk-in customer user
            const savedShipment = await Shipment.findById(res.body._id || res.body.shipment?._id);
            expect(savedShipment).not.toBeNull();
            expect(savedShipment.user.toString()).toBe(walkinCustomer._id.toString());
            expect(savedShipment.partnerId.toString()).toBe(partner1._id.toString());
            expect(savedShipment.billingOwnerType).toBe('Partner');
        });
    });

    describe('Franchise Partner 3-Tier Maker-Checker Flow', () => {
        let admin1;
        let admin1Token;
        let admin2;
        let admin2Token;
        let franchisePartner;
        let franchiseToken;

        beforeEach(async () => {
            admin1 = await Admin.create({
                name: 'Admin Maker',
                email: `admin1-${Date.now()}@example.com`,
                password: 'password123',
                contactNumber: '9999911111',
                designation: 'Operations Manager',
                department: 'Operations',
                role: 'admin',
                permissions: ['partner:manage', 'partner:view']
            });
            admin1Token = jwt.sign({ id: admin1._id, role: 'admin' }, process.env.JWT_SECRET);

            admin2 = await Admin.create({
                name: 'Admin Checker',
                email: `admin2-${Date.now()}@example.com`,
                password: 'password123',
                contactNumber: '9999922222',
                designation: 'Compliance Head',
                department: 'Compliance',
                role: 'admin',
                permissions: ['partner:manage', 'partner:view']
            });
            admin2Token = jwt.sign({ id: admin2._id, role: 'admin' }, process.env.JWT_SECRET);

            franchisePartner = await Partner.create({
                partnerType: 'franchise',
                partnerCode: `DFLP-${Date.now()}`,
                companyName: 'Noida Express Franchise',
                displayName: 'Noida Hub',
                ownerName: 'Franchise Partner Owner',
                email: `franchise-${Date.now()}@example.com`,
                phone: '9888877777',
                password: 'password123',
                branch: 'Noida',
                createdBy: admin1._id
            });
            franchiseToken = jwt.sign({ id: franchisePartner._id }, process.env.JWT_SECRET);
        });

        it('should execute full 3-Tier Maker-Checker workflow with Admin upload, Partner verification & Secondary Admin approval', async () => {
            // Step 1: Admin 1 (Maker) uploads Partner KYC documents
            const uploadRes = await request(app)
                .put(`/api/admin/partners/${franchisePartner._id}/kyc-upload`)
                .set('Authorization', `Bearer ${admin1Token}`)
                .field('documentType', 'aadhar')
                .field('documentNumber', '123456789012')
                .field('panNumber', 'ABCDE1234F')
                .field('panName', 'Franchise Partner Owner')
                .field('gstNumber', '07AAAAA0000A1Z5');

            expect(uploadRes.statusCode).toBe(200);
            expect(uploadRes.body.success).toBe(true);

            // Step 2: Admin 1 (Maker) attempts self-approval -> BLOCKED by 403 Maker-Checker Rule
            const selfApproveRes = await request(app)
                .put(`/api/admin/partners/${franchisePartner._id}/kyc-status`)
                .set('Authorization', `Bearer ${admin1Token}`)
                .send({ status: 'verified' });

            expect(selfApproveRes.statusCode).toBe(403);
            expect(selfApproveRes.body.message).toContain('Maker-Checker Rule');

            // Step 3: Admin 2 (Checker) attempts approval BEFORE partner confirms -> BLOCKED by 400
            const prematureApproveRes = await request(app)
                .put(`/api/admin/partners/${franchisePartner._id}/kyc-status`)
                .set('Authorization', `Bearer ${admin2Token}`)
                .send({ status: 'verified' });

            expect(prematureApproveRes.statusCode).toBe(400);
            expect(prematureApproveRes.body.message).toContain('Partner Confirmation Required');

            // Step 4: Franchise Partner reviews and confirms documents in Hub
            const partnerConfirmRes = await request(app)
                .post('/api/partners/kyc/confirm')
                .set('Authorization', `Bearer ${franchiseToken}`);

            expect(partnerConfirmRes.statusCode).toBe(200);
            expect(partnerConfirmRes.body.success).toBe(true);

            // Step 5: Admin 2 (Checker) grants final approval -> SUCCESS 200
            const finalApproveRes = await request(app)
                .put(`/api/admin/partners/${franchisePartner._id}/kyc-status`)
                .set('Authorization', `Bearer ${admin2Token}`)
                .send({ status: 'verified' });

            expect(finalApproveRes.statusCode).toBe(200);
            expect(finalApproveRes.body.kycStatus).toBe('verified');
        });
    });
});
