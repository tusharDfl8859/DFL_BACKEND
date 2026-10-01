const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

const seedData = async () => {
    await connectDB();

    try {
        console.log('Fetching users...');
        const users = await User.find().limit(5);

        if (users.length === 0) {
            console.log('No users found to create logs for.');
            process.exit();
        }

        console.log(`Found ${users.length} users. Creating fake login logs...`);

        const logs = [];
        const actions = ['USER_LOGIN'];

        for (const user of users) {
            // Create multiple logs for some users to simulate ranking
            const loginCount = Math.floor(Math.random() * 5) + 1; // 1 to 5 logins

            for (let i = 0; i < loginCount; i++) {
                logs.push({
                    actor: user._id,
                    actorModel: 'User',
                    action: 'USER_LOGIN',
                    target: user._id,
                    targetModel: 'User',
                    details: { email: user.email, method: 'seed' },
                    ipAddress: '127.0.0.1',
                    userAgent: 'SeedScript',
                    status: 'SUCCESS',
                    createdAt: new Date() // Today
                });
            }
        }

        await ActivityLog.insertMany(logs);
        console.log(`${logs.length} ActivityLogs inserted.`);
        console.log('Process completed.');
        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

seedData();
