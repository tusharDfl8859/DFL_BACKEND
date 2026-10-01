var mongoose = require('mongoose');
var dotenv = require('dotenv');
var path = require('path');
var User = require('../models/User');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const createSuperAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        const email = 'kaushal.tech@thedflgroup.com';
        const password = 'DFL@Super2024';
        
        let user = await User.findOne({ email });

        if (user) {
            console.log('User exists. Updating credentials and privileges...');
            user.password = password; // Will be hashed by pre-save
            user.isAdmin = true;
            user.kycVerified = true;
            user.role = 'Super Admin'; // Just in case, though schema doesn't strict check it
            await user.save();
            console.log('User updated successfully.');
        } else {
            console.log('User does not exist. Creating new Super Admin...');
            user = await User.create({
                name: 'Kaushal Tech',
                email: email,
                password: password,
                phone: '9999999999',
                customerId: 'DFLC-SUPER01',
                isAdmin: true,
                kycVerified: true,
                tag: 'Platinum'
            });
            console.log('User created successfully.');
        }
        
        console.log(`
        Email: ${email}
        Password: ${password}
        Role: Super Admin (isAdmin: true)
        Customer ID: ${user.customerId}
        `);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        process.exit();
    }
};

createSuperAdmin();
