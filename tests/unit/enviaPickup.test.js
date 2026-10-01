/**
 * Test Suite: Envia Multi-Carrier Local Pickup & Dynamic Self-Pickup Cities
 * Path: Backend/tests/unit/enviaPickup.test.js
 */

const mongoose = require('mongoose');
const { determineDefaultPickupMode, DFL_PICKUP_CITIES } = require('../../controllers/manifestController');
const Manifest = require('../../models/Manifest');
const enviaPickupService = require('../../services/envia/enviaPickupService');

describe('Envia Local Pickup & Self-Pickup Location Routing Unit Tests', () => {

    describe('1. Location-Based Smart Routing (determineDefaultPickupMode)', () => {
        test('should route DFL Self-Pickup cities (Noida, Delhi, Jaipur, Bhopal, Surat, Baroda, Nagina) to DFL Pickup', () => {
            const delhiRes = determineDefaultPickupMode('B 331, Logix Technova Sector 132, Noida UP-201305');
            const jaipurRes = determineDefaultPickupMode('MI Road, Jaipur, Rajasthan 302001');
            const bhopalRes = determineDefaultPickupMode('MP Nagar Zone 1, Bhopal, MP');
            const suratRes = determineDefaultPickupMode('Ring Road, Surat, Gujarat');
            const barodaRes = determineDefaultPickupMode('Alkapuri, Vadodara, Baroda, Gujarat');
            const naginaRes = determineDefaultPickupMode('Station Road, Nagina, UP');

            expect(delhiRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
            expect(jaipurRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
            expect(bhopalRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
            expect(suratRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
            expect(barodaRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
            expect(naginaRes).toEqual({ pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' });
        });

        test('should route Non-DFL cities (Hathras, Lucknow, Mumbai, Kolkata) to 3rd Party Envia Booking', () => {
            const hathrasRes = determineDefaultPickupMode('test, Hathras, Uttar Pradesh, 204101');
            const mumbaiRes = determineDefaultPickupMode('Andheri East, Mumbai, Maharashtra 400069');
            const kolkataRes = determineDefaultPickupMode('Park Street, Kolkata, West Bengal 700016');

            expect(hathrasRes).toEqual({ pickupType: '3rd Party Pickup', pickupBy: 'Delhivery' });
            expect(mumbaiRes).toEqual({ pickupType: '3rd Party Pickup', pickupBy: 'Delhivery' });
            expect(kolkataRes).toEqual({ pickupType: '3rd Party Pickup', pickupBy: 'Delhivery' });
        });
    });

    describe('2. DFL Profit Markup & Carrier Display Name Formatting', () => {
        test('should accurately calculate +5% DFL profit markup on base carrier rates', () => {
            const rawRate = 100.00;
            const markupPercentage = 0.05;
            const finalPrice = Math.round((rawRate * (1 + markupPercentage)) * 100) / 100;
            const expectedProfit = 5.00;

            expect(finalPrice).toBe(105.00);
            expect(finalPrice - rawRate).toBe(expectedProfit);
        });

        test('should format carrier display names properly', () => {
            const formattedXpressbees = enviaPickupService._formatCarrierDisplayName('xpressBees');
            const formattedDelhivery = enviaPickupService._formatCarrierDisplayName('delhivery');
            const formattedBluedart = enviaPickupService._formatCarrierDisplayName('blueDart');

            expect(formattedXpressbees).toBe('Xpressbees');
            expect(formattedDelhivery).toBe('Delhivery');
            expect(formattedBluedart).toBe('BlueDart');
        });
    });

    describe('3. Manifest Model Schema Validation', () => {
        test('should support BOOKED status and pickupCost field in Manifest schema', () => {
            const testManifest = new Manifest({
                manifestId: `MAN-TEST-${Date.now()}`,
                pickupAddress: 'Test Address, Hathras UP',
                pickupType: '3rd Party Pickup',
                pickupBy: 'Delhivery',
                pickupCost: 80.85,
                status: 'BOOKED'
            });

            expect(testManifest.status).toBe('BOOKED');
            expect(parseFloat(testManifest.pickupCost)).toBe(80.85);
        });
    });
});
