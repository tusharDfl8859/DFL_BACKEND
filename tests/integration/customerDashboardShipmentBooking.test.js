process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dashboard-booking-regression-secret';

jest.mock('../../queues/emailQueue', () => ({
    add: jest.fn().mockResolvedValue({ id: 'mock-email-job' })
}));

jest.mock('../../utils/brevoService', () => ({
    sendBrevoSMS: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../config/cloudinaryConfig', () => ({
    cloudinary: {
        uploader: {
            upload: jest.fn().mockResolvedValue({ secure_url: 'https://example.test/mock-label.pdf' })
        }
    },
    CloudinaryStorage: jest.fn().mockImplementation(() => ({
        _handleFile: jest.fn(),
        _removeFile: jest.fn()
    }))
}));

jest.mock('../../services/carriers/CarrierBookingService', () => ({
    normalizeCarrier: jest.fn((carrier) => String(carrier || '').toUpperCase()),
    supportsApiBooking: jest.fn(() => false),
    book: jest.fn()
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const WalletReservation = require('../../models/WalletReservation');
const {
    SHIPMENT_BOOKING_SOURCES
} = require('../../constants/developerPortal');
const carrierBookingService = require('../../services/carriers/CarrierBookingService');
const emailQueue = require('../../queues/emailQueue');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Dashboard Booking Customer',
    email: overrides.email || `${nextUnique('dashboard-booking')}@example.com`,
    phone: overrides.phone || '9876543210',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    accountType: 'business',
    walletBalance: overrides.walletBalance ?? 5000,
    kycVerified: true,
    kycData: {
        status: 'verified',
        isCSBV: overrides.isCSBV || false
    },
    ...overrides
});

const bookingPayload = (overrides = {}) => ({
    shipperDetails: {
        shipperName: 'DFL Test Shipper',
        companyName: 'DFL Test Company',
        mobileNo: '9876543210',
        email: 'shipper@example.com',
        addressLine1: 'Origin Address Line 1',
        addressLine2: 'Origin Address Line 2',
        city: 'Noida',
        state: 'Uttar Pradesh',
        country: 'India',
        countryCode: 'IN',
        pincode: '201301',
        ...(overrides.shipperDetails || {})
    },
    consigneeDetails: {
        consigneeName: 'DFL Test Consignee',
        companyName: 'Consignee Company',
        mobileNo: '9876543211',
        email: 'consignee@example.com',
        addressLine1: 'Destination Address Line 1',
        addressLine2: 'Destination Address Line 2',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        countryCode: 'IN',
        pincode: '400001',
        ...(overrides.consigneeDetails || {})
    },
    shipmentDetails: {
        shipmentType: 'document',
        shipmentCategory: 'personal',
        shipmentMode: 'air',
        preferredUnit: 'kg',
        noOfBoxes: '1',
        currency: 'INR',
        referenceNumber: nextUnique('REF-'),
        invoiceNumber: nextUnique('INV-'),
        invoiceDate: new Date().toISOString(),
        boxes: [{
            length: '20',
            width: '15',
            height: '10',
            weight: '1.5',
            items: [{
                productName: 'Regression Test Product',
                hsnCode: '4901',
                quantity: '1',
                unitPrice: '1000'
            }]
        }],
        ...(overrides.shipmentDetails || {})
    },
    serviceDetails: {
        serviceName: 'Manual Regression Service',
        serviceCode: '',
        carrierName: 'ManualCarrier',
        carrierCode: 999,
        price: '₹500.50',
        dflCost: 300,
        eta: '3-5 days',
        chargeableWeight: '1.5',
        ...(overrides.serviceDetails || {})
    },
    paymentMode: overrides.paymentMode || 'Wallet'
});

const postShipment = (user, payload) => request(app)
    .post('/api/shipments')
    .set('Authorization', `Bearer ${signToken(user._id)}`)
    .send(payload);

const flushBackgroundWork = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('Customer dashboard shipment booking regression', () => {
    beforeAll(async () => {
        await Promise.all([
            User.init(),
            Shipment.init(),
            Transaction.init(),
            WalletReservation.init()
        ]);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('creates a shipment, deducts the customer wallet, and records a debit transaction', async () => {
        const user = await createUser({ walletBalance: 5000 });
        const payload = bookingPayload();

        const response = await postShipment(user, payload).expect(201);
        await flushBackgroundWork();

        expect(response.body.shipmentId).toMatch(/^DFL\d{8}$/);
        expect(response.body.status).toBe('Pending');
        expect(response.body.paymentMode).toBe('Wallet');

        const updatedUser = await User.findById(user._id);
        expect(updatedUser.walletBalance).toBeCloseTo(4499.5, 2);

        const shipment = await Shipment.findOne({ shipmentId: response.body.shipmentId }).lean();
        expect(shipment.user.toString()).toBe(user._id.toString());
        expect(shipment.billingOwnerId.toString()).toBe(user._id.toString());
        expect(shipment).toMatchObject({
            bookedByType: 'User',
            billingOwnerType: 'User',
            bookingSource: SHIPMENT_BOOKING_SOURCES.CUSTOMER_DASHBOARD,
            environment: null,
            developerAccountId: null,
            idempotencyRecordId: null,
            walletReservationId: null,
            status: 'Pending',
            paymentMode: 'Wallet',
            carrierBookingStatus: 'MANUAL',
            carrierBookingError: 'Carrier 999 does not support API booking yet.'
        });
        expect(shipment.shipperDetails.shipperName).toBe(payload.shipperDetails.shipperName);
        expect(shipment.consigneeDetails.consigneeName).toBe(payload.consigneeDetails.consigneeName);
        expect(shipment.shipmentDetails.invoiceNumber).toBe(payload.shipmentDetails.invoiceNumber);
        expect(shipment.serviceDetails.price).toBe(payload.serviceDetails.price);
        expect(shipment.trackingHistory[0]).toMatchObject({
            status: 'Pending',
            location: payload.shipperDetails.city,
            description: 'Shipment created'
        });

        const transactions = await Transaction.find({ user: user._id });
        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toMatchObject({
            user: user._id,
            walletOwnerType: 'User',
            walletOwnerId: user._id,
            amount: -500.5,
            type: 'debit',
            referenceId: shipment.shipmentId,
            status: 'success',
            balanceAfter: 4499.5
        });
        expect(transactions[0].description).toBe(`Shipment Booking: ${shipment.shipmentId}`);

        expect(carrierBookingService.book).not.toHaveBeenCalled();
        await expect(WalletReservation.countDocuments()).resolves.toBe(0);
        expect(emailQueue.add).toHaveBeenCalledWith(
            'send-admin-alert',
            expect.objectContaining({ type: 'admin-alert' })
        );
        expect(emailQueue.add).toHaveBeenCalledWith(
            'send-user-confirmation',
            expect.objectContaining({ type: 'user-confirmation', email: user.email })
        );
    });

    test('persists Dashboard serviceDetails with backend-resolved carrier snapshot for configured service pairs', async () => {
        const user = await createUser({ walletBalance: 5000 });
        const payload = bookingPayload({
            serviceDetails: {
                serviceName: 'DFL EXPRESS - Standard',
                serviceCode: 'DFLS100',
                provider: 'customer-supplied-provider',
                carrierName: 'customer-supplied-carrier',
                carrierCode: 999,
                price: '₹500.50',
                dflCost: 500.5,
                eta: '7-8 Business Days',
                chargeableWeight: '1.5'
            }
        });

        const response = await postShipment(user, payload).expect(201);
        await flushBackgroundWork();

        const shipment = await Shipment.findOne({ shipmentId: response.body.shipmentId }).lean();
        expect(shipment.serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: '1',
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json',
            price: '₹500.50',
            dflCost: 500.5,
            eta: '7-8 Business Days',
            chargeableWeight: '1.5',
            cost: 0
        });
        expect(shipment.bookingSource).toBe(SHIPMENT_BOOKING_SOURCES.CUSTOMER_DASHBOARD);
        expect(shipment.carrierBookingError).toBe('Carrier TPL does not support API booking yet.');
    });

    test('does not create shipment or transaction when wallet balance is insufficient', async () => {
        const user = await createUser({ walletBalance: 100 });
        const payload = bookingPayload({
            serviceDetails: {
                price: '₹500.50'
            }
        });

        const response = await postShipment(user, payload).expect(400);

        expect(response.body.message).toContain('Insufficient wallet balance');
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(Transaction.countDocuments()).resolves.toBe(0);

        const updatedUser = await User.findById(user._id);
        expect(updatedUser.walletBalance).toBe(100);
        expect(emailQueue.add).not.toHaveBeenCalled();
        expect(carrierBookingService.book).not.toHaveBeenCalled();
    });

    test('rejects invalid service price before wallet deduction or shipment creation', async () => {
        const user = await createUser({ walletBalance: 5000 });
        const payload = bookingPayload({
            serviceDetails: {
                price: 'not-a-price'
            }
        });

        const response = await postShipment(user, payload).expect(400);

        expect(response.body.message).toBe('Invalid service price');
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(Transaction.countDocuments()).resolves.toBe(0);

        const updatedUser = await User.findById(user._id);
        expect(updatedUser.walletBalance).toBe(5000);
    });

    test('rejects unauthorized CSB-V booking before wallet deduction or shipment creation', async () => {
        const user = await createUser({ walletBalance: 5000, isCSBV: false });
        const payload = bookingPayload({
            shipmentDetails: {
                shipmentCategory: 'csb5',
                boxes: [{
                    length: '20',
                    width: '15',
                    height: '10',
                    weight: '1.5',
                    items: [{
                        productName: 'Commercial Test Product',
                        hsnCode: '6109',
                        quantity: '2',
                        unitPrice: '1000'
                    }]
                }]
            }
        });

        const response = await postShipment(user, payload).expect(403);

        expect(response.body.message).toContain('not authorized for Commercial Shipments');
        await expect(Shipment.countDocuments()).resolves.toBe(0);
        await expect(Transaction.countDocuments()).resolves.toBe(0);

        const updatedUser = await User.findById(user._id);
        expect(updatedUser.walletBalance).toBe(5000);
    });
});
