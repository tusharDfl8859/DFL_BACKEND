const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Shipment = require('../models/Shipment');
const { generateInvoicePDF } = require('../utils/pdfGenerator');

async function finalSync() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Target Specific Shipments
        const targetIds = ['DFL54668755', 'DFL28050039'];
        
        // OR find ANY with mismatch before current date
        const shipments = await Shipment.find({
            createdAt: { $lt: new Date() }
        });

        console.log(`Auditing ${shipments.length} total shipments...`);

        let fixedCount = 0;
        let forceRegenerate = targetIds; // Explicitly force these two

        for (const shipment of shipments) {
            const servicePriceRaw = (shipment.serviceDetails?.price || '').replace(/[^0-9.]/g, '');
            const servicePriceNumeric = parseFloat(servicePriceRaw) || 0;
            const invoiceTotal = shipment.invoice?.totalAmount || 0;

            let shouldFix = forceRegenerate.includes(shipment.shipmentId) || 
                            (servicePriceNumeric > 0 && Math.abs(servicePriceNumeric - invoiceTotal) > 0.5);

            if (shouldFix) {
                console.log(`- Fixing ${shipment.shipmentId}: Price ${servicePriceNumeric} vs Invoice ${invoiceTotal}`);
                
                // 1. Sync Invoice Breakdown
                const igstRate = 0.18;
                const total = servicePriceNumeric;
                const subtotal = total / (1 + igstRate);
                const taxAmount = total - subtotal;

                shipment.invoice = {
                    ...shipment.invoice,
                    subtotal: Math.round(subtotal * 100) / 100,
                    totalAmount: Math.round(total * 100) / 100,
                    tax: {
                        ...shipment.invoice?.tax,
                        amount: Math.round(taxAmount * 100) / 100,
                        rate: 18,
                        type: 'IGST'
                    },
                    lineItems: [
                        { description: 'Shipping Charges', amount: Math.round(subtotal * 100) / 100 }
                    ]
                };

                // 2. Clear PDF to force regeneration
                shipment.invoice.pdfUrl = null;
                shipment.invoice.status = 'Draft';
                
                // 3. Update serviceDetails.cost to match
                shipment.serviceDetails.cost = Math.round(subtotal * 100) / 100;
                shipment.serviceDetails.markup = 0;
                shipment.serviceDetails.handling = 0;
                shipment.serviceDetails.countrySurcharge = 0;
                shipment.serviceDetails.fuelSurcharge = 0;

                // Sync status based on DB fields
                if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
                if (!shipment.shipmentDetails.invoiceNumber) {
                    shipment.shipmentDetails.invoiceNumber = 'NOT_PROVIDED';
                }

                await shipment.save({ validateBeforeSave: false });

                // 4. Force Regenerate PDF now
                try {
                   console.log(`  Regenerating PDF for ${shipment.shipmentId}...`);
                   const newPdfUrl = await generateInvoicePDF(shipment.invoice, shipment);
                   shipment.invoice.pdfUrl = newPdfUrl;
                   shipment.invoice.status = 'Generated';
                   await shipment.save({ validateBeforeSave: false });
                   console.log(`  Done: ${newPdfUrl}`);
                } catch (err) {
                   console.error(`  PDF Sync Error: ${err.message}`);
                }

                fixedCount++;
            }
        }

        console.log(`Final Sync complete. ${fixedCount} shipments fixed.`);
        await mongoose.disconnect();
    } catch (error) {
        console.error('Final Sync failed:', error);
        process.exit(1);
    }
}

finalSync();
