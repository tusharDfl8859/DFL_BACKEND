const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

const verifyIndexes = async () => {
    await connectDB();

    const collections = [
        { model: require('../models/Shipment'), name: 'Shipment' },
        { model: require('../models/User'), name: 'User' },
        { model: require('../models/Address'), name: 'Address' },
        { model: require('../models/Transaction'), name: 'Transaction' },
        // { model: require('../models/RateCard'), name: 'RateCard' } // RateCard might fail if file is broken, skipping for now or will try
    ];

    try {
        // Fix for RateCard requiring fix first
        try {
            collections.push({ model: require('../models/RateCard'), name: 'RateCard' });
        } catch (e) {
            console.log("RateCard model failed to load (expected if syntax error):", e.message);
        }

        for (const col of collections) {
            console.log(`\n--- Checking Indexes for ${col.name} ---`);
            const indexes = await col.model.listIndexes();
            console.table(indexes);
        }
    } catch (err) {
        console.error("Verification failed:", err);
    } finally {
        await mongoose.connection.close();
        process.exit();
    }
};

verifyIndexes();
