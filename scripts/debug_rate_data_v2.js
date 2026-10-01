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
    const zone = await RateZone.findOne({ country: 'US', state: 'NJ' }).lean();
    console.log('NJ Zone:', zone ? zone.zone : 'NOT FOUND');

    // 2. Check Rate for 23kg
    const rateRow = await RateTable.findOne({ weight: { $gte: 23 } }).sort({ weight: 1 }).lean();

    if (rateRow) {
        console.log(`Found Rate Row for weight: ${rateRow.weight}`);

        // With .lean(), rateRow is a POJO.
        // rateRow.rates should be an object (from Map)
        const rates = rateRow.rates || {};

        const keys = Object.keys(rates);
        console.log(`Total Keys in rates: ${keys.length}`);

        // Check for TUS keys specifically
        const tusKeys = keys.filter(k => k.includes('TUS'));
        if (tusKeys.length > 0) {
            console.log('TUS Keys found (Sample):', tusKeys.slice(0, 5));
        } else {
            console.log('NO TUS KEYS FOUND IN RATES MAP');
        }

        const exactZone = zone ? zone.zone : 'TUS 2';
        // Check for exact zone normalized (remove spaces)
        const normalizedZone = exactZone.replace(/\s+/g, '');
        console.log(`Checking normalized key: ${normalizedZone}`);

        // Check if raw key or normalized key exists
        let val = rates[exactZone] || rates[normalizedZone];
        // Also check keys array manually
        if (!val) {
            const manualMatch = keys.find(k => k.replace(/\s+/g, '') === normalizedZone);
            if (manualMatch) {
                val = rates[manualMatch];
                console.log(`Found via manual match: ${manualMatch}`);
            }
        }

        console.log(`Value for ${exactZone}:`, val);

    } else {
        console.log('No Rate Row found for >= 23kg');
    }

    process.exit();
})();
