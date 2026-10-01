const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SOURCE_DB = 'test';
const DEST_DB = 'dfl_staging';

const cloneDatabase = async () => {
    try {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error('MONGO_URI not found in .env');
        }

        // 1. Connect to Source DB
        console.log(`Connecting to SOURCE database: ${SOURCE_DB}...`);
        const sourceConn = await mongoose.createConnection(mongoUri, { dbName: SOURCE_DB }).asPromise();
        console.log('Connected to Source.');

        // 2. Connect to Destination DB
        console.log(`Connecting to DESTINATION database: ${DEST_DB}...`);
        // Append or replace dbName in URI isn't enough for createConnection if we want distinct handles easily,
        // but createConnection with { dbName } works perfectly.
        const destConn = await mongoose.createConnection(mongoUri, { dbName: DEST_DB }).asPromise();
        console.log('Connected to Destination.');

        // 3. Get list of collections from Source
        const collections = await sourceConn.db.listCollections().toArray();
        console.log(`Found ${collections.length} collections in source.`);

        for (const colInfo of collections) {
            const colName = colInfo.name;
            if (colName.startsWith('system.')) continue; // Skip system collections

            console.log(`Cloning collection: ${colName}...`);

            // Fetch all documents from Source
            const sourceModel = sourceConn.model(colName, new mongoose.Schema({}, { strict: false }), colName);
            const docs = await sourceModel.find().lean();

            if (docs.length === 0) {
                console.log(`  - Skipping empty collection ${colName}`);
                continue;
            }

            // Insert into Destination
            // We define a model for destination to easily insert
            const destModel = destConn.model(colName, new mongoose.Schema({}, { strict: false }), colName);

            // Optional: Drop dest collection if it exists to ensure a clean clone?
            // User said "replica", usually implies fresh state.
            await destModel.deleteMany({});

            // Batch insert
            const BATCH_SIZE = 100;
            for (let i = 0; i < docs.length; i += BATCH_SIZE) {
                const batch = docs.slice(i, i + BATCH_SIZE);
                await destModel.insertMany(batch);
            }
            console.log(`  - Copied ${docs.length} documents.`);
        }

        console.log('\nDatabase Clone Completed Successfully!');
        console.log(`You can now verify the data in '${DEST_DB}'.`);

        await sourceConn.close();
        await destConn.close();
        process.exit(0);

    } catch (err) {
        console.error('Clone failed:', err);
        process.exit(1);
    }
};

cloneDatabase();
