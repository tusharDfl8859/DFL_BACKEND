/**
 * Rollback Script: Reverse all corrections made by fix_double_credits.js
 * 
 * This script:
 * 1. Finds all Transaction records with description starting with "Correction: Reversed premature credit"
 * 2. Adds back the deducted amounts to each user's wallet
 * 3. Deletes the corrective Transaction records
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const Transaction = require('../models/Transaction');

async function main() {
    console.log('='.repeat(70));
    console.log('🔄 ROLLBACK: Reversing all corrections from fix_double_credits.js');
    console.log('='.repeat(70));

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to database\n');

    // Find all corrective transactions
    const corrections = await Transaction.find({
        description: { $regex: /^Correction: Reversed premature credit/ }
    }).sort({ createdAt: 1 });

    console.log(`Found ${corrections.length} corrective transaction(s) to reverse.\n`);

    for (const txn of corrections) {
        const user = await User.findById(txn.user);
        if (!user) {
            console.log(`⚠️  User ${txn.user} not found. Skipping.`);
            continue;
        }

        const addBack = Math.abs(txn.amount); // txn.amount is negative, we add back
        const balanceBefore = user.walletBalance;
        user.walletBalance = user.walletBalance + addBack;
        await user.save();

        console.log(`✅ ${user.name} (${user.customerId}): +₹${addBack} (₹${balanceBefore.toFixed(2)} → ₹${user.walletBalance.toFixed(2)})`);
        console.log(`   Ref: ${txn.referenceId}`);

        // Delete the corrective transaction record
        await Transaction.deleteOne({ _id: txn._id });
        console.log(`   🗑️  Deleted corrective transaction\n`);
    }

    console.log('='.repeat(70));
    console.log(`Rolled back ${corrections.length} correction(s).`);
    console.log('='.repeat(70));

    await mongoose.disconnect();
    console.log('\n✅ Done. Disconnected from database.');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    mongoose.disconnect();
    process.exit(1);
});
