const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');

dotenv.config({ path: path.join(__dirname, '../.env') });

const checkAndSeedCountries = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        const users = await User.find({});
        console.log(`Found ${users.length} users.`);

        const countries = ['United States', 'India', 'Canada', 'United Kingdom', 'Australia'];

        for (const user of users) {
            console.log(`User: ${user.name}, Country: ${user.kycData?.billingAddress?.country}`);

            // Seed country if missing for demo purposes
            if (!user.kycData?.billingAddress?.country) {
                const randomCountry = countries[Math.floor(Math.random() * countries.length)];

                // Ensure nested structure exists
                if (!user.kycData) user.kycData = {};
                if (!user.kycData.billingAddress) user.kycData.billingAddress = {};

                user.kycData.billingAddress.country = randomCountry;
                await user.save();
                console.log(`  -> Updated country to ${randomCountry}`);
            }
        }

        console.log('Done.');
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkAndSeedCountries();
