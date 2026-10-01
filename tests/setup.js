const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongoServer;

process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-jest';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/test-db';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
process.env.PORT = process.env.PORT || '5001';

// Connect to the in-memory database before running any tests.
beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({
        instanceOpts: [{
            ip: '127.0.0.1'
        }],
        replSet: {
            count: 1
        }
    });
    // explicit usage of the URI for the in-memory instance
    const uri = mongoServer.getUri();

    // Ensure we are not connected to any other DB
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    await mongoose.connect(uri);
}, 120000);

// Close the connection and stop the in-memory database after all tests are done.
afterAll(async () => {
    try {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    } catch (_) {}
    if (mongoServer) {
        try {
            await mongoServer.stop({ force: true });
        } catch (_) {}
    }
}, 120000);

// Clear all data after every test to ensure isolation.
afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        const collection = collections[key];
        await collection.deleteMany();
    }
});
