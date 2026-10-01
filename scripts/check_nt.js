const mongoose = require('mongoose');
const path = require('path');
const RateZone = require('../models/RateZone');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const checkNT = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        console.log('Checking for Postcode 0800 or 800...');

        const p800 = await RateZone.findOne({ postcode: '800' });
        console.log('Postcode "800":', p800);

        const p0800 = await RateZone.findOne({ postcode: '0800' });
        console.log('Postcode "0800":', p0800);

        const p3072 = await RateZone.findOne({ postcode: '3072' });
        console.log('Postcode "3072" (known sample):', p3072);

    } catch (error) {
        console.error(error);
    } finally {
        await mongoose.disconnect();
    }
};

checkNT();
