const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Shipment = require('../models/Shipment');
const { generateInvoicePDF } = require('../utils/pdfGenerator');

async function finalSync() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Audit ANY with mismatch
        const shipments = await Shipment.find({
            createdAt: { $lt: new Date() }
        });

        console.log(`Deep auditing ${shipments.length} total shipments...`);

        let fixedCount = 0;
        const forceIds = ['DFL28050039', 'DFL54668755'];

        for (const shipment of shipments) {
            const priceStr = (shipment.serviceDetails?.price || '').replace(/[^0-9.]/g, '');
            const price = parseFloat(priceStr) || 0;
            const currentInvoiceTotal = shipment.invoice?.totalAmount || 0;

            const isMismatch = price > 0 && Math.abs(price - currentInvoiceTotal) > 0.5;
            const isTarget = forceIds.includes(shipment.shipmentId);

            if (isMismatch || isTarget) {
                console.log(`- Auditing ${shipment.shipmentId}: ${price} vs ${currentInvoiceTotal}`);
                
                const igstRate = 0.18;
                const total = price;
                const subtotal = total / (1 + igstRate);
                const taxAmount = total - subtotal;

                // SAFER UPDATE (Don't overwrite the whole invoice object)
                shipment.invoice.subtotal = Math.round(subtotal * 100) / 100;
                shipment.invoice.totalAmount = Math.round(total * 100) / 100;
                
                if (!shipment.invoice.tax) shipment.invoice.tax = { type: 'IGST', rate: 18, amount: 0 };
                shipment.invoice.tax.amount = Math.round(taxAmount * 100) / 100;
                shipment.invoice.tax.rate = 18;
                shipment.invoice.tax.type = 'IGST';

                shipment.invoice.lineItems = [
                    { description: 'Shipping Charges', amount: Math.round(subtotal * 100) / 100 }
                ];

                // Sync Service Details Cost
                shipment.serviceDetails.cost = Math.round(subtotal * 100) / 100;
                shipment.serviceDetails.markup = 0;
                shipment.serviceDetails.handling = 0;
                shipment.serviceDetails.countrySurcharge = 0;
                shipment.serviceDetails.fuelSurcharge = 0;

                shipment.invoice.pdfUrl = null;
                shipment.invoice.status = 'Draft';

                // Ensure essential ID exists
                if (!shipment.invoice.invoiceId) {
                   shipment.invoice.invoiceId = `INV-${shipment.shipmentId || shipment._id}`;
                }

                await shipment.save({ validateBeforeSave: false });

                // Force Regenerate
                try {
                   console.log(`  Syncing PDF for ${shipment.shipmentId}...`);
                   const newPdfUrl = await generateInvoicePDF(shipment.invoice, shipment);
                   shipment.invoice.pdfUrl = newPdfUrl;
                   shipment.invoice.status = 'Generated';
                   await shipment.save({ validateBeforeSave: false });
                   console.log(`  URL: ${newPdfUrl}`);
                } catch (err) {
                   console.error(`  PDF Error: ${err.message}`);
                }

                fixedCount++;
            }
        }

        console.log(`Sync complete! ${fixedCount} shipments fixed.`);
        await mongoose.disconnect();
    } catch (error) {
        console.error('Final Sync failed:', error);
        process.exit(1);
    }
}

finalSync();
