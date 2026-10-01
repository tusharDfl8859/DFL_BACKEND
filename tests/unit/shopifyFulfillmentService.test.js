const axios = require('axios');
jest.mock('axios');

jest.mock('../../services/shopifyAuthService', () => ({
    getValidAccessToken: jest.fn().mockResolvedValue('test-access-token')
}));

const shopifyFulfillmentService = require('../../services/shopifyFulfillmentService');

describe('ShopifyFulfillmentService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('mapStatusToShopifyEvent', () => {
        it('maps delivered statuses to delivered', () => {
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Delivered')).toBe('delivered');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Delivered to recipient')).toBe('delivered');
        });

        it('maps out for delivery to out_for_delivery', () => {
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Out for Delivery')).toBe('out_for_delivery');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('out_for_delivery')).toBe('out_for_delivery');
        });

        it('maps cancel and failure statuses to failure', () => {
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Cancelled')).toBe('failure');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('RTO')).toBe('failure');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Failed Attempt')).toBe('attempted_delivery');
        });

        it('maps transit, dispatched, hub milestones to in_transit', () => {
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('In Transit')).toBe('in_transit');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Shipment Received at Our Hub')).toBe('in_transit');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Shipment Dispatched')).toBe('in_transit');
        });

        it('maps initial pending and booked states to label_printed', () => {
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Pending')).toBe('label_printed');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Booked')).toBe('label_printed');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Processing')).toBe('label_printed');
        });
    });

    describe('cancelShopifyOrder', () => {
        it('calls Shopify cancel order endpoint', async () => {
            axios.post.mockResolvedValueOnce({ data: { order: { id: 123456, cancelled_at: '2026-09-11T00:00:00Z' } } });

            const result = await shopifyFulfillmentService.cancelShopifyOrder('test-store.myshopify.com', '123456', 'customer');

            expect(result.success).toBe(true);
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/orders/123456/cancel.json'),
                { reason: 'customer', email: false },
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Shopify-Access-Token': 'test-access-token'
                    })
                })
            );
        });

        it('handles Shopify cancel error gracefully without throwing', async () => {
            axios.post.mockRejectedValueOnce(new Error('Order already cancelled'));

            const result = await shopifyFulfillmentService.cancelShopifyOrder('test-store.myshopify.com', '123456');

            expect(result.success).toBe(false);
            expect(result.message).toContain('Order already cancelled');
        });
    });

    describe('syncShopifyOrderTracking with cancellation', () => {
        it('cancels order on Shopify and sets syncStatus to cancelled when shipment is Cancelled', async () => {
            axios.post.mockResolvedValue({ data: { order: { id: 999 } } });

            const mockOrder = {
                shopDomain: 'test-store.myshopify.com',
                shopifyOrderId: '999',
                orderNumber: '1046',
                shopifyFulfillmentId: 'ful_123',
                syncStatus: 'fulfilled',
                lastTrackingStatus: 'Booked',
                save: jest.fn().mockResolvedValue(true)
            };

            const mockShipment = {
                _id: 'ship_id_1',
                status: 'Cancelled',
                trackingHistory: []
            };

            await shopifyFulfillmentService.syncShopifyOrderTracking(mockOrder, mockShipment);

            expect(mockOrder.syncStatus).toBe('cancelled');
            expect(mockOrder.lastTrackingStatus).toBe('Cancelled');
            expect(mockOrder.save).toHaveBeenCalled();
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/orders/999/cancel.json'),
                expect.any(Object),
                expect.any(Object)
            );
        });
    });

    describe('updateShopifyOrderTags', () => {
        it('updates order tags to include the new status name while cleaning old status tags', async () => {
            axios.get.mockResolvedValueOnce({
                data: {
                    order: {
                        id: 123456,
                        tags: 'VIP, Status: OldStatus, priority'
                    }
                }
            });
            axios.put.mockResolvedValueOnce({ data: { order: { id: 123456, tags: 'VIP, priority, Status: Pending' } } });

            const result = await shopifyFulfillmentService.updateShopifyOrderTags('test-store.myshopify.com', '123456', 'Pending');

            expect(result.success).toBe(true);
            expect(result.tags).toBe('VIP, priority, Status: Pending');
            expect(axios.put).toHaveBeenCalledWith(
                expect.stringContaining('/orders/123456.json'),
                {
                    order: {
                        id: '123456',
                        tags: 'VIP, priority, Status: Pending'
                    }
                },
                expect.any(Object)
            );
        });
    });

    describe('Dynamic configuration & Sensitive Info protection', () => {
        it('supports dynamic mapping overrides via SHOPIFY_STATUS_MAPPINGS env var', () => {
            const originalEnv = process.env.SHOPIFY_STATUS_MAPPINGS;
            process.env.SHOPIFY_STATUS_MAPPINGS = JSON.stringify({
                'Custom_Held': 'attempted_delivery',
                'Custom_Flight': 'in_transit'
            });

            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Custom_Held')).toBe('attempted_delivery');
            expect(shopifyFulfillmentService.mapStatusToShopifyEvent('Custom_Flight_Departed')).toBe('in_transit');

            process.env.SHOPIFY_STATUS_MAPPINGS = originalEnv;
        });

        it('redacts sensitive tokens, passwords, and API keys without leaking auth in logs or errors', async () => {
            axios.post.mockRejectedValueOnce({
                response: {
                    data: {
                        errors: 'Access denied: token=shpat_secret1234567890abcdef987654321, Bearer: super_secret_jwt_auth_token_value'
                    }
                }
            });

            const result = await shopifyFulfillmentService.cancelShopifyOrder('test-store.myshopify.com', '123456');

            expect(result.success).toBe(false);
            expect(result.error).not.toContain('shpat_secret1234567890abcdef987654321');
            expect(result.error).toContain('[REDACTED');
        });
    });
});

