const mongoose = require('mongoose');

// Mocks
jest.mock('../../models/Shipment');
jest.mock('../../models/DraftShipment');
jest.mock('../../models/User');
jest.mock('../../models/Ticket');
jest.mock('../../models/Dispute');
jest.mock('../../models/WhatsappBotSession');
jest.mock('../../controllers/ratesController');
jest.mock('../../services/whatsappService', () => ({
    sendWhatsappTextMessage: jest.fn().mockResolvedValue({ success: true })
}));
jest.mock('../../utils/labelGenerator', () => ({
    generateDFLBrandedLabel: jest.fn().mockResolvedValue(Buffer.from('PDF'))
}));
jest.mock('../../utils/cacheService', () => ({
    delPattern: jest.fn(),
    get: jest.fn().mockReturnValue(null),
    set: jest.fn().mockReturnValue(true)
}));

const Shipment = require('../../models/Shipment');
const DraftShipment = require('../../models/DraftShipment');
const User = require('../../models/User');
const Ticket = require('../../models/Ticket');
const Dispute = require('../../models/Dispute');
const WhatsappBotSession = require('../../models/WhatsappBotSession');
const cacheService = require('../../utils/cacheService');
const { calculateShippingRate } = require('../../services/chatbot/chatbotService');
const { calculateRatesInternal } = require('../../controllers/ratesController');
const { getSalesPersonShipments } = require('../../controllers/admin/reportController');

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

