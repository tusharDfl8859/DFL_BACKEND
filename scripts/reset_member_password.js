const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const Admin = require('../models/Admin');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err);
        process.exit(1);
    }
};

const resetPassword = async () => {
    await connectDB();

    const email = 'Saless8@dflindia.in';
    const newPassword = 'DFLsales@123';

    console.log(`Attempting to reset password for: ${email}`);

    try {
        const admin = await Admin.findOne({ email });
        
        if (!admin) {
            console.log(`❌ User with email ${email} not found in Admin/Team Member database.`);
            // Optional: Check regular User collection if not found in Admin? 
            // The request said "team member", which usually implies Admin model in this codebase.
            process.exit(1);
        }

        console.log(`Found user: ${admin.name} (${admin.role})`);

        admin.password = newPassword;
        await admin.save();

        console.log(`✅ Password successfully reset.`);
        console.log(`📧 Email: ${email}`);
        console.log(`jwPassword: ${newPassword}`);
        
    } catch (error) {
        console.error('❌ Error resetting password:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
};

resetPassword();
