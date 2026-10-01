const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const RateZone = require('../models/RateZone');
const RateTable = require('../models/RateTable');
const connectDB = require('../config/db');

(async () => {
    await connectDB();

    // 1. Check Zone for NJ
    const zone = await RateZone.findOne({ country: 'US', state: 'NJ' });
    console.log('NJ Zone:', zone ? zone.zone : 'NOT FOUND');

    // 2. Check Rate for 23kg
    // We look for weight >= 23
    const rateRow = await RateTable.findOne({ weight: { $gte: 23 } }).sort({ weight: 1 });

    if (rateRow) {
        console.log(`Found Rate Row for weight: ${rateRow.weight}`);
        // Print keys in 'rates' (or root if flat, but model implies nested or mixed)
        // RateCalculator normalizes them. Let's see raw doc.
        const rawRates = rateRow.rates || rateRow.toObject();
        // Filter out meta keys
        const keys = Object.keys(rawRates).filter(k => !['_id', 'weight', '__v', 'rates'].includes(k));
        console.log('Available Columns (first 20):', keys.slice(0, 20));

        // Check for TUS keys specifically
        const tusKeys = keys.filter(k => k.includes('TUS'));
        console.log('TUS Columns found:', tusKeys);
    } else {
        console.log('No Rate Row found for >= 23kg');
    }

    process.exit();
})();
