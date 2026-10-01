const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const verifyShreya = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        
        const email = 'opsdxb@thedflgroup.com';
        console.log(`Searching for Shreya Saxena (${email})...`);
        const user = await Admin.findOne({ email: email });

        if (!user) {
            console.log('❌ User not found.');
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

verifyShreya();
