require('dotenv').config();
const connectDB = require('../config/db');
const { runDailyBookingSummaryJob } = require('../workers/dailyBookingSummaryWorker');

const triggerManualSummary = async () => {
    console.log('=== Manual Trigger: Daily Customer WhatsApp Booking Summary ===');
    try {
        await connectDB();
        console.log('Connected to MongoDB.');
        
        console.log('Running Daily Booking Summary Job...');
        const result = await runDailyBookingSummaryJob();
        
        console.log('\n--- Execution Result ---');
        console.log(JSON.stringify(result, null, 2));
        console.log('===========================================================');
    } catch (err) {
        console.error('Fatal error running manual summary trigger:', err);
    } finally {
        process.exit(0);
    }
};

triggerManualSummary();
