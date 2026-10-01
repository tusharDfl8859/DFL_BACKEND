const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');
const dotenv = require('dotenv');

// Load env vars
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RateZone = require('../models/RateZone');
const RateTable = require('../models/RateTable');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Database connection failed', err);
        process.exit(1);
    }
};

const importData = async () => {
    await connectDB();

    const filePath = path.join(__dirname, '..', '..', 'Our Rate Chart (1).xlsx');
    console.log(`Loading Excel from: ${filePath}`);

    if (!require('fs').existsSync(filePath)) {
        console.error('File not found');
        process.exit(1);
    }

    const workbook = xlsx.readFile(filePath);

    try {
        // --- 1. Import Zones ---
        console.log('Importing Zones...');
        await RateZone.deleteMany({}); // Clear old data

        const stateSheet = workbook.Sheets['State Code'];
        const stateData = xlsx.utils.sheet_to_json(stateSheet);

        const zoneDocs = [];
        const potentialZoneCols = ['TUS 2', 'TUS 3', 'TUS 4', 'TUS 5', 'TUS 6', 'TUS 7', 'TUS 8'];

        stateData.forEach(row => {
            // US States (Wide format)
            potentialZoneCols.forEach(zone => {
                if (row[zone]) {
                    const stateCode = row[zone].toString().trim().toUpperCase();
                    if (stateCode.length <= 3) {
                        zoneDocs.push({
                            country: 'US',
                            state: stateCode,
                            zone: zone
                        });
                    }
                }
            });

            // Australia (Long format)
            if (row['Post Code'] && row['Price Zone']) {
                zoneDocs.push({
                    country: 'AU',
                    postcode: String(row['Post Code']).trim(),
                    zone: row['Price Zone'].toString().trim()
                });
            }
        });

        if (zoneDocs.length > 0) {
            await RateZone.insertMany(zoneDocs);
            console.log(`Imported ${zoneDocs.length} zone mappings`);
        }

        // --- 2. Import Rates ---
        console.log('Importing Rate Table...');
        await RateTable.deleteMany({}); // Clear old data

        const rateSheet = workbook.Sheets['USA DIRECT'];
        const rateData = xlsx.utils.sheet_to_json(rateSheet);

        const rateDocs = [];

        rateData.forEach(row => {
            const weight = parseFloat(row['Weight ']);
            if (!isNaN(weight)) {
                // Remove 'Weight ' key to keep only clean rates map
                const rates = { ...row };
                delete rates['Weight '];

                // Clean up string numbers if parsed as strings
                for (const key in rates) {
                    if (rates[key]) rates[key] = Number(rates[key]);
                }

                rateDocs.push({
                    weight: weight,
                    rates: rates
                });
            }
        });

        if (rateDocs.length > 0) {
            await RateTable.insertMany(rateDocs);
            console.log(`Imported ${rateDocs.length} rate steps`);
        }

        console.log('SUCCESS: Data migration complete');
        process.exit(0);

    } catch (error) {
        console.error('Import failed:', error);
        process.exit(1);
    }
};

importData();
