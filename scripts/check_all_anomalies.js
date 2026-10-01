/**
 * Full Anomaly Check: Compare each user's wallet balance against their
 * Transaction history (credits - debits) to find discrepancies.
 * This checks ALL time, not just after a specific date.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const Transaction = require('../models/Transaction');
const PaymentRequest = require('../models/PaymentRequest');

async function main() {
    console.log('='.repeat(70));
    console.log('🔍 FULL ANOMALY CHECK: Comparing balances vs transaction history');
    console.log('='.repeat(70));

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to database\n');

    // Get all users who have ever had a payment
    const usersWithPayments = await PaymentRequest.distinct('user');
    console.log(`Checking ${usersWithPayments.length} users with payment history...\n`);

    const anomalies = [];

    for (const userId of usersWithPayments) {
        const user = await User.findById(userId);
        if (!user) continue;

        // Get all transaction totals
        const creditResult = await Transaction.aggregate([
            { $match: { user: userId, type: 'credit' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        const debitResult = await Transaction.aggregate([
            { $match: { user: userId, type: 'debit' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
        ]);

        const totalCredits = creditResult[0]?.total || 0;
        const totalDebits = debitResult[0]?.total || 0;
        const expectedBalance = totalCredits - totalDebits;
        const diff = user.walletBalance - expectedBalance;

        if (Math.abs(diff) > 0.01) {
            anomalies.push({
                Customer: `${user.name} (${user.customerId})`,
                CurrentBal: `₹${user.walletBalance.toFixed(2)}`,
                TxnCredits: `₹${totalCredits.toFixed(2)}`,
                TxnDebits: `₹${totalDebits.toFixed(2)}`,
                ExpectedBal: `₹${expectedBalance.toFixed(2)}`,
                Discrepancy: `₹${diff.toFixed(2)}`
            });
        }
    }

    if (anomalies.length > 0) {
        console.log(`⚠️  ${anomalies.length} ANOMALIES FOUND (Balance != Credits - Debits):\n`);
        console.table(anomalies);

        const totalDisc = anomalies.reduce((sum, a) => sum + parseFloat(a.Discrepancy.replace('₹', '')), 0);
        console.log(`\nTotal discrepancy: ₹${totalDisc.toFixed(2)}`);
    } else {
        console.log('✅ No anomalies found — all user balances match their transaction history.');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done.');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    mongoose.disconnect();
    process.exit(1);
});
