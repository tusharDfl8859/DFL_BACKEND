const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const readline = require('readline');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => {
    return new Promise(resolve => rl.question(query, resolve));
};

const createOpsUser = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');

        console.log('\n--- Create Operations Executive User ---');
        
        const name = await askQuestion('Name: ');
        const email = await askQuestion('Email: ');
        const password = await askQuestion('Password: ');
        const contactNumber = await askQuestion('Contact Number: ');

        if (!name || !email || !password || !contactNumber) {
            console.log('Error: All fields are required.');
            process.exit(1);
        }

        const adminExists = await Admin.findOne({ email });
        if (adminExists) {
            console.log('Error: Admin with this email already exists.');
            process.exit(1);
        }

        const admin = await Admin.create({
            name,
            email,
            password, // Password will be hashed by pre-save hook in Admin model
            contactNumber,
            designation: 'Operations Executive',
            department: 'Tech',
            role: 'operation',
            permissions: []
        });

        console.log('\nSuccess! User created:');
        console.log(`Name: ${admin.name}`);
        console.log(`Email: ${admin.email}`);
        console.log(`Role: ${admin.role}`);
        console.log(`Designation: ${admin.designation}`);
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
};

createOpsUser();
