const {
    normalizeShipmentServiceDetails,
    resolveServiceConfigSnapshot
} = require('../../utils/shipmentServiceDetails');
const { mapRowToShipment } = require('../../utils/bulkShipmentMapper');

describe('Shared Shipment serviceDetails normalization', () => {
    test('resolves exact configured service pair into backend-owned routing fields', () => {
        const snapshot = resolveServiceConfigSnapshot({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100'
        });

        expect(snapshot).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            providerKey: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: 1,
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json'
        });
    });

    test('normalizes Dashboard serviceDetails to the shared persisted shape', () => {
        const serviceDetails = normalizeShipmentServiceDetails({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'customer-supplied-provider',
            carrierName: 'customer-supplied-carrier',
            carrierCode: 999,
            price: '500.50',
            dflCost: 500.5,
            eta: '7-8 Business Days',
            chargeableWeight: 1.5
        });

        expect(serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: 1,
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json',
            price: '500.50',
            dflCost: 500.5,
            eta: '7-8 Business Days',
            chargeableWeight: '1.5',
            cost: 0
        });
    });

    test('normalizes bulk mapped shipments to the shared persisted shape', () => {
        const shipment = mapRowToShipment(
            {
                service: 'DFL EXPRESS - Standard',
                service_code: 'DFLS100',
                consignee_shipping_firstname: 'Bulk',
                consignee_shipping_lastname: 'Customer',
                consignee_shipping_email: 'bulk@example.com',
                consignee_shipping_mobile: '9876543210',
                consignee_shipping_address: 'Bulk Address',
                consignee_shipping_city: 'New York',
                consignee_shipping_state: 'NY',
                consignee_shipping_country_code: 'US',
                consignee_shipping_postcode: '10001',
                package_weight: 1.5,
                package_length: 20,
                package_breadth: 15,
                package_height: 10,
                vendor_order_item_name: 'Bulk Product',
                vendor_order_item_quantity: 1,
                vendor_order_item_unit_price: 100,
                vendor_order_item_hsn: '6109',
                invoice_no: 'BULK-INV-1',
                invoice_date: '01-09-2026',
                order_reference: 'BULK-ORDER-1'
            },
            {
                _id: '64f000000000000000000001',
                name: 'Bulk User',
                email: 'bulk-user@example.com',
                phone: '9876543210',
                kycData: { billingAddress: {} }
            },
            {
                _id: '64f000000000000000000002',
                bulkOrderId: 'BULK-1'
            },
            {
                finalPrice: 500.5,
                matchedRate: {
                    serviceName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFLS100',
                    zoneCode: 'TUS1',
                    transitTime: '7-8 Working Days',
                    carrierCode: 1
                },
                chargeableWeight: 1.5,
                breakdown: {
                    baseRate: 400,
                    markup: 50,
                    handlingCharge: 10,
                    countrySurcharge: 20,
                    fuelSurcharge: 20,
                    taxRate: 18,
                    gst: 0
                },
                resolvedProvider: 'TPL',
                matchedServiceConfig: {
                    displayName: 'DFL EXPRESS - Standard',
                    serviceCode: 'DFLS100',
                    code: 'TUS1',
                    zone: 1,
                    carrierCode: 1,
                    transitTime: '7-8 Working Days'
                }
            }
        );

        expect(shipment.serviceDetails).toMatchObject({
            serviceName: 'DFL EXPRESS - Standard',
            serviceCode: 'DFLS100',
            provider: 'TPL',
            carrierName: 'TPL',
            carrierCode: 1,
            code: 'TUS1',
            zone: 1,
            configId: 'TPL:DFLS100',
            configVersion: 'service_config.json',
            price: '500.5',
            dflCost: 400,
            eta: '7-8 Business Days',
            chargeableWeight: '1.5',
            cost: 400
        });
    });
});
