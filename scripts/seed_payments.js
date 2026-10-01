const mongoose = require('mongoose');
const PaymentRequest = require('../models/PaymentRequest');
const User = require('../models/User');
require('dotenv').config();

const seedPayments = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const customerId = '466a914b-b221-46ef-8eb6-c49be483c18b';
        const user = await User.findOne({ customerId: customerId });

        if (!user) {
            console.error(`User with customerId ${customerId} not found.`);
            process.exit(1);
        }

        console.log(`Found User: ${user.name} (${user._id})`);

        const statuses = ['Pending', 'Review', 'Completed', 'Rejected'];
        const modes = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash Deposit'];
        const banks = ['HDFC Bank', 'ICICI Bank', 'SBI', 'Axis Bank', 'Kotak Mahindra'];
        const remarksList = [
            'Payment screenshot unclear',
            'UTR not matching',
            'Duplicate entry',
            'Verified successfully',
            'Pending bank confirmation'
        ];

        const paymentsToInsert = [];
        for (let i = 1; i <= 20; i++) {
            const status = statuses[Math.floor(Math.random() * statuses.length)];
            const mode = modes[Math.floor(Math.random() * modes.length)];
            const bank = banks[Math.floor(Math.random() * banks.length)];

            // Random date within last 30 days
            const date = new Date();
            date.setDate(date.getDate() - Math.floor(Math.random() * 30));

            const payment = {
                user: user._id,
                orderId: `ORD-${Date.now()}-${i}`,
                amount: Math.floor(Math.random() * 50000) + 1000,
                transactionId: `TXN${Math.floor(Math.random() * 1000000000)}`,
                paymentDate: date,
                proofUrl: '/uploads/proofs/mock-proof.jpg', // Placeholder
                fileType: 'image/jpeg',
                status: status,
                paymentMode: mode,
                senderBankName: bank,
                senderAccountName: user.name,
                remarks: status === 'Rejected' ? remarksList[Math.floor(Math.random() * 3)] : ''
            };

            if (status === 'Rejected') {
                payment.adminNotes = [{
                    text: remarksList[Math.floor(Math.random() * 3)],
                    createdAt: new Date()
                }];
            }

            paymentsToInsert.push(payment);
        }

        await PaymentRequest.insertMany(paymentsToInsert);

        console.log('Successfully seeded 20 payment requests.');

    } catch (error) {
        console.error('Error seeding payments:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
};

seedPayments();
