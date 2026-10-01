const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const dns = require('dns');
const Shipment = require('../models/Shipment');

// Fix DNS for MongoDB Atlas
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    console.error(e);
}

dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

const fixCurrency = async () => {
    await connectDB();

    const shipmentId = process.argv[2];
    const newCurrency = process.argv[3] || 'USD';

    if (!shipmentId) {
        console.error('Please provide a Shipment ID. Usage: node scripts/fix_invoice_currency.js <SHIPMENT_ID> [CURRENCY]');
        process.exit(1);
    }

    try {
        const regex = new RegExp(shipmentId, 'i');
        const shipment = await Shipment.findOne({ shipmentId: regex });

        if (!shipment) {
            console.log(`Shipment ${shipmentId} not found.`);
            process.exit(1);
        }

        console.log(`Found Shipment: ${shipment.shipmentId}`);
        console.log(`Current Currency: ${shipment.shipmentDetails?.currency || 'Not Set (Defaults to USD)'}`);

        if (!shipment.shipmentDetails) {
            shipment.shipmentDetails = {};
        }

        shipment.shipmentDetails.currency = newCurrency;

        // Also update items if needed?
        // Usually currency is at shipmentDetails level for the invoice.

        await shipment.save();
        console.log(`\nUpdated Currency to: ${newCurrency}`);
        console.log('Done.');

    } catch (error) {
        console.error('Error updating currency:', error);
    } finally {
        mongoose.connection.close();
    }
};

fixCurrency();