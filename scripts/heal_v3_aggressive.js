const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Shipment = require('../models/Shipment');

async function healV3() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Target Date: DFL58910254 (Apr 4th)
        const targetDate = new Date('2026-04-05T00:00:00Z'); 

        const affectedShipments = await Shipment.find({
            createdAt: { $lt: targetDate },
            $or: [
                { 'serviceDetails.carrierName': 'DFL EXPRESS' },
                { 'invoice.totalAmount': { $exists: true } }
            ]
        });

        console.log(`Found ${affectedShipments.length} potential shipments to audit.`);

        let healedCount = 0;
        let syncedCount = 0;

        for (const shipment of affectedShipments) {
            let updated = false;

            // 1. Audit Price Mismatch (Shipment Price vs Invoice Total)
            const servicePriceRaw = shipment.serviceDetails?.price || '';
            const servicePriceNumeric = parseFloat(servicePriceRaw.replace(/[^0-9.]/g, '')) || 0;
            const invoiceTotal = shipment.invoice?.totalAmount || 0;

            if (servicePriceNumeric > 0 && Math.abs(servicePriceNumeric - invoiceTotal) > 1) {
                console.log(`- Auditing ${shipment.shipmentId}: Price Mismatch (${servicePriceNumeric} vs ${invoiceTotal})`);
                
                // Sync Invoice Breakdown
                const igstRate = 0.18;
                const subtotal = servicePriceNumeric / (1 + igstRate);
                const taxAmount = servicePriceNumeric - subtotal;

                // Update Invoice Object
                shipment.invoice = {
                    ...shipment.invoice,
                    subtotal: Math.round(subtotal * 100) / 100,
                    totalAmount: Math.round(servicePriceNumeric * 100) / 100,
                    tax: {
                        ...shipment.invoice?.tax,
                        amount: Math.round(taxAmount * 100) / 100
                    },
                    lineItems: [
                        { description: 'Shipping Charges', amount: Math.round(subtotal * 100) / 100 }
                    ]
                };

                // Also ensure serviceDetails has the breakdown for the UI
                if (!shipment.serviceDetails.cost || shipment.serviceDetails.cost === 0) {
                    const baseSum = subtotal;
                    const markup = baseSum * 0.10; // estimate 10% markup if unknown
                    const cost = baseSum - markup;

                    shipment.serviceDetails.cost = Math.round(cost * 100) / 100;
                    shipment.serviceDetails.markup = Math.round(markup * 100) / 100;
                    shipment.serviceDetails.handling = 0;
                    shipment.serviceDetails.countrySurcharge = 0;
                    shipment.serviceDetails.fuelSurcharge = 0;
                }

                syncedCount++;
                updated = true;
            }

            // 2. Restore Carrier Name if still DFL EXPRESS
            if (shipment.serviceDetails?.carrierName === 'DFL EXPRESS' || !shipment.serviceDetails?.carrierName) {
                const serviceName = (shipment.serviceDetails?.serviceName || '').toLowerCase();
                const provider = (shipment.trackingCarrier || '').toLowerCase();

                let inferredCarrier = 'DFL EXPRESS';
                if (serviceName.includes('skynet')) inferredCarrier = 'Skynet';
                else if (serviceName.includes('fedex')) inferredCarrier = 'FedEx';
                else if (serviceName.includes('dhl')) inferredCarrier = 'DHL';
                else if (serviceName.includes('tpl')) inferredCarrier = 'TPL';
                else if (provider === 'tpl') inferredCarrier = 'TPL';
                else if (provider === 'united') inferredCarrier = 'United';
                else if (provider === 'skynet') inferredCarrier = 'Skynet';
                else {
                    // DEFAULT HEURISTIC: In your logs, most DFL EXPRESS - Standard/Priority are Skynet-based
                    inferredCarrier = 'Skynet'; 
                }

                if (inferredCarrier !== shipment.serviceDetails?.carrierName) {
                    shipment.serviceDetails.carrierName = inferredCarrier;
                    updated = true;
                    healedCount++;
                }
            }

            if (updated) {
                await shipment.save({ validateBeforeSave: false });
            }
        }

        console.log(`Audit complete! Synced ${syncedCount} Invoices. Healed ${healedCount} Carriers.`);
        await mongoose.disconnect();
    } catch (error) {
        console.error('Audit failed:', error);
        process.exit(1);
    }
}

healV3();
