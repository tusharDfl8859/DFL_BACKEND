const request = require('supertest');
const { app } = require('../../server');
const User = require('../../models/User');
const Shipment = require('../../models/Shipment');

describe('Public Tracking API', () => {
    it('returns sanitized tracking data without sensitive fields', async () => {
        const user = await User.create({
            name: 'Track User',
            email: `track-${Date.now()}@example.com`,
            phone: '9998887777',
            password: 'password123',
            customerId: `DFLC-${Date.now()}`,
            accountType: 'personal'
        });

        const shipment = await Shipment.create({
            user: user._id,
            shipmentId: `DFL${Date.now()}`,
            shipperDetails: {
                shipperName: 'Alice Johnson',
                companyName: 'Alice Co',
                mobileNo: '8859932237',
                email: 'alice@example.com',
                location: 'Noida',
                addressLine1: '123 Main Street',
                addressLine2: 'Block A',
                city: 'Noida',
                state: 'UP',
                country: 'India',
                countryCode: 'IN',
                pincode: '201301',
                alternateName: 'Bob',
                alternateMobile: '9000000000',
                shipperType: 'Business',
                shipperIdType: 'GST NO',
                shipperIdNo: 'GST123'
            },
            consigneeDetails: {
                consigneeName: 'John Doe',
                companyName: 'John LLC',
                mobileNo: '7776665555',
                email: 'john@example.com',
                location: 'Delhi',
                addressLine1: '456 Market Road',
                addressLine2: 'Near Metro',
                city: 'Delhi',
                state: 'Delhi',
                country: 'India',
                countryCode: 'IN',
                pincode: '110001',
                alternateName: 'Jane',
                alternateMobile: '9111111111'
            },
            shipmentDetails: {
                shipmentType: 'Doc',
                shipmentCategory: 'personal',
                shipmentMode: 'Air',
                preferredUnit: 'KG',
                noOfBoxes: '1',
                currency: 'INR',
                referenceNumber: 'REF001',
                invoiceNumber: 'INV001',
                boxes: [],
                gstPaymentType: 'lut'
            },
            serviceDetails: {
                serviceName: 'Express',
                serviceCode: 'EXP',
                carrierName: 'Speedbox',
                price: '100',
                eta: '2026-07-19'
            },
            trackingHistory: [
                {
                    status: 'Picked',
                    location: 'Noida',
                    description: 'Package picked',
                    timestamp: new Date('2026-07-17T10:00:00Z')
                }
            ],
            invoice: {
                invoiceId: 'INV-001',
                pdfUrl: 'https://example.com/private-invoice.pdf'
            },
            status: 'In Transit',
            trackingId: 'TRK123456',
            carrierLabelUrl: 'https://example.com/private-label.pdf',
            carrierBookingId: 'AWB123456'
        });

        const res = await request(app).get(`/api/shipments/track/${shipment.shipmentId}`);

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('trackingNumber');
        expect(res.body).toHaveProperty('status');
        expect(res.body).toHaveProperty('trackingHistory');
        expect(res.body).toHaveProperty('shipperDetails');
        expect(res.body).toHaveProperty('consigneeDetails');
        expect(res.body).toHaveProperty('shipmentDetails');
        expect(res.body).toHaveProperty('serviceDetails');
        expect(res.body).toHaveProperty('invoice');
        expect(res.body).toHaveProperty('trackingHistory');
        expect(res.body.shipperDetails.shipperName).not.toBe('Alice Johnson');
        expect(res.body.shipperDetails.mobileNo).not.toBe('8859932237');
        expect(res.body.consigneeDetails.consigneeName).not.toBe('John Doe');
        expect(res.body.invoice.pdfUrl).toBeNull();
        expect(res.body).not.toHaveProperty('carrierLabelUrl');
        expect(res.body).not.toHaveProperty('carrierBookingId');
        expect(res.body.trackingHistory).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    status: 'Picked',
                    location: 'Noida'
                })
            ])
        );
    });
});
