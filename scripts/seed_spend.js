const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Shipment = require('../models/Shipment');
const User = require('../models/User');

dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

const seedShipments = async () => {
    await connectDB();

    try {
        const users = await User.find().limit(5);

        if (users.length === 0) {
            console.log('No users found.');
            process.exit();
        }

        console.log(`Found ${users.length} users. Creating fake shipments for spend...`);

        const shipments = [];

        for (const user of users) {
            // 1-3 shipments per user
            const count = Math.floor(Math.random() * 3) + 1;

            for (let i = 0; i < count; i++) {
                const price = (Math.floor(Math.random() * 5000) + 500).toString(); // String price as per schema often

                shipments.push({
                    user: user._id,
                    trackingId: `TRK-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    status: 'Pending',
                    serviceDetails: {
                        serviceName: 'Standard',
                        price: price,
                        chargeableWeight: '2.5 kg'
                    },
                    consigneeDetails: {
                        country: 'United States'
                    },
                    createdAt: new Date() // Today
                });
            }
        }

        await Shipment.insertMany(shipments);
        console.log(`${shipments.length} Shipments inserted.`);
        console.log('Done.');
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

seedShipments();
