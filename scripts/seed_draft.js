const mongoose = require('mongoose');
const DraftShipment = require('../models/DraftShipment');
const User = require('../models/User');
require('dotenv').config();

const seedDraft = async () => {
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

        const draftsToInsert = [];
        for (let i = 1; i <= 20; i++) {
            draftsToInsert.push({
                user: user._id,
                shipperDetails: {
                    shipperName: `Test Shipper ${i}`,
                    companyName: `Test Company ${i}`,
                    mobileNo: '9876543210',
                    email: `shipper${i}@example.com`,
                    addressLine1: '123 Test St',
                    city: 'Delhi',
                    state: 'Delhi',
                    country: 'India',
                    pincode: '110001',
                    countryCode: 'IN',
                    // Set date: even numbers are expired (yesterday), odd are future (tomorrow)
                    date: i % 2 === 0
                        ? new Date(Date.now() - 86400000).toISOString()
                        : new Date(Date.now() + 86400000).toISOString()
                },
                consigneeDetails: {
                    consigneeName: `Test Consignee ${i}`,
                    companyName: `Receiver Inc ${i}`,
                    mobileNo: '1234567890',
                    email: `consignee${i}@example.com`,
                    addressLine1: '456 Receiver Rd',
                    city: 'New York',
                    state: 'NY',
                    country: 'United States',
                    pincode: '10001',
                    countryCode: 'US'
                },
                shipmentDetails: {
                    shipmentType: 'Export',
                    shipmentMode: 'Air',
                    noOfBoxes: '1',
                    boxes: [{
                        length: '10',
                        width: '10',
                        height: '10',
                        weight: '1',
                        productDescription: `Test Product ${i}`,
                        productQuantity: '1',
                        productUnitValue: '100'
                    }]
                },
                savedRate: {
                    serviceName: 'Express World Wide',
                    serviceCode: 'EXP_WW',
                    provider: 'DHL',
                    price: 2500 + (i * 100) // Varied price for testing
                }
            });
        }

        await DraftShipment.insertMany(draftsToInsert);

        console.log('Successfully seeded 20 draft shipments.');

    } catch (error) {
        console.error('Error seeding draft:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
};

seedDraft();
