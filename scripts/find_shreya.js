const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const findShreya = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        
        console.log('Searching for Shreya Saxena...');
        const user = await Admin.findOne({ 
            $or: [
                { name: { $regex: 'Shreya', $options: 'i' } },
                { email: { $regex: 'shreya', $options: 'i' } }
            ]
        });

        if (!user) {
            console.log('❌ User Shreya not found.');
        } else {
            console.log('✅ Found User:');
            console.log(`- Name: ${user.name}`);
            console.log(`- Email: ${user.email}`);
            console.log(`- Role: ${user.role}`);
            console.log(`- Designation: ${user.designation}`);
            console.log(`- Department: ${user.department}`);
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

findShreya();
