const mongoose = require('mongoose');
const path = require('path');
const RateZone = require('../models/RateZone');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const checkCountryDistribution = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Aggregation to count by country
        const distribution = await RateZone.aggregate([
            { $group: { _id: "$country", count: { $sum: 1 } } }
        ]);

        console.log('RateZone Country Distribution:', distribution);

        // Check for ANY 'AU' or 'Australia' data specifically
        const auSample = await RateZone.findOne({
            $or: [
                { country: 'AU' },
                { country: 'Australia' },
                { state: 'NT' }, // Check for NT state specifically again
            ]
        });

        if (auSample) {
            console.log('Found potential Australian sample:', auSample);
        } else {
            console.log('No explicit Australian data found (checked country=AU/Australia and state=NT).');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected');
    }
};

checkCountryDistribution();
