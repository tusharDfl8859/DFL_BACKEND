const mongoose = require('mongoose');
const path = require('path');
const RateZone = require('../models/RateZone');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const checkDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const count = await RateZone.countDocuments();
        console.log(`Total RateZones: ${count}`);

        if (count > 0) {
            const sample = await RateZone.findOne();
            console.log('Sample RateZone:', sample);

            // Check for a specific state if possible
            const example = await RateZone.findOne({ state: 'NT' });
            console.log('Search for state "NT":', example || 'Not Found');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

checkDB();
