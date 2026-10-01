const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const updateShreyaV2 = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        const email = 'opsdxb@thedflgroup.com';
        
        // Find Shreya by specific email
        const user = await Admin.findOne({ email: email });

        if (!user) {
            console.log(`❌ User with email ${email} not found.`);
            
            // Optional: Search by name just to see if email matches partially or is different
            const potentialUsers = await Admin.find({ 
                name: { $regex: 'Shreya', $options: 'i' } 
            });
            if (potentialUsers.length > 0) {
                 console.log('Found other users named Shreya:', potentialUsers.map(u => `${u.name} (${u.email})`).join(', '));
            }

            process.exit(1);
        }

        console.log('✅ Found User:');
        console.log(`- Name: ${user.name}`);
        console.log(`- Email: ${user.email}`);
        console.log(`- Current Role: ${user.role}`);
        console.log(`- Current Designation: ${user.designation}`);
        
        // Update to match Shivani Gangwar
        user.role = 'operation';
        user.designation = 'Operations Executive';
        user.department = 'Tech'; 
        // user.permissions = []; // Should be empty or match specifically if needed, likely default is fine

        await user.save();

        console.log('\nSuccessfully UPDATED Shreya Saxena to:');
        console.log(`Role: ${user.role}`);
        console.log(`Designation: ${user.designation}`);
        console.log(`Department: ${user.department}`);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

updateShreyaV2();
