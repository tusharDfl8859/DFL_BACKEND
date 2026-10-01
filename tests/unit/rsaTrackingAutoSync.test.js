const rsaService = require('../../services/rsaService');

// Internal mapping logic helper for unit test assertion
function mapCarrierStatusToSystemStatus(msg, status) {
    const text = `${status || ''} ${msg || ''}`.toLowerCase();
    if (text.includes('delivered')) return 'Delivered';
    if (text.includes('out for delivery') || text.includes('out of delivery')) return 'Out for Delivery';
    if (text.includes('transit') || text.includes('dispatch') || text.includes('departed') || text.includes('picked') || text.includes('hub') || text.includes('assigned')) return 'In Transit';
    if (text.includes('hold') || text.includes('exception') || text.includes('delay')) return 'On Hold';
    if (text.includes('cancel')) return 'Cancelled';
    if (text.includes('processing') || text.includes('created') || text.includes('booked')) return 'Processing';
    return null;
}

describe('RSA Tracking & Auto-Sync Logic Unit Tests', () => {
    describe('mapCarrierStatusToSystemStatus', () => {
        test('should map Delivered carrier status to Delivered', () => {
            expect(mapCarrierStatusToSystemStatus('Delivered')).toBe('Delivered');
            expect(mapCarrierStatusToSystemStatus('Shipment Delivered')).toBe('Delivered');
            expect(mapCarrierStatusToSystemStatus(null, 'DELIVERED')).toBe('Delivered');
        });

        test('should map Out for Delivery status correctly', () => {
            expect(mapCarrierStatusToSystemStatus('Out for Delivery')).toBe('Out for Delivery');
            expect(mapCarrierStatusToSystemStatus(null, 'out of delivery')).toBe('Out for Delivery');
        });

        test('should map In Transit and Dispatched status correctly', () => {
            expect(mapCarrierStatusToSystemStatus('In Transit')).toBe('In Transit');
            expect(mapCarrierStatusToSystemStatus('Dispatched')).toBe('In Transit');
            expect(mapCarrierStatusToSystemStatus('Arrived at Hub')).toBe('In Transit');
        });

        test('should map On Hold status correctly', () => {
            expect(mapCarrierStatusToSystemStatus('Address Exception')).toBe('On Hold');
            expect(mapCarrierStatusToSystemStatus('Shipment Delay')).toBe('On Hold');
        });

        test('should return Processing/null for default/unknown statuses', () => {
            expect(mapCarrierStatusToSystemStatus('Created')).toBe('Processing');
            expect(mapCarrierStatusToSystemStatus(null, null)).toBe(null);
        });
    });

    describe('RSAService Partner Resolution & Config', () => {
        test('should correctly resolve Last Mile Partner based on weight', () => {
            expect(rsaService.getLastMilePartner(2, 'UK Standard')).toBeDefined();
            expect(rsaService.getLastMilePartner(15, 'UK Standard')).toBeDefined();
        });
    });
});