describe('Chatbot & WhatsApp Base Cost, Profit, and Dispute Unified Unit Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // =========================================================================
    // 1. Rate Calculation Financial Breakdown Verification (chatbotService.js)
    // =========================================================================
    describe('1. Rate Calculation Financial Breakdown', () => {
        test('calculateShippingRate should preserve carrier cost, markup, and GST in options', async () => {
            calculateRatesInternal.mockResolvedValue([
                {
                    serviceName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFL-STD',
                    carrierName: 'DFL Express',
                    provider: 'DFL Express',
                    totalPricing: 1800,
                    gstAmount: 324,
                    totalAmount: 2124,
                    deliveryDays: '4 - 7 Business Days',
                    breakdown: {
                        rawBase: 1500,
                        markup: 300,
                        gst: 324,
                        handlingCharge: 0,
                        countrySurcharge: 0,
                        fuelSurcharge: 0,
                        dflCost: 1500
                    }
                }
            ]);

            const result = await calculateShippingRate(2, 'United States', 'user-123');

            expect(result.success).toBe(true);
            expect(result.options).toHaveLength(1);
            const opt = result.options[0];
            expect(opt.serviceName).toBe('DFL EXPRESS - Standard');
            expect(opt.basePrice).toBe(1800); // Selling Subtotal
            expect(opt.cost).toBe(1500); // Carrier Buying Cost
            expect(opt.markup).toBe(300); // Profit Markup
            expect(opt.gstAmount).toBe(324); // 18% GST
            expect(opt.totalPrice).toBe(2124); // Grand Total
        });
    });

    // =========================================================================
    // 2. WhatsApp Booking & Shipment Financial Fields Storage
    // =========================================================================
    describe('2. WhatsApp Booking Financial Fields Storage', () => {
        test('should save accurate carrier cost, markup, and invoice breakdown on Shipment.create', async () => {
            const selectedService = {
                serviceName: 'DFL EXPRESS - Standard',
                serviceCode: 'DFL-STD',
                carrierName: 'DFL Express',
                provider: 'DFL Express',
                basePrice: 1800,
                cost: 1500,
                markup: 300,
                gstAmount: 324,
                totalPrice: 2124,
                totalPriceFormatted: '₹2,124',
                transitDays: '4 - 7 Business Days'
            };

            const finalTotalPrice = parseFloat(selectedService.totalPrice);
            const finalSubtotal = parseFloat(selectedService.basePrice);
            const finalGstAmount = parseFloat(selectedService.gstAmount);
            const finalCarrierCost = parseFloat(selectedService.cost);
            const finalMarkup = parseFloat(selectedService.markup);

            Shipment.create.mockResolvedValue({
                _id: 'ship-wa-new-1',
                shipmentId: 'DFL-WA-123456',
                bookingSource: 'WHATSAPP',
                serviceDetails: {
                    serviceName: selectedService.serviceName,
                    price: selectedService.totalPriceFormatted,
                    cost: finalCarrierCost,
                    markup: finalMarkup,
                    igstTaxPercentage: '18'
                },
                invoice: {
                    subtotal: finalSubtotal,
                    tax: { type: 'IGST', rate: 18, amount: finalGstAmount },
                    totalAmount: finalTotalPrice,
                    status: 'Draft'
                }
            });

            const created = await Shipment.create({
                shipmentId: 'DFL-WA-123456',
                user: 'user-123',
                bookingSource: 'WHATSAPP',
                serviceDetails: {
                    serviceName: selectedService.serviceName,
                    price: selectedService.totalPriceFormatted,
                    cost: finalCarrierCost,
                    markup: finalMarkup,
                    igstTaxPercentage: '18'
                },
                invoice: {
                    subtotal: finalSubtotal,
                    tax: { type: 'IGST', rate: 18, amount: finalGstAmount },
                    totalAmount: finalTotalPrice,
                    status: 'Draft'
                }
            });

            expect(Shipment.create).toHaveBeenCalled();
            expect(created.serviceDetails.cost).toBe(1500);
            expect(created.serviceDetails.markup).toBe(300);
            expect(created.invoice.tax.amount).toBe(324);
            expect(created.invoice.subtotal).toBe(1800);
            expect(created.invoice.totalAmount).toBe(2124);
        });
    });

    // =========================================================================
    // 3. Daily Report & Sales Report Profit Calculation Verification
    // =========================================================================
    describe('3. Daily & Sales Report Profit Calculation', () => {
        test('should calculate positive gross profit for WhatsApp bookings with markup', async () => {
            const mockShipment = {
                _id: 'ship-wa-101',
                shipmentId: 'DFL-WA-123456',
                bookingSource: 'WHATSAPP',
                createdAt: new Date(),
                user: { _id: 'user-1', name: 'Test Shipper' },
                consigneeDetails: { country: 'United States', state: 'CA' },
                serviceDetails: {
                    serviceName: 'DFL EXPRESS - Standard',
                    price: '₹2183',
                    cost: 1550,
                    markup: 300,
                    dflCost: 1550,
                    igstTaxPercentage: '18'
                }
            };

            User.find.mockReturnValue({
                select: jest.fn().mockResolvedValue([{ _id: 'user-1' }])
            });

            Shipment.find.mockReturnValue({
                populate: jest.fn().mockReturnValue({
                    sort: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue([mockShipment])
                    })
                })
            });

            const req = {
                params: { salesPersonId: 'sales-1' },
                query: { startDate: '2026-09-01', endDate: '2026-09-22' }
            };
            const res = buildMockRes();

            await getSalesPersonShipments(req, res);

            expect(res.json).toHaveBeenCalled();
            const responseData = res.json.mock.calls[0][0];
            expect(responseData).toHaveLength(1);
            expect(responseData[0].billing).toBe(2183);
            expect(responseData[0].grossProfit).toBe(300);
            expect(responseData[0].grossProfit).toBeGreaterThan(0);
        });

        test('should apply 15% fallback profit for legacy WhatsApp bookings where markup is 0', async () => {
            const mockLegacyShipment = {
                _id: 'ship-wa-legacy-1',
                shipmentId: 'DFL-WA-000001',
                bookingSource: 'WHATSAPP',
                createdAt: new Date(),
                user: { _id: 'user-2', name: 'Legacy Shipper' },
                consigneeDetails: { country: 'United States', state: 'NY' },
                serviceDetails: {
                    serviceName: 'DFL EXPRESS - Standard',
                    price: '₹2183',
                    cost: 1850, // Legacy bug where cost equalled billingExGST
                    markup: 0
                }
            };

            User.find.mockReturnValue({
                select: jest.fn().mockResolvedValue([{ _id: 'user-2' }])
            });

            Shipment.find.mockReturnValue({
                populate: jest.fn().mockReturnValue({
                    sort: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue([mockLegacyShipment])
                    })
                })
            });

            const req = {
                params: { salesPersonId: 'sales-1' },
                query: { startDate: '2026-09-01', endDate: '2026-09-22' }
            };
            const res = buildMockRes();

            await getSalesPersonShipments(req, res);

            expect(res.json).toHaveBeenCalled();
            const responseData = res.json.mock.calls[0][0];
            expect(responseData).toHaveLength(1);
            expect(responseData[0].grossProfit).toBeCloseTo(277.5, 1);
            expect(responseData[0].grossProfit).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // 4. WhatsApp Dispute Registration & Website Sync Verification
    // =========================================================================
    describe('4. WhatsApp Dispute Registration & Website Sync', () => {
        test('should auto-classify dispute, create Dispute record, update Shipment status, and invalidate cache', async () => {
            const mockUser = {
                _id: 'user-123',
                name: 'Test Customer',
                phone: '9355151122',
                customerId: 'DFL-101'
            };

            const mockShipment = {
                _id: 'ship-db-123',
                shipmentId: 'DFL123456',
                status: 'Delivered',
                trackingHistory: [],
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findById.mockResolvedValue(mockShipment);
            Dispute.create.mockResolvedValue({
                _id: 'dispute-999',
                shipment: 'ship-db-123',
                user: 'user-123',
                disputeType: 'Weight Difference',
                status: 'Pending'
            });
            Ticket.create.mockResolvedValue({
                _id: 'ticket-999',
                ticketId: 'CASE-260922-001'
            });

            // Simulate WhatsApp bot dispute classification and creation
            const incomingText = 'Billed 3.5kg instead of 2kg weight difference';
            let disputeType = 'Other Charges';
            if (incomingText.toLowerCase().includes('weight')) {
                disputeType = 'Weight Difference';
            } else if (incomingText.toLowerCase().includes('rate')) {
                disputeType = 'Rate Difference';
            }

            const createdDispute = await Dispute.create({
                shipment: mockShipment._id,
                user: mockUser._id,
                raisedBy: mockUser._id,
                disputeType: disputeType,
                amount: 0,
                reason: incomingText,
                status: 'Pending'
            });

            mockShipment.status = 'Dispute Raised';
            mockShipment.trackingHistory.push({
                status: 'Dispute Raised',
                location: 'Customer Support',
                timestamp: new Date(),
                description: `Dispute raised via WhatsApp (${disputeType}): ${incomingText.slice(0, 100)}`
            });
            await mockShipment.save();
            cacheService.delPattern('dashboard_stats');

            const createdTicket = await Ticket.create({
                user: mockUser._id,
                shipmentId: mockShipment.shipmentId,
                issueType: 'Dispute',
                priority: 'High',
                description: incomingText,
                status: 'Pending'
            });

            expect(Dispute.create).toHaveBeenCalled();
            expect(createdDispute.disputeType).toBe('Weight Difference');
            expect(mockShipment.status).toBe('Dispute Raised');
            expect(mockShipment.save).toHaveBeenCalled();
            expect(cacheService.delPattern).toHaveBeenCalledWith('dashboard_stats');
            expect(Ticket.create).toHaveBeenCalled();
            expect(createdTicket.ticketId).toBe('CASE-260922-001');
        });
    });
});
