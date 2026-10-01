const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const updateInvoiceDescription = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        const shipmentIds = ['DFL81473659', 'DFL82379287'];
        
        for (const id of shipmentIds) {
            const shipment = await Shipment.findOne({ shipmentId: id });
            
            if (shipment && shipment.invoice && shipment.invoice.lineItems) {
                console.log(`\nProcessing Shipment: ${id}`);
                
                let updated = false;
                shipment.invoice.lineItems.forEach((item, index) => {
                    console.log(`Line Item ${index + 1} Old Description: "${item.description}"`);
                    if (item.description !== 'Shipping Charges') {
                        item.description = 'Shipping Charges';
                        updated = true;
                    }
                });

                if (updated) {
                    await shipment.save();
                    console.log(`✅ Updated Line Items to "Shipping Charges" for ${id}`);
                } else {
                    console.log(`No changes needed for ${id}`);
                }

            } else {
                console.log(`❌ Shipment ${id} not found or has no invoice line items.`);
            }
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

updateInvoiceDescription();
