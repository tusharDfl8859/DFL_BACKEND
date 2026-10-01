const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Configure environment
dotenv.config({ path: path.join(__dirname, '../.env') });

// Import Models
const User = require('../models/User');
const QuoteQuery = require('../models/QuoteQuery');

// Connect DB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected for Migration');
    } catch (err) {
        console.error('DB Connection Failed:', err);
        process.exit(1);
    }
};

const migrate = async () => {
    await connectDB();

    try {
        console.log('Starting Migration: Fixing QuoteQuery Assignments...');

        // 1. Find all QuoteQueries that have a user but no assignedTo
        const queries = await QuoteQuery.find({
            user: { $ne: null },
            $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }]
        }).populate('user', 'assignedTo name email');

        console.log(`Found ${queries.length} queries to check/update.`);

        let updatedCount = 0;
        let skippedCount = 0;

        for (const query of queries) {
            if (query.user && query.user.assignedTo) {
                // query.assignedTo = query.user.assignedTo;
                // await query.save();

                // Using updateOne to avoid validation issues on other fields if any
                await QuoteQuery.updateOne(
                    { _id: query._id },
                    { $set: { assignedTo: query.user.assignedTo } }
                );

                process.stdout.write(`.`);
                updatedCount++;
            } else {
                skippedCount++;
            }
        }

        console.log(`\nMigration Complete.`);
        console.log(`Updated: ${updatedCount}`);
        console.log(`Skipped (User has no assignment): ${skippedCount}`);

    } catch (error) {
        console.error('Migration Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('DB Disconnected');
        process.exit();
    }
};

migrate();
