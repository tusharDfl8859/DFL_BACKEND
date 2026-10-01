/**
 * Database Correction Script: Fix Double Wallet Credits
 * 
 * Problem: paymentRoutes.js was crediting wallets both on submit AND on admin approval.
 * 
 * This script:
 * 1. Finds all PaymentRequests created after Feb 12, 2026 00:41 AM IST
 * 2. For each payment that was instant-credited on submit:
 *    - If status is 'Completed' (approved by admin): User was double-credited. Deduct one credit.
 *    - If status is 'Review' (not yet approved): User was prematurely credited. Deduct the credit.
 *    - If status is 'Rejected': User was credited but shouldn't have been. Deduct the credit.
 * 3. Creates corrective Transaction records for audit trail.
 * 4. Logs everything.
 * 
 * Usage: node scripts/fix_double_credits.js [--dry-run]
 * 
 * Run with --dry-run first to see what would change without modifying anything.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

// Models
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// We need to define/import PaymentRequest model
let PaymentRequest;
try {
    PaymentRequest = require('../models/PaymentRequest');
} catch (e) {
    // If the model path is different, try alternative
    console.error('Could not load PaymentRequest model:', e.message);
    process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

// The buggy code was deployed around Feb 12, 2026. Use midnight IST as cutoff.
// Feb 12, 2026 00:41 AM IST = Feb 11, 2026 19:11 UTC
const CUTOFF_DATE = new Date('2026-02-11T19:11:00.000Z');

async function main() {
    console.log('='.repeat(70));
    console.log(DRY_RUN ? '🔍 DRY RUN MODE — No changes will be made' : '🔧 LIVE MODE — Changes WILL be applied');
    console.log(`Cutoff date: ${CUTOFF_DATE.toISOString()} (Feb 12, 2026 00:41 AM IST)`);
    console.log('='.repeat(70));

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to database\n');

    // Step 1: Find all payments created after cutoff
    const payments = await PaymentRequest.find({
        createdAt: { $gte: CUTOFF_DATE }
    }).sort({ createdAt: 1 });

    console.log(`Found ${payments.length} payment(s) created after cutoff date.\n`);

    if (payments.length === 0) {
        console.log('No payments to process. Exiting.');
        await mongoose.disconnect();
        return;
    }

    let totalCorrections = 0;
    let totalAmountDeducted = 0;
    const corrections = [];
    // Track cumulative deductions per user for dry-run accuracy
    const dryRunDeductions = {};

    for (const payment of payments) {
        // Always re-fetch the user to get the latest balance (important for multiple corrections)
        const user = await User.findById(payment.user);
        if (!user) {
            console.log(`⚠️  User ${payment.user} not found for payment ${payment.orderId}. Skipping.`);
            continue;
        }

        let shouldDeduct = false;
        let reason = '';

        if (payment.status === 'Completed') {
            shouldDeduct = true;
            reason = 'Double credit (submit + approval)';
        } else if (payment.status === 'Review') {
            shouldDeduct = true;
            reason = 'Premature credit (not yet approved)';
        } else if (payment.status === 'Rejected') {
            shouldDeduct = true;
            reason = 'Credit on rejected payment';
        }

        if (shouldDeduct) {
            const deductAmount = payment.amount;
            const userId = user._id.toString();
            
            // In dry-run, track cumulative deductions
            const priorDryDeduction = dryRunDeductions[userId] || 0;
            const effectiveBalance = user.walletBalance - priorDryDeduction;
            const balanceBefore = effectiveBalance;
            const balanceAfter = effectiveBalance - deductAmount;

            console.log(`📋 Payment: ${payment.orderId}`);
            console.log(`   User: ${user.name} (${user.customerId})`);
            console.log(`   Status: ${payment.status}`);
            console.log(`   Amount: ₹${deductAmount}`);
            console.log(`   Reason: ${reason}`);
            console.log(`   Balance: ₹${balanceBefore.toFixed(2)} → ₹${balanceAfter.toFixed(2)}`);

            if (!DRY_RUN) {
                // Deduct the incorrectly credited amount
                user.walletBalance = user.walletBalance - deductAmount;
                await user.save();

                // Create corrective Transaction record
                await Transaction.create({
                    user: user._id,
                    amount: -deductAmount,
                    type: 'debit',
                    description: `Correction: Reversed premature credit for ${payment.orderId} (${reason})`,
                    referenceId: payment.orderId,
                    status: 'success',
                    balanceAfter: user.walletBalance,
                    performedByModel: 'System'
                });

                console.log(`   ✅ CORRECTED\n`);
            } else {
                // Track cumulative deductions so next dry-run iteration is accurate
                dryRunDeductions[userId] = priorDryDeduction + deductAmount;
                console.log(`   🔍 Would correct (dry run)\n`);
            }

            corrections.push({
                orderId: payment.orderId,
                userId: user.customerId,
                userName: user.name,
                status: payment.status,
                amount: deductAmount,
                reason,
                balanceBefore,
                balanceAfter
            });

            totalCorrections++;
            totalAmountDeducted += deductAmount;
        }
    }

    // Summary
    console.log('='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total payments examined: ${payments.length}`);
    console.log(`Total corrections ${DRY_RUN ? 'needed' : 'applied'}: ${totalCorrections}`);
    console.log(`Total amount ${DRY_RUN ? 'to deduct' : 'deducted'}: ₹${totalAmountDeducted.toFixed(2)}`);
    console.log('');

    if (corrections.length > 0) {
        console.log('Detailed corrections:');
        console.table(corrections.map(c => ({
            Order: c.orderId,
            Customer: `${c.userName} (${c.userId})`,
            Status: c.status,
            Amount: `₹${c.amount}`,
            Reason: c.reason,
            'Before': `₹${c.balanceBefore}`,
            'After': `₹${c.balanceAfter}`
        })));
    }

    if (DRY_RUN && totalCorrections > 0) {
        console.log('\n⚠️  Run without --dry-run to apply these corrections.');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done. Disconnected from database.');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    mongoose.disconnect();
    process.exit(1);
});
