const {
    calculatePickupDelay,
    calculateDispatchDelay,
    calculateDeliveryDelay,
    evaluateShipmentDelays,
    formatDelayTime
} = require('../../utils/shipmentDelayCalculator');

describe('Shipment Delay Calculator Unit Tests', () => {
    const fixedNow = new Date('2026-09-07T12:00:00Z');

    describe('formatDelayTime helper', () => {
        test('should format hours into day and hour format correctly', () => {
            expect(formatDelayTime(0)).toBe('0h');
            expect(formatDelayTime(15)).toBe('15h');
            expect(formatDelayTime(24)).toBe('1d 0h');
            expect(formatDelayTime(52)).toBe('2d 4h');
        });
    });

    describe('calculatePickupDelay', () => {
        test('should detect pickup delay when scheduled pickup date was yesterday and shipment is Pending', () => {
            const shipment = {
                status: 'Pending',
                shipperDetails: { date: '2026-09-05T10:00:00Z' },
                pickupDetails: { status: 'Pending' }
            };

            const result = calculatePickupDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(true);
            expect(result.delayHours).toBeGreaterThan(0);
            expect(result.delayText).toMatch(/overdue/i);
        });

        test('should NOT flag pickup delay if shipment is already Picked Up or In Transit', () => {
            const shipment = {
                status: 'In Transit',
                shipperDetails: { date: '2026-09-05T10:00:00Z' },
                pickupDetails: { status: 'Picked Up' }
            };

            const result = calculatePickupDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(false);
        });

        test('should NOT flag pickup delay for Cancelled or Delivered shipments', () => {
            const cancelledShipment = {
                status: 'Cancelled',
                shipperDetails: { date: '2026-09-01T10:00:00Z' }
            };
            expect(calculatePickupDelay(cancelledShipment, fixedNow).isDelayed).toBe(false);
        });
    });

    describe('calculateDispatchDelay', () => {
        test('should detect dispatch delay when shipment at hub exceeds 24 hours', () => {
            const shipment = {
                status: 'Shipment Received at Our Hub',
                trackingHistory: [
                    { status: 'Shipment Received at Our Hub', timestamp: new Date('2026-09-05T08:00:00Z') }
                ]
            };

            const result = calculateDispatchDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(true);
            expect(result.totalHubHours).toBe(52); // 52 hours > 24 hours
            expect(result.delayText).toMatch(/2d 4h at Hub/i);
        });

        test('should NOT flag dispatch delay if shipment was received at hub less than 24 hours ago', () => {
            const shipment = {
                status: 'Shipment Received at Our Hub',
                trackingHistory: [
                    { status: 'Shipment Received at Our Hub', timestamp: new Date('2026-09-07T02:00:00Z') }
                ]
            };

            const result = calculateDispatchDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(false);
        });

        test('should NOT flag dispatch delay if shipment is already Dispatched', () => {
            const shipment = {
                status: 'Shipment Dispatched',
                trackingHistory: [
                    { status: 'Shipment Received at Our Hub', timestamp: new Date('2026-09-01T08:00:00Z') },
                    { status: 'Shipment Dispatched', timestamp: new Date('2026-09-03T08:00:00Z') }
                ]
            };

            const result = calculateDispatchDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(false);
        });
    });

    describe('calculateDeliveryDelay', () => {
        test('should detect delivery delay when ETA (5d) + 2 grace days has passed', () => {
            const shipment = {
                status: 'In Transit',
                createdAt: new Date('2026-08-25T10:00:00Z'),
                serviceDetails: { eta: '4-5 Days' },
                trackingHistory: [
                    { status: 'Shipment Dispatched', timestamp: new Date('2026-08-26T10:00:00Z') }
                ]
            };

            const result = calculateDeliveryDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(true);
            expect(result.delayDays).toBeGreaterThan(0);
            expect(result.delayText).toMatch(/past SLA/i);
        });

        test('should NOT flag delivery delay if shipment is Delivered', () => {
            const shipment = {
                status: 'Delivered',
                createdAt: new Date('2026-08-25T10:00:00Z'),
                serviceDetails: { eta: '4-5 Days' }
            };

            const result = calculateDeliveryDelay(shipment, fixedNow);
            expect(result.isDelayed).toBe(false);
        });
    });

    describe('evaluateShipmentDelays', () => {
        test('should categorize pickup delay correctly', () => {
            const shipment = {
                status: 'Pending',
                shipperDetails: { date: '2026-09-05T10:00:00Z' }
            };

            const evalResult = evaluateShipmentDelays(shipment, fixedNow);
            expect(evalResult.isDelayed).toBe(true);
            expect(evalResult.delayType).toBe('pickup_delay');
            expect(evalResult.primaryText).toMatch(/^Pickup:/);
        });

        test('should categorize dispatch delay correctly when unpicked condition is false', () => {
            const shipment = {
                status: 'Shipment Received at Our Hub',
                trackingHistory: [
                    { status: 'Shipment Received at Our Hub', timestamp: new Date('2026-09-04T08:00:00Z') }
                ]
            };

            const evalResult = evaluateShipmentDelays(shipment, fixedNow);
            expect(evalResult.isDelayed).toBe(true);
            expect(evalResult.delayType).toBe('dispatch_delay');
            expect(evalResult.primaryText).toMatch(/^Hub:/);
        });

        test('should return isDelayed false when no delay criteria are met', () => {
            const shipment = {
                status: 'In Transit',
                createdAt: new Date('2026-09-06T10:00:00Z'),
                serviceDetails: { eta: '5 Days' }
            };

            const evalResult = evaluateShipmentDelays(shipment, fixedNow);
            expect(evalResult.isDelayed).toBe(false);
            expect(evalResult.delayType).toBeNull();
        });
    });
});
