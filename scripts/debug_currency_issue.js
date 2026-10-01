const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const debugShipments = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        const shipmentIds = ['DFL81473659', 'DFL82379287'];
        
        for (const id of shipmentIds) {
            const shipment = await Shipment.findOne({ shipmentId: id });
            if (shipment) {
                console.log(`\n--- Shipment: ${shipment.shipmentId} ---`);
                console.log('Shipment Details Currency:', shipment.shipmentDetails?.currency);
                console.log('Service Details Price:', shipment.serviceDetails?.price);
                console.log('Service Details:', JSON.stringify(shipment.serviceDetails, null, 2));
                if (shipment.invoice) {
                    console.log('Invoice Data:', JSON.stringify(shipment.invoice, null, 2));
                } else {
                    console.log('No Invoice Data found.');
                }
            } else {
                console.log(`\n❌ Shipment ${id} not found.`);
            }
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

debugShipments();
