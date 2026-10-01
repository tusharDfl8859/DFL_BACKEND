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

    const filePath = path.join(__dirname, '..', '..', 'DFL Express Rate Card  (1).xlsx');
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

        // --- A. US States ---
        const usSheet = workbook.Sheets['USA State Code'];
        if (usSheet) {
            const usData = xlsx.utils.sheet_to_json(usSheet);
            const usZones = ['TUS 2', 'TUS 3', 'TUS 4', 'TUS 5', 'TUS 6', 'TUS 7', 'TUS 8'];

            usData.forEach(row => {
                usZones.forEach(zone => {
                    if (row[zone]) {
                        const stateCode = row[zone].toString().trim().toUpperCase();
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
            console.log(`- Prepared US mappings: ${zoneDocs.filter(z => z.country === 'US').length}`);
        } else {
            console.warn('WARNING: Sheet "USA State Code" not found');
        }

        // --- B. Australia ---
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
            console.log(`- Prepared AU mappings: ${zoneDocs.filter(z => z.country === 'AU').length}`);
        } else {
            console.warn('WARNING: Sheet "Australia State Code" not found');
        }

        // --- C. New Zealand ---
        const nzSheet = workbook.Sheets['New Zeland State Code'];
        if (nzSheet) {
            const nzData = xlsx.utils.sheet_to_json(nzSheet);
            nzData.forEach(row => {
                if (row[' NZ  POSTCODE'] && row['Zone']) {
                    let zoneStr = row['Zone'].toString().toUpperCase();
                    let finalZone = zoneStr;

                    // Map "ZONE 1" -> TNZ1, etc.
                    if (zoneStr.includes('ZONE 1')) finalZone = 'TNZ1';
                    else if (zoneStr.includes('ZONE 2')) finalZone = 'TNZ2';
                    else if (zoneStr.includes('ZONE 3')) finalZone = 'TNZ3';

                    zoneDocs.push({
                        country: 'NZ',
                        postcode: String(row[' NZ  POSTCODE']).trim(),
                        zone: finalZone
                    });
                }
            });
            console.log(`- Prepared NZ mappings: ${zoneDocs.filter(z => z.country === 'NZ').length}`);
        } else {
            console.warn('WARNING: Sheet "New Zeland State Code" not found');
        }

        // --- D. Canada ---
        const caSheet = workbook.Sheets['canada zone'];
        if (caSheet) {
            const rows = xlsx.utils.sheet_to_json(caSheet, { header: 1 });
            // Skip title/header rows (usually top 2 based on inspection)
            
            rows.forEach((row, index) => {
                if (index < 2) return;

                const fsa = row[0]; 
                const destZone = row[1];

                if (fsa && destZone) {
                    const fsaStr = fsa.toString().trim().toUpperCase();
                    if (fsaStr.length >= 3) {
                         const cleanFsa = fsaStr.substring(0, 3);
                         
                         // Map "D12" -> "S CA 12"
                         const numMatch = destZone.toString().match(/\d+/);
                         if (numMatch) {
                             const zoneNum = parseInt(numMatch[0], 10);
                             const finalZone = `S CA ${zoneNum}`;
                             
                             zoneDocs.push({
                                country: 'CA',
                                postcode: cleanFsa,
                                zone: finalZone
                            });
                         }
                    }
                }
            });
            console.log(`- Prepared CA mappings: ${zoneDocs.filter(z => z.country === 'CA').length}`);
        } else {
             console.warn('WARNING: Sheet "canada zone" not found');
        }

        if (zoneDocs.length > 0) {
            await RateZone.insertMany(zoneDocs);
            console.log(`Successfully imported ${zoneDocs.length} total zone mappings`);
        }


        // --- 2. Import Rates ---
        console.log('Importing Rate Table...');
        await RateTable.deleteMany({});

        const rateSheet = workbook.Sheets['Price Chart'];
        if (!rateSheet) {
            console.error('Rate sheet "Price Chart" not found');
            process.exit(1);
        }

        // Use header:1 to handle headers explicitly
        const rateRows = xlsx.utils.sheet_to_json(rateSheet, { header: 1 });
        const headers = rateRows[0];
        
        // Note: Headers in the Excel file are already unique (e.g. TNZ1, TNZ2, TNZ3)
        // so we use them directly.

        const rateDocs = [];

        // Iterate data rows (skip header)
        for (let i = 1; i < rateRows.length; i++) {
            const row = rateRows[i];
            if (!row || row.length === 0) continue;

            const rowObj = {};
            // Map row values to headers
            headers.forEach((key, idx) => {
                if (key) rowObj[key] = row[idx];
            });

            // Extract Weight. Key might be "Weight" or "Weight " depending on exact cell content.
            // Based on inspection, it's "Weight " (with space) or stripped by xlsx.
            // Safest: iterate keys to find one that starts with "Weight"
            let weightVal = null;
            let weightKey = null;
            
            for(const k of Object.keys(rowObj)) {
                if(k.toString().trim() === 'Weight') {
                    weightVal = rowObj[k];
                    weightKey = k;
                    break;
                }
            }

            const weight = parseFloat(weightVal);
            
            if (!isNaN(weight)) {
                // remove weight from rates
                const rates = {};
                
                for (const key of headers) {
                    if (!key) continue;
                    const keyStr = key.toString();
                    if (keyStr === weightKey || keyStr.startsWith('__EMPTY')) continue;
                    
                    const val = rowObj[key];
                    if (val !== undefined && val !== null && val !== '') {
                        const numVal = parseFloat(val);
                        if (!isNaN(numVal)) {
                            rates[keyStr] = numVal;
                        }
                    }
                }

                rateDocs.push({
                    weight: weight,
                    rates: rates
                });
            }
        }

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
