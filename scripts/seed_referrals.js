const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');

dotenv.config({ path: '../.env' });

const sources = [
    'Google Search',
    'Social Media (Instagram/Facebook)',
    'LinkedIn',
    'Friend or Colleague',
    'Email Newsletter',
    'Online Advertisement',
    'Logistics Event',
    'Sales Representative',
    'Other'
];

const seedReferrals = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        const users = await User.find({});
        console.log(`Found ${users.length} users to update...`);

        let updatedCount = 0;
        for (const user of users) {
            // Randomly assign a source
            const randomSource = sources[Math.floor(Math.random() * sources.length)];

            // Randomly decide if we update (to keep some natural randomness or simulate missing data if needed, but here we update all for "dummy output")
            // actually, let's update ALL of them to ensure the chart looks good.
            user.referralSource = randomSource;

            // Randomly set createdAt to be recent (today/yesterday) for some users so they show up in the "Today" report
            // Only strictly necessary if the report filter is set to "Today" and current users are old.
            // Let's set 50% of users to be created "Today" so they show up in default view.
            if (Math.random() > 0.5) {
                user.createdAt = new Date(); // Reset to now
            }

            await user.save();
            updatedCount++;
        }

        console.log(`Successfully updated ${updatedCount} users with dummy referral sources.`);
        console.log('Sample Distribution:', sources.map(s => s));
        process.exit();
    } catch (error) {
        console.error('Error seeding referrals:', error);
        process.exit(1);
    }
};

seedReferrals();
