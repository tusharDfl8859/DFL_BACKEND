const mongoose = require('mongoose');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv'); // Ensure dotenv is installed or used
const RateZone = require('../models/RateZone');
const RateTable = require('../models/RateTable');

// Load env vars
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const deployToProd = async () => {
    try {
        console.log('--- STARTING PRODUCTION DEPLOYMENT ---');
        console.log(`Target Database: ${process.env.MONGO_URI}`);

        if (!process.env.MONGO_URI) {
            throw new Error('MONGO_URI is undefined. Please check your .env file.');
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // --- STEP 1: Full Rate & Zone Reset (Standard) ---
        console.log('\n--- STEP 1: IMPORTING STANDARD RATES & ZONES (Master Reset) ---');

        const excelPath = path.join(__dirname, '..', '..', 'updated rate card (1).xlsx');
        if (!fs.existsSync(excelPath)) {
            throw new Error(`Rate Card file not found at: ${excelPath}`);
        }
        console.log(`Reading Excel: ${excelPath}`);
        const workbook = xlsx.readFile(excelPath);

        // 1.1 Clear Everything
        console.log('Clearing ALL RateZones and RateTables...');
        await RateZone.deleteMany({});
        await RateTable.deleteMany({});

        const zoneDocs = [];

        // 1.2 Import USA
        const usSheet = workbook.Sheets['USA State Code'] || workbook.Sheets['State Code'];
        if (usSheet) {
            const usData = xlsx.utils.sheet_to_json(usSheet);
            const usZones = ['TUS 2', 'TUS 3', 'TUS 4', 'TUS 5', 'TUS 6', 'TUS 7', 'TUS 8'];
            usData.forEach(row => {
                usZones.forEach(zone => {
                    if (row[zone]) {
                        const stateCode = row[zone].toString().trim().toUpperCase();
                        if (stateCode.length === 2) {
                            zoneDocs.push({ country: 'US', state: stateCode, zone: zone });
                        }
                    }
                });
            });
            console.log(`Prepared ${zoneDocs.length} US mappings`);
        }

        // 1.3 Import Australia (Standard)
        const auSheet = workbook.Sheets['Australia State Code'];
        if (auSheet) {
            const auData = xlsx.utils.sheet_to_json(auSheet);
            let auCount = 0;
            auData.forEach(row => {
                if (row['Post Code'] && row['Price Zone']) {
                    zoneDocs.push({
                        country: 'AU',
                        postcode: String(row['Post Code']).trim(),
                        zone: row['Price Zone'].toString().trim()
                    });
                    auCount++;
                }
            });
            console.log(`Prepared ${auCount} AU mappings`);
        }

        // 1.4 Import NZ
        const nzSheet = workbook.Sheets['New Zeland State Code'];
        if (nzSheet) {
            const nzData = xlsx.utils.sheet_to_json(nzSheet);
            let nzCount = 0;
            nzData.forEach(row => {
                if (row[' NZ  POSTCODE'] && row['Zone']) {
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
                    nzCount++;
                }
            });
            console.log(`Prepared ${nzCount} NZ mappings`);
        }

        // 1.5 Import Canada
        const caSheet = workbook.Sheets['canada zone'];
        if (caSheet) {
            const rows = xlsx.utils.sheet_to_json(caSheet, { header: 1 });
            let caCount = 0;
            rows.forEach((row, index) => {
                if (index < 2) return;
                const fsa = row[0];
                const destZone = row[1];
                if (fsa && destZone) {
                    const fsaStr = fsa.toString().trim();
                    if (fsaStr.length >= 3) {
                        const numMatch = destZone.match(/\d+/);
                        if (numMatch) {
                            const zoneNum = parseInt(numMatch[0], 10);
                            zoneDocs.push({
                                country: 'CA',
                                postcode: fsaStr.substring(0, 3).toUpperCase(),
                                zone: `S CA ${zoneNum}`
                            });
                            caCount++;
                        }
                    }
                }
            });
            console.log(`Prepared ${caCount} CA mappings`);
        }

        // Insert Standard Zones
        if (zoneDocs.length > 0) {
            await RateZone.insertMany(zoneDocs);
            console.log(`✅ Imported ${zoneDocs.length} Standard Zones`);
        }

        // 1.6 Import Rate Table
        const rateSheet = workbook.Sheets['Price Chart'];
        const rateData = xlsx.utils.sheet_to_json(rateSheet);
        const rateDocs = [];
        rateData.forEach(row => {
            const weightVal = row['Weight'] || row['Weight '];
            const weight = parseFloat(weightVal);
            if (!isNaN(weight)) {
                const rates = { ...row };
                delete rates['Weight']; delete rates['Weight '];
                for (const key in rates) {
                    if (rates[key] === null || rates[key] === undefined || rates[key] === '') delete rates[key];
                    else rates[key] = parseFloat(rates[key]);
                }
                rateDocs.push({ weight, rates });
            }
        });

        if (rateDocs.length > 0) {
            await RateTable.insertMany(rateDocs);
            console.log(`✅ Imported ${rateDocs.length} Rate Steps`);
        }

        // --- STEP 2: Skynet AU Allowlist ---
        console.log('\n--- STEP 2: IMPORTING SKYNET AU ZONES (Allowlist) ---');

        const csvPath = path.join(__dirname, '../../Untitled spreadsheet - Sheet1.csv');
        if (!fs.existsSync(csvPath)) {
            throw new Error(`CSV file not found at: ${csvPath}`);
        }
        console.log(`Reading CSV: ${csvPath}`);

        // We do NOT clear all RateZones here, only SK_AU
        await RateZone.deleteMany({ country: 'SK_AU' });

        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');

        if (lines.length > 1) {
            const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            const postcodeIndex = headers.findIndex(h => h.toLowerCase() === 'postcode');
            const zoneIndex = headers.findIndex(h => h.toLowerCase().includes('intl zone'));

            if (postcodeIndex === -1 || zoneIndex === -1) {
                console.warn('⚠️  Could not find Postcode or Zone columns in CSV. Skynet import skipped.');
            } else {
                const zoneMap = { 'Capital': 'S AUS1', 'Metro': 'S AUS2', 'Regional': 'S AUS3' };
                const skDocs = [];
                const seen = new Set();

                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
                    if (cols.length <= Math.max(postcodeIndex, zoneIndex)) continue;

                    const postcode = cols[postcodeIndex];
                    const zoneType = cols[zoneIndex];

                    if (!postcode || !zoneType) continue;

                    let cleanPostcode = postcode;
                    if (/^\d+$/.test(cleanPostcode)) cleanPostcode = cleanPostcode.padStart(4, '0');

                    if (seen.has(cleanPostcode)) continue;

                    const targetZone = zoneMap[zoneType];
                    if (targetZone) {
                        skDocs.push({
                            country: 'SK_AU',
                            postcode: cleanPostcode,
                            zone: targetZone
                        });
                        seen.add(cleanPostcode);
                    }
                }

                if (skDocs.length > 0) {
                    await RateZone.insertMany(skDocs);
                    console.log(`✅ Imported ${skDocs.length} Skynet AU Virtual Zones`);
                }
            }
        }

        console.log('\n🎉 DEPLOYMENT COMPLETE 🎉');
        process.exit(0);

    } catch (error) {
        console.error('\n❌ DEPLOYMENT FAILED:', error.message);
        process.exit(1);
    }
};

deployToProd();
