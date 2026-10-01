const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Admin = require('../models/Admin');

dotenv.config();

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

const checkAdmins = async () => {
    await connectDB();

    try {
        const admins = await Admin.find({});
        console.log(`Found ${admins.length} admins.`);
        admins.forEach(admin => {
            console.log(`- Name: ${admin.name}, Email: ${admin.email}, Role: ${admin.role}`);
        });
    } catch (error) {
        console.error('Error fetching admins:', error);
    } finally {
        mongoose.connection.close();
    }
};

checkAdmins();
