const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const RateZone = require('../models/RateZone');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const importSkynetZones = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const csvPath = path.join(__dirname, '../../Untitled spreadsheet - Sheet1.csv');
        console.log('Reading CSV from:', csvPath);

        if (!fs.existsSync(csvPath)) {
            console.error('CSV file not found');
            process.exit(1);
        }

        // 1. Clear existing SK_AU zones to avoid duplicates/stale data
        console.log('Clearing old SK_AU zones...');
        await RateZone.deleteMany({ country: 'SK_AU' });

        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');

        if (lines.length < 2) {
            console.log('CSV empty');
            return;
        }

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const postcodeIndex = headers.findIndex(h => h.toLowerCase() === 'postcode');
        const zoneIndex = headers.findIndex(h => h.toLowerCase().includes('intl zone')); // 'lookup INTL Zone'

        if (postcodeIndex === -1 || zoneIndex === -1) {
            console.error('Missing Postcode or Zone column');
            process.exit(1);
        }

        const zoneMap = {
            'Capital': 'S AUS1',
            'Metro': 'S AUS2',
            'Regional': 'S AUS3'
        };

        const docsToInsert = [];
        const seenPostcodes = new Set();

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));

            if (cols.length <= Math.max(postcodeIndex, zoneIndex)) continue;

            const postcode = cols[postcodeIndex];
            const zoneType = cols[zoneIndex];

            if (!postcode || !zoneType) continue;

            // Normalize Postcode (ensure 4 digits? or just take as is? CSV has 800 for 0800)
            // RateCalculator generally expects what user inputs. 
            // If user types 0800, we need to match 800 or 0800.
            // Let's store AS IS from CSV first. If needed we can normalize. 
            // Previous check showed CSV has '800'. 
            // Ideally we should pad to 4 digits for consistency if user inputs '0800'.

            let cleanPostcode = postcode;
            // logic to ensure 4 digits for AU postcodes if it's numeric
            if (/^\d+$/.test(cleanPostcode)) {
                cleanPostcode = cleanPostcode.padStart(4, '0');
            }

            if (seenPostcodes.has(cleanPostcode)) continue; // Avoid dupes

            const targetZone = zoneMap[zoneType];
            if (targetZone) {
                docsToInsert.push({
                    country: 'SK_AU', // Virtual Country
                    postcode: cleanPostcode,
                    zone: targetZone
                });
                seenPostcodes.add(cleanPostcode);
            }
        }

        if (docsToInsert.length > 0) {
            await RateZone.insertMany(docsToInsert);
            console.log(`Successfully imported ${docsToInsert.length} Skynet AU zones.`);
        } else {
            console.log('No valid records found to import.');
        }

    } catch (error) {
        console.error('Import Failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected');
    }
};

importSkynetZones();
