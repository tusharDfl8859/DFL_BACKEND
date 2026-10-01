const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const RateZone = require('../models/RateZone');
const RateTable = require('../models/RateTable');

const connectDB = async () => {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');
};

const debugAU = async () => {
    await connectDB();
    
    // 1. Check Zone Logic for a sample postcode (e.g., Sydney 2000 or Melbourne 3000)
    const postcode = "3000";
    const zoneDoc = await RateZone.findOne({ country: 'AU', postcode: postcode });
    console.log(`\n--- Zone Lookup for Postcode ${postcode} ---`);
    if (zoneDoc) {
        console.log(`Found Zone: "${zoneDoc.zone}"`);
    } else {
        console.log('No zone found!');
    }

    // 2. Check Rate keys available
    const rateDoc = await RateTable.findOne({ weight: 0.5 }).lean();
    console.log('\n--- Available Rate Keys (Sample) ---');
    const keys = Object.keys(rateDoc.rates).filter(k => k.includes('AU') || k.includes('US')); 
    // Filter for AU to see candidates like TAU1, SAU1, S AUS1 etc.
    console.log(keys);

    process.exit(0);
};

debugAU();
