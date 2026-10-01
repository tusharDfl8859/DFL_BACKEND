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
        console.log(`Connecting to Mongo URI: ${process.env.MONGO_URI}`);
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Database connection failed', err);
        process.exit(1);
    }
};

const importData = async () => {
    await connectDB();

    const filePath = path.join(__dirname, '..', '..', 'updated rate card (1).xlsx');
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

        const zoneDocs = [];

        // A. US States ('State Code' or 'Sheet 3')
        // I'll look for 'State Code' first, fallback to 'Sheet 3' if named differently in this version
        // Based on inspection, it might be named 'Sheet 3' or 'State Code'. 
        // My previous inspection check_sheet1.js showed Sheet Names. Let's assume standard names or check.
        // Actually, the workbook inspection showed names: "Sheet1", "Sheet2", "Sheet3", "Australia State Code", "New Zeland State Code", "canada zone".
        // "Sheet3" contained US info likely. Let's try to identify by content if needed, or stick to names I saw.

        // MAPPING: 
        // Sheet1 -> Price Chart (checked)
        // Sheet2 -> Coulum Values (checked)
        // Sheet3 -> US Zones (Assumed based on previous knowledge, let's Verify content if needed, but usually is)
        // "Australia State Code" -> AU
        // "New Zeland State Code" -> NZ
        // "canada zone" -> CA

        const usSheet = workbook.Sheets['USA State Code'] || workbook.Sheets['State Code'];
        if (usSheet) {
            const usData = xlsx.utils.sheet_to_json(usSheet);
            const usZones = ['TUS 2', 'TUS 3', 'TUS 4', 'TUS 5', 'TUS 6', 'TUS 7', 'TUS 8'];

            usData.forEach(row => {
                usZones.forEach(zone => {
                    if (row[zone]) {
                        const stateCode = row[zone].toString().trim().toUpperCase();
                        // Basic validation: US State codes are 2 chars usually.
                        if (stateCode.length === 2) {
                            zoneDocs.push({
                                country: 'US',
                                state: stateCode,
                                zone: zone
                            });
                        }
                    }
                });
            });
            console.log(`- Prepared US mappings`);
        } else {
            console.warn('WARNING: US Sheet not found (Sheet3/State Code)');
        }

        // B. Australia
        const auSheet = workbook.Sheets['Australia State Code'];
        if (auSheet) {
            const auData = xlsx.utils.sheet_to_json(auSheet);
            auData.forEach(row => {
                if (row['Post Code'] && row['Price Zone']) {
                    zoneDocs.push({
                        country: 'AU',
                        postcode: String(row['Post Code']).trim(),
                        zone: row['Price Zone'].toString().trim()
                    });
                }
            });
            console.log(`- Prepared AU mappings`);
        }

        // C. New Zealand
        const nzSheet = workbook.Sheets['New Zeland State Code'];
        if (nzSheet) {
            const nzData = xlsx.utils.sheet_to_json(nzSheet);
            nzData.forEach(row => {
                if (row[' NZ  POSTCODE'] && row['Zone']) {
                    // Mapping "ZONE 1" -> "TNZ1" to match column headers is key?
                    // The Price Chart has columns "TNZ1", "TNZ2", "TNZ3".
                    // The AU/NZ sheet has "ZONE 1". We need to normalize.
                    let zoneParams = row['Zone'].toString().toUpperCase();
                    let finalZone = zoneParams;

                    if (zoneParams.includes('ZONE 1')) finalZone = 'TNZ1';
                    else if (zoneParams.includes('ZONE 2')) finalZone = 'TNZ2';
                    else if (zoneParams.includes('ZONE 3')) finalZone = 'TNZ3';

                    zoneDocs.push({
                        country: 'NZ',
                        postcode: String(row[' NZ  POSTCODE']).trim(),
                        zone: finalZone
                    });
                }
            });
            console.log(`- Prepared NZ mappings`);
        }

        // D. Canada
        const caSheet = workbook.Sheets['canada zone'];
        if (caSheet) {
            // Use array of arrays (header: 1) to manually handle data structure
            const rows = xlsx.utils.sheet_to_json(caSheet, { header: 1 });
            console.log(`Debug CA: Found ${rows.length} rows`);

            // Expected structure:
            // Row 0: ["YUL"]
            // Row 1: ["Dest FSA", " Dest Zone"]
            // Row 2+: ["A0A", "D16"] ...

            rows.forEach((row, index) => {
                if (index < 2) return; // Skip title and header rows

                const fsa = row[0]; // First column
                const destZone = row[1]; // Second column

                if (fsa && destZone) {
                    // Start of FSA regex (3 chars)
                    const fsaStr = fsa.toString().trim();
                    if (fsaStr.length >= 3) {
                        const cleanFsa = fsaStr.substring(0, 3).toUpperCase();

                        const numMatch = destZone.match(/\d+/);
                        if (numMatch) {
                            const zoneNum = parseInt(numMatch[0], 10); // Strip leading zeros: "03" -> 3
                            const finalZone = `S CA ${zoneNum}`;

                            // Avoid duplicates if needed, but array push is fast
                            zoneDocs.push({
                                country: 'CA',
                                postcode: cleanFsa,
                                zone: finalZone
                            });
                        }
                    }
                }
            });
            console.log(`- Prepared CA mappings: ${zoneDocs.filter(z => z.country === 'CA').length} found`);
        }


        if (zoneDocs.length > 0) {
            await RateZone.insertMany(zoneDocs);
            console.log(`Imported ${zoneDocs.length} zone mappings`);
        }

        // --- 2. Import Rates ---
        console.log('Importing Rate Table...');
        await RateTable.deleteMany({}); // Clear old data

        const rateSheet = workbook.Sheets['Price Chart']; // 'Price Chart' is the actual name
        const rateData = xlsx.utils.sheet_to_json(rateSheet);

        const rateDocs = [];

        rateData.forEach(row => {
            // 'Weight' column might be "Weight" or "Weight "
            const weightVal = row['Weight'] || row['Weight '];
            const weight = parseFloat(weightVal);

            if (!isNaN(weight)) {
                // Remove Weight key
                const rates = { ...row };
                delete rates['Weight'];
                delete rates['Weight '];

                // Sanitize rates
                for (const key in rates) {
                    if (rates[key] === null || rates[key] === undefined || rates[key] === '') {
                        delete rates[key];
                    } else {
                        // Ensure number
                        rates[key] = parseFloat(rates[key]);
                    }
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
