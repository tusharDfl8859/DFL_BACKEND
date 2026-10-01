const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

const findUser = async () => {
    await connectDB();
    try {
        const users = await Admin.find({ 
            $or: [
                { name: { $regex: 'Shivani', $options: 'i' } },
                { email: { $regex: 'shivani', $options: 'i' } }
            ]
        });
        
        console.log('Found users:', JSON.stringify(users, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        mongoose.connection.close();
    }
};

findUser();
