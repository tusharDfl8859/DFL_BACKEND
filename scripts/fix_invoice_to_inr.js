const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const fixInvoicesToINR = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        const shipmentIds = ['DFL81473659', 'DFL82379287'];
        
        for (const id of shipmentIds) {
            const shipment = await Shipment.findOne({ shipmentId: id });
            
            if (shipment) {
                console.log(`\nFound Shipment: ${shipment.shipmentId}`);
                console.log(`Current Invoice Currency: ${shipment.invoice?.currency}`);
                console.log(`Current Shipment Currency: ${shipment.shipmentDetails?.currency}`);

                if (shipment.invoice) {
                    // Fix Invoice Currency
                    shipment.invoice.currency = 'INR';
                    
                    // Also ensure total Amount and other fields are consistent if needed?
                    // Usually amount is just a number, currency is a label.
                    // But if the *amount* itself was converted to USD (e.g. 100 USD instead of 8300 INR),
                    // then just changing label to INR makes it 100 INR, which is WRONG.
                    
                    // Check amounts
                    console.log(`Invoice Amount: ${shipment.invoice.totalAmount}`);
                    
                    // The previous debug log showed:
                    // DFL81473659: Total Amount 1823.808 (USD? No, that looks like INR based on "Service Details Price: ₹1823.81")
                    // DFL82379287: Total Amount 1490.7648 (GBP? No, looks like INR based on "Service Details Price: ₹1490.76")
                    
                    // So the AMOUNTS are in INR, but the CURRENCY LABEL was wrong (USD/GBP).
                    // So safely changing label to INR is correct.
                    
                    await shipment.save();
                    console.log(`✅ Updated Invoice Currency to INR for ${id}`);
                } else {
                    console.log(`Refusing to update: No invoice found for ${id}`);
                }
            } else {
                console.log(`❌ Shipment ${id} not found.`);
            }
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

fixInvoicesToINR();
