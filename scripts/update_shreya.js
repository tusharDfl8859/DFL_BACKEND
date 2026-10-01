const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const updateShreya = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        // Find Shreya
        const user = await Admin.findOne({ 
            $or: [
                { name: { $regex: 'Shreya', $options: 'i' } },
                { email: { $regex: 'shreya', $options: 'i' } }
            ]
        });

        if (!user) {
            console.log('User Shreya not found');
            process.exit(1);
        }

        console.log('Found User:', user.name, user.email, user.role, user.designation);

        // Update to match Shivani Gangwar
        user.role = 'operation';
        user.designation = 'Operations Executive';
        user.department = 'Tech'; // Assuming same department as Shivani based on request "same title as shivangi" implying same role/position

        await user.save();

        console.log('\nSuccessfully updated Shreya Saxena to:');
        console.log(`Role: ${user.role}`);
        console.log(`Designation: ${user.designation}`);
        console.log(`Department: ${user.department}`);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

updateShreya();
