const Shipment = require('../../models/Shipment');
const SystemConfig = require('../../models/SystemConfig');
const {
    calculateShipmentWeight,
    resolveMonthlySlab,
    DEFAULT_REWARD_SETTINGS,
    buildPartnerRewardSummary
} = require('../../controllers/partnerPortalController');

jest.mock('../../models/Shipment');
jest.mock('../../models/SystemConfig');

describe('Franchise Incentive & Reward Calculation Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Weight Calculation helper', () => {
        it('should use chargeableWeight when provided', () => {
            const shipment = {
                serviceDetails: { chargeableWeight: '0.95' },
                shipmentDetails: { boxes: [{ weight: 2 }] }
            };
            expect(calculateShipmentWeight(shipment)).toBe(0.95);
        });

        it('should calculate volumetric weight max when chargeableWeight is missing', () => {
            // Box 10 x 10 x 10 / 5000 = 0.2 kg, actual = 0.5 kg -> max is 0.5 kg
            const shipment = {
                shipmentDetails: {
                    boxes: [{ length: 10, width: 10, height: 10, weight: 0.5 }]
                }
            };
            expect(calculateShipmentWeight(shipment)).toBe(0.5);
        });
    });

    describe('Email Test Specification: Sample Weights Verification', () => {
        const sampleWeights = [
            { label: '50g', weightKg: 0.05, expectedBand: 'under1Kg', expectedIncentive: 20 },
            { label: '250g', weightKg: 0.25, expectedBand: 'under1Kg', expectedIncentive: 20 },
            { label: '500g', weightKg: 0.50, expectedBand: 'under1Kg', expectedIncentive: 20 },
            { label: '950g', weightKg: 0.95, expectedBand: 'under1Kg', expectedIncentive: 20 },
            { label: '999g', weightKg: 0.999, expectedBand: 'under1Kg', expectedIncentive: 20 },
            { label: '1000g (Boundary)', weightKg: 1.000, expectedBand: 'above1Kg', expectedIncentive: 20.00 },
            { label: '1001g', weightKg: 1.001, expectedBand: 'above1Kg', expectedIncentive: 20.02 },
            { label: '1.5kg', weightKg: 1.500, expectedBand: 'above1Kg', expectedIncentive: 30.00 }
        ];

        sampleWeights.forEach(({ label, weightKg, expectedBand, expectedIncentive }) => {
            it(`should correctly evaluate ${label} (${weightKg} kg): band=${expectedBand}, incentive=Rs. ${expectedIncentive}`, async () => {
                SystemConfig.findOne.mockReturnValue({
                    lean: () => Promise.resolve(null) // Falls back to DEFAULT_REWARD_SETTINGS
                });

                const mockShipment = {
                    _id: 'sample_shipment_1',
                    shipmentId: 'SHP-TEST-1',
                    serviceDetails: { chargeableWeight: weightKg },
                    createdAt: new Date('2026-10-05T10:00:00+05:30') // After effectiveDate
                };

                Shipment.find.mockReturnValue({
                    select: () => ({
                        lean: () => Promise.resolve([mockShipment])
                    })
                });

                const summary = await buildPartnerRewardSummary('partner123');
                const month = summary.monthlyBreakdown[0];

                if (expectedBand === 'under1Kg') {
                    expect(month.under1KgCount).toBe(1);
                    expect(month.under1KgPayout).toBe(expectedIncentive);
                    expect(month.above1KgWeight).toBe(0);
                    expect(month.above1KgPayout).toBe(0);
                } else {
                    expect(month.under1KgCount).toBe(0);
                    expect(month.under1KgPayout).toBe(0);
                    expect(month.above1KgWeight).toBe(weightKg);
                    expect(month.above1KgPayout).toBe(expectedIncentive);
                }

                expect(month.payout).toBe(expectedIncentive);
            });
        });
    });

    describe('Effective Date and Backwards Compatibility', () => {
        it('should keep legacy slab calculation for shipments before effectiveDate', async () => {
            SystemConfig.findOne.mockReturnValue({
                lean: () => Promise.resolve(null)
            });

            // Shipment created before effective date (e.g., September 2026) with weight 0.5 kg
            const legacyShipment = {
                _id: 'legacy_1',
                shipmentId: 'SHP-LEGACY-1',
                serviceDetails: { chargeableWeight: 0.5 },
                createdAt: new Date('2026-09-15T10:00:00+05:30')
            };

            Shipment.find.mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve([legacyShipment])
                })
            });

            const summary = await buildPartnerRewardSummary('partner123');
            const month = summary.monthlyBreakdown[0];

            // Under legacy policy, 0.5 kg was under minimum slab minKg: 1
            // So ratePerKg = 0, payout = 0 (or prorated slab), under1KgCount is 0
            expect(month.under1KgCount).toBe(0);
            expect(month.legacyKg).toBe(0.5);
            expect(month.under1KgPayout).toBe(0);
        });

        it('should correctly combine both under-1kg and above-1kg shipments in the same month', async () => {
            SystemConfig.findOne.mockReturnValue({
                lean: () => Promise.resolve(null)
            });

            const shipments = [
                // 3 shipments under 1kg (e.g. 50g, 250g, 500g) -> 3 * 20 = Rs. 60
                { _id: 's1', shipmentId: 'SHP-1', serviceDetails: { chargeableWeight: 0.05 }, createdAt: new Date('2026-10-02') },
                { _id: 's2', shipmentId: 'SHP-2', serviceDetails: { chargeableWeight: 0.25 }, createdAt: new Date('2026-10-03') },
                { _id: 's3', shipmentId: 'SHP-3', serviceDetails: { chargeableWeight: 0.50 }, createdAt: new Date('2026-10-04') },
                // 1 shipment above 1kg (e.g. 10 kg) -> 10 kg * Rs. 20 (base slab) = Rs. 200
                { _id: 's4', shipmentId: 'SHP-4', serviceDetails: { chargeableWeight: 10 }, createdAt: new Date('2026-10-05') }
            ];

            Shipment.find.mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(shipments)
                })
            });

            const summary = await buildPartnerRewardSummary('partner123');
            const month = summary.monthlyBreakdown[0];

            expect(month.under1KgCount).toBe(3);
            expect(month.under1KgPayout).toBe(60);
            expect(month.above1KgWeight).toBe(10);
            expect(month.above1KgPayout).toBe(200);
            expect(month.payout).toBe(260); // 60 + 200 = 260
        });
    });
});
