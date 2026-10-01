const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Shipment = require('../models/Shipment');
const { generateInvoicePDF } = require('../utils/pdfGenerator');

async function regenerate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Target Specific Shipments mentioned by user 
        // Also any that still show DFL EXPRESS as courier brand in PDF context (if we can detect)
        const targetIds = ['DFL28050039', 'DFL54668755'];
        
        // Find them
        const shipments = await Shipment.find({ 
            shipmentId: { $in: targetIds } 
        });

        console.log(`Regenerating ${shipments.length} specific invoices...`);

        for (const shipment of shipments) {
            console.log(`- Regenerating PDF for ${shipment.shipmentId}`);
            
            // Re-sync Price in case of any last-second discrepancy
            const servicePriceRaw = shipment.serviceDetails?.price || '';
            const servicePriceNumeric = parseFloat(servicePriceRaw.replace(/[^0-9.]/g, '')) || 0;
            
            if (servicePriceNumeric > 0) {
                const igstRate = 0.18;
                const subtotal = servicePriceNumeric / (1 + igstRate);
                const taxAmount = servicePriceNumeric - subtotal;

                shipment.invoice.subtotal = Math.round(subtotal * 100) / 100;
                shipment.invoice.totalAmount = Math.round(servicePriceNumeric * 100) / 100;
                shipment.invoice.tax = {
                    ...shipment.invoice.tax,
                    amount: Math.round(taxAmount * 100) / 100
                };
                shipment.invoice.lineItems = [
                    { description: 'Shipping Charges', amount: Math.round(subtotal * 100) / 100 }
                ];
            }

            // Important: Force Skynet brand in the PDF context if it was restored
            // The pdfGenerator uses shipment.serviceDetails.carrierName to print the Brand
            
            try {
                // This will upload a fresh PDF to Cloudinary and return new URL
                const pdfUrl = await generateInvoicePDF(shipment.invoice, shipment);
                console.log(`  New PDF URL: ${pdfUrl}`);
                
                shipment.invoice.pdfUrl = pdfUrl;
                shipment.invoice.status = 'Generated';
                
                // Allow legacy shipments to save
                if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
                if (!shipment.shipmentDetails.invoiceNumber) {
                    shipment.shipmentDetails.invoiceNumber = 'NOT_PROVIDED';
                }
                
                await shipment.save({ validateBeforeSave: false });
                console.log(`  Shipment ${shipment.shipmentId} updated successfully.`);
            } catch (err) {
                console.error(`  Failed to regenerate for ${shipment.shipmentId}:`, err.message);
            }
        }

        console.log('Regeneration complete.');
        await mongoose.disconnect();
    } catch (error) {
        console.error('Process failed:', error);
        process.exit(1);
    }
}

regenerate();
