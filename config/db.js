const mongoose = require('mongoose');
const dns = require('dns');

// Prevent querySrv ECONNREFUSED on local Wi-Fi/ISP networks for MongoDB Atlas
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    // Ignore if not supported in environment
}
const connectDB = async () => {
    // In test environment, in-memory MongoDB is managed by tests/setup.js
    if (process.env.NODE_ENV === 'test') {
        return;
    }

    // Increase command buffering timeout to 60s
    mongoose.set('bufferTimeoutMS', 60000);

    const maxRetries = 10;
    let retries = 0;

    while (retries < maxRetries) {
        try {
            const mongoURI = process.env.MONGO_URI;
            if (!mongoURI) {
                throw new Error('MONGO_URI is not defined in environment variables');
            }

            if (retries === 0) {
                const maskedURI = mongoURI.replace(/:([^@]+)@/, ':****@');
                console.log(`[DB] Attempting to connect to: ${maskedURI}`);
            }

            console.log(`[DB] Establishing Mongoose connection... (Attempt ${retries + 1})`);

            const conn = await mongoose.connect(mongoURI, {
                serverSelectionTimeoutMS: 60000,
                socketTimeoutMS: 60000,
                maxPoolSize: 10,
            });
            console.log(`[DB] MongoDB Connected Successfully: ${conn.connection.host}`);
            return; // Success!
        } catch (error) {
            retries++;
            console.error(`[DB] Connection Error: ${error.message}`);
            if (retries >= maxRetries) {
                console.error('[DB] Max retries reached. Server will continue but DB-related actions will fail.');
                return;
            }
            console.log(`[DB] Retrying in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

module.exports = connectDB;
