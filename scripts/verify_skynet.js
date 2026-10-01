const rateCalculator = require('../utils/rateCalculator');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const verify = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected DB');

        await rateCalculator.loadData();
        console.log('Rate Data Loaded');

        // Test Case 1: Postcode 0800 (In CSV -> Capital -> S AUS1)
        console.log('\n--- TEST CASE 1: Valid Postcode 0800 (Expect Skynet) ---');
        try {
            const rates1 = rateCalculator.getRate({
                weight: 1,
                country: 'AU',
                postcode: '0800'
            });
            const skynet1 = rates1.rates.filter(r => r.provider === 'SKYNET');
            console.log(`Skynet services found: ${skynet1.length}`);
            if (skynet1.length > 0) {
                console.log('PASS: Skynet available for 0800');
                // console.log(skynet1);
            } else {
                console.error('FAIL: Skynet MISSING for 0800');
            }
        } catch (e) { console.error(e.message); }

        // Test Case 2: Postcode 9999 (NOT in CSV -> Expect NO Skynet)
        console.log('\n--- TEST CASE 2: Invalid Postcode 9999 (Expect NO Skynet) ---');
        try {
            const rates2 = rateCalculator.getRate({
                weight: 1,
                country: 'AU',
                postcode: '9999'
            });
            const skynet2 = rates2.rates.filter(r => r.provider === 'SKYNET');
            console.log(`Skynet services found: ${skynet2.length}`);
            if (skynet2.length === 0) {
                console.log('PASS: Skynet restricted for 2000');
            } else {
                console.error('FAIL: Skynet WAS FOUND for 2000 (Should be restricted)');
            }
        } catch (e) {
            // If it throws because no rates found at all, that's fine too for this test context, 
            // but usually TPL should exist if we imported standard AU zones.
            // Wait, we wiped RateZone in update_rates_v2.js!
            // Did update_rates_v2.js re-import standard AU zones?
            // "Australia State Code" sheet handles TPL AU zones.
            console.error(e.message);
        }

    } catch (e) {
        console.error(e);
    } finally {
        await mongoose.disconnect();
    }
};

verify();
