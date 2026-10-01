const rateCalculator = require('../utils/rateCalculator');
const mongoose = require('mongoose');
const RateZone = require('../models/RateZone');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const debugTPL = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected DB');

        // 1. Check RateZone for 0800 (Standard AU)
        // Note: Postcode usually stored as string. CSV import might have been '800' or '0800'.
        // Let's check both.
        const zone800 = await RateZone.findOne({ country: 'AU', postcode: '800' });
        const zone0800 = await RateZone.findOne({ country: 'AU', postcode: '0800' });

        console.log('DB Search for AU 800:', zone800);
        console.log('DB Search for AU 0800:', zone0800);

        if (!zone800 && !zone0800) {
            console.error('CRITICAL: No standard TPL Zone found for 0800/800!');
        } else {
            const z = zone800 || zone0800;
            console.log(`Found Zone: ${z.zone}`);
        }

        // 2. Run Rate Calculator
        await rateCalculator.loadData();
        console.log('RateData Loaded');

        // Debug internal state if possible via logs in rateCalculator (we removed them but might need output here)
        // We will inspect the output of getRate
        try {
            const result = rateCalculator.getRate({
                weight: 5,
                country: 'AU',
                postcode: '0800' // Try 0800
            });

            console.log('All Rates found for 0800 (5kg):');
            result.rates.forEach(r => {
                console.log(`- ${r.serviceName} (${r.provider}): ${r.rate} [Zone: ${r.zone}]`);
            });

            const tpl = result.rates.filter(r => r.provider === 'TPL');
            if (tpl.length === 0) {
                console.log('WARNING: No TPL rates returned by calculator.');
            }

        } catch (e) {
            console.error('Calculator Error:', e.message);
        }

    } catch (e) {
        console.error(e);
    } finally {
        await mongoose.disconnect();
    }
};

debugTPL();
