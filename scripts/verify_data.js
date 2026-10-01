const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const RateZone = require('../models/RateZone');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const verifyData = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const csvPath = path.join(__dirname, '../../Untitled spreadsheet - Sheet1.csv');
        console.log('Reading CSV from:', csvPath);

        if (!fs.existsSync(csvPath)) {
            console.error('CSV file not found at path:', csvPath);
            return;
        }

        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');

        if (lines.length < 2) {
            console.log('CSV file is empty or has only header');
            return;
        }

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        console.log('Headers:', headers);

        const postcodeIndex = headers.findIndex(h => h.toLowerCase() === 'postcode');

        if (postcodeIndex === -1) {
            console.error('Could not find Postcode column');
            return;
        }

        let foundCount = 0;
        let missingCount = 0;
        const missingRecords = [];

        console.log(`Processing ${lines.length - 1} records...`);

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));

            if (cols.length <= postcodeIndex) continue;

            const postcode = cols[postcodeIndex];

            if (!postcode) continue;

            // Search in RateZone
            // DB for AU does NOT have state field, so we search by Postcode only + Country AU.
            const match = await RateZone.findOne({
                country: 'AU',
                postcode: postcode
            });

            if (match) {
                foundCount++;
            } else {
                missingCount++;
                missingRecords.push(lines[i]);
            }

            if (i % 500 === 0) {
                process.stdout.write(`Processed ${i} records...\r`);
            }
        }
        console.log('');

        console.log('==================================================');
        console.log(`TOTAL RECORDS CHECKED : ${lines.length - 1}`);
        console.log(`MATCHED IN DB         : ${foundCount}`);
        console.log(`MISSING IN DB         : ${missingCount}`);
        console.log('==================================================');

        if (missingCount > 0) {
            console.log(`\nDisplaying first 20 missing records:`);
            console.log(headers.join(','));
            missingRecords.slice(0, 20).forEach(r => console.log(r));
        }

    } catch (error) {
        console.error('Script Failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
};

verifyData();
