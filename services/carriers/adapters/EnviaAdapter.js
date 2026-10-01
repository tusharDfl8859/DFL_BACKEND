/**
 * EnviaAdapter - Envia 3rd-Party Carrier Adapter
 * Integrates Envia Shipping API for automated 3rd-party pickups, bookings, and manifests.
 */

const { BaseCarrierAdapter, CarrierAPIError } = require('./BaseCarrierAdapter');
const carrierConfig = require('../../../config/carrierConfig');
const { enviaPickupService } = require('../../envia');

class EnviaAdapter extends BaseCarrierAdapter {
    constructor() {
        super(carrierConfig.ENVIA || {});
        this.carrierName = 'ENVIA';
    }

    /**
     * Book a shipment or inward pickup with Envia
     */
    async book(shipment, user) {
        try {
            const { shipperDetails, consigneeDetails, shipmentDetails } = shipment;
            const boxes = shipmentDetails?.boxes || [];

            const packages = boxes.map(b => ({
                content: b.productDescription || shipmentDetails?.productDescription || 'Courier Box',
                amount: 1,
                type: 'box',
                dimensions: {
                    length: parseFloat(b.length || 20),
                    width: parseFloat(b.width || 15),
                    height: parseFloat(b.height || 10)
                },
                weight: Math.max(0.5, parseFloat(b.weight || 1)),
                declaredValue: Math.max(100, parseFloat(shipmentDetails?.totalItemValue || 500)),
                weightUnit: 'KG',
                lengthUnit: 'CM'
            }));

            const origin = {
                name: shipperDetails?.shipperName || user?.name || 'Sender',
                company: shipperDetails?.companyName || user?.companyName || '',
                email: shipperDetails?.email || user?.email || '',
                phone: shipperDetails?.mobileNo || user?.phone || '',
                street: shipperDetails?.addressLine1 || shipperDetails?.address || '',
                city: shipperDetails?.city || '',
                state: shipperDetails?.state || '',
                postalCode: shipperDetails?.pincode || ''
            };

            const payload = {
                origin: {
                    name: origin.name,
                    company: origin.company,
                    email: origin.email,
                    phone: String(origin.phone).replace(/\D+/g, '').slice(-10),
                    street: origin.street,
                    city: origin.city,
                    state: enviaPickupService._normalizeStateCode(origin.state),
                    country: 'IN',
                    postalCode: String(origin.postalCode).replace(/\s+/g, '')
                },
                destination: {
                    name: consigneeDetails?.consigneeName || 'Consignee',
                    company: consigneeDetails?.companyName || '',
                    email: consigneeDetails?.email || '',
                    phone: String(consigneeDetails?.mobileNo || '').replace(/\D+/g, '').slice(-10),
                    street: consigneeDetails?.addressLine1 || '',
                    city: consigneeDetails?.city || '',
                    state: enviaPickupService._normalizeStateCode(consigneeDetails?.state),
                    country: consigneeDetails?.countryCode || 'IN',
                    postalCode: String(consigneeDetails?.pincode || '').replace(/\s+/g, '')
                },
                packages: packages.length > 0 ? packages : [{
                    content: 'Courier Box',
                    amount: 1,
                    type: 'box',
                    dimensions: { length: 20, width: 15, height: 10 },
                    weight: 2,
                    declaredValue: 500,
                    weightUnit: 'KG',
                    lengthUnit: 'CM'
                }],
                shipment: {
                    carrier: (shipment.serviceDetails?.carrier || 'delhivery').toLowerCase(),
                    service: 'ground',
                    type: 1
                },
                settings: {
                    currency: 'INR',
                    printFormat: 'PDF',
                    printSize: 'STOCK_4X6'
                }
            };

            const { data } = await this.callAPI('/ship/generate/', payload);
            const labelData = Array.isArray(data?.data) ? data.data[0] : (data?.data || {});

            const awbNo = labelData.trackingNumber || labelData.tracking_number || '';
            const labelUrl = labelData.label || labelData.labelUrl || '';
            const trackingUrl = labelData.trackUrl || labelData.trackingUrl || '';

            return {
                awbNo: awbNo,
                forwardingNo: awbNo,
                label: labelUrl,
                labelUrl: labelUrl,
                trackingUrl: trackingUrl,
                carrierRef: String(labelData.shipmentId || awbNo),
                message: 'Booking generated successfully via Envia'
            };
        } catch (error) {
            throw new CarrierAPIError(
                this.carrierName,
                error.message || 'Envia booking failed',
                error.status || 500,
                error.details || null
            );
        }
    }

    /**
     * Track a shipment via Envia
     */
    async track(awb) {
        try {
            return await enviaPickupService.track(awb);
        } catch (error) {
            throw new CarrierAPIError(
                this.carrierName,
                error.message || 'Envia tracking failed',
                error.status || 500,
                error.details || null
            );
        }
    }

    /**
     * Generate carrier manifest document via Envia
     */
    async manifest(shipments) {
        try {
            const trackingNumbers = Array.isArray(shipments)
                ? shipments.map(s => typeof s === 'string' ? s : (s.awbNo || s.trackingNumber || s.awbNumber)).filter(Boolean)
                : [];

            if (trackingNumbers.length === 0) {
                throw new Error('At least one tracking number is required to generate a manifest');
            }

            const { data } = await this.callAPI('/ship/manifest', {
                trackingNumbers: trackingNumbers
            });

            const manifestData = data?.data || {};
            return {
                manifestId: manifestData.manifestId || '',
                manifestPdf: manifestData.manifestUrl || '',
                manifestUrl: manifestData.manifestUrl || ''
            };
        } catch (error) {
            throw new CarrierAPIError(
                this.carrierName,
                error.message || 'Envia manifest generation failed',
                error.status || 500,
                error.details || null
            );
        }
    }
}

module.exports = EnviaAdapter;
