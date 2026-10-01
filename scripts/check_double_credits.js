/**
 * Smart Double-Credit Check:
 * For each user, compare:
 *   - What they SHOULD have (sum of Completed PaymentRequests - sum of debits)
 *   - What they ACTUALLY have (current walletBalance)
 * If actual > expected, the excess is the double-credited amount.
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
    console.log('🔍 SMART DOUBLE-CREDIT CHECK');
    console.log('   Expected = Sum(Completed Payments) + Sum(Admin Add-Funds)');
    console.log('   Actual   = Current Balance + Sum(All Debits)');
    console.log('   Excess   = Actual - Expected (positive = double-credited)');
    console.log('='.repeat(70));

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to database\n');

    // Get all users with payments
    const usersWithPayments = await PaymentRequest.distinct('user');
    console.log(`Checking ${usersWithPayments.length} users...\n`);

    const problems = [];
    let totalExcess = 0;

    for (const userId of usersWithPayments) {
        const user = await User.findById(userId);
        if (!user) continue;

        // Sum of all Completed payments (what they should have been credited ONCE)
        const completedPayments = await PaymentRequest.aggregate([
            { $match: { user: userId, status: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalCompleted = completedPayments[0]?.total || 0;

        // Sum of admin-added funds (system adjustments)
        const adminAdds = await PaymentRequest.aggregate([
            { $match: { user: userId, paymentMode: 'System Adjustment', status: 'Completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalAdminAdds = adminAdds[0]?.total || 0;

        // Total they should have been credited = completedPayments (already includes admin adds)
        const expectedTotalCredit = totalCompleted;

        // Total debits from transactions (shipments, manual deductions, etc.)
        const debitResult = await Transaction.aggregate([
            { $match: { user: userId, type: 'debit' } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
        ]);
        const totalDebits = debitResult[0]?.total || 0;

        // What their balance SHOULD be (if credited once only)
        const expectedBalance = expectedTotalCredit - totalDebits;

        // The excess = what they actually have - what they should have
        const excess = user.walletBalance - expectedBalance;

        // Count their completed payments
        const paymentCount = await PaymentRequest.countDocuments({ user: userId, status: 'Completed' });

        if (excess > 1) { // tolerance of ₹1 for floating point
            problems.push({
                Customer: `${user.name} (${user.customerId})`,
                Payments: paymentCount,
                TotalPaid: `₹${totalCompleted.toFixed(2)}`,
                TotalDebits: `₹${totalDebits.toFixed(2)}`,
                ExpectedBal: `₹${expectedBalance.toFixed(2)}`,
                ActualBal: `₹${user.walletBalance.toFixed(2)}`,
                Excess: `₹${excess.toFixed(2)}`
            });
            totalExcess += excess;
        }
    }

    if (problems.length > 0) {
        console.log(`⚠️  ${problems.length} users with EXCESS balance (possible double-credits):\n`);
        console.table(problems);
        console.log(`\nTotal excess across all users: ₹${totalExcess.toFixed(2)}`);
    } else {
        console.log('✅ No double-credit issues found! All balances are at or below expected.');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done.');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    mongoose.disconnect();
    process.exit(1);
});
