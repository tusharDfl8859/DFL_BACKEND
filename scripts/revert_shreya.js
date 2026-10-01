const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const revertShreya = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        // Find Shreya
        const user = await Admin.findOne({ email: 'sales7@dflindia.in' });

        if (!user) {
            console.log('User Shreya (sales7@dflindia.in) not found');
            process.exit(1);
        }

        console.log('Found User:', user.name, user.email, user.role, user.designation);

        // Revert to original
        user.role = 'member';
        user.designation = 'Sales Executive';
        user.department = 'Sales'; 
        user.permissions = []; // Reset permissions array if I touched it (I didn't explicitly, but good to be safe)

        await user.save();

        console.log('\nSuccessfully REVERTED Shreya Saxena (Upadhyay) to:');
        console.log(`Role: ${user.role}`);
        console.log(`Designation: ${user.designation}`);
        console.log(`Department: ${user.department}`);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

revertShreya();
