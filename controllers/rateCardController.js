const RateCard = require('../models/RateCard');
const xlsx = require('xlsx');

// Helper to extract ISO code from header like "Austria(AT)" -> "AT"
const extractIsoCode = (header) => {
    // Handle special cases
    if (header.includes('(U)')) return 'US';
    if (header.includes('(T)')) return 'GB';

    const match = header.match(/\(([A-Z]{2})\)/);
    if (match) return match[1];

    // Try to match single letter codes if needed, or just return trimmed header
    const matchSingle = header.match(/\(([A-Z]{1})\)/);
    if (matchSingle) {
        if (matchSingle[1] === 'U') return 'US';
    }

    return header.trim();
};

// @desc    Upload and process Excel rate sheet
// @route   POST /api/admin/rates/upload
// @access  Private/Admin
// @desc    Upload and process Excel rate sheet
// @route   POST /api/admin/rates/upload
// @access  Private/Admin
const uploadRateSheet = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Please upload an Excel file' });
        }

        // Read the file from buffer
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

        // --- 1. Import Zones (if sheet exists) ---
        // Strategy: If 'State Code' sheet exists, update Zones. Else skip.
        const RateZone = require('../models/RateZone');
        if (workbook.Sheets['State Code']) {
            await RateZone.deleteMany({}); // Clear old data

            const stateSheet = workbook.Sheets['State Code'];
            const stateData = xlsx.utils.sheet_to_json(stateSheet);
            const zoneDocs = [];
            const potentialZoneCols = ['TUS 2', 'TUS 3', 'TUS 4', 'TUS 5', 'TUS 6', 'TUS 7', 'TUS 8'];

            stateData.forEach(row => {
                // US States
                potentialZoneCols.forEach(zone => {
                    if (row[zone]) {
                        const stateCode = row[zone].toString().trim().toUpperCase();
                        if (stateCode.length <= 3) {
                            zoneDocs.push({ country: 'US', state: stateCode, zone: zone });
                        }
                    }
                });
                // Australia
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
            }
        }

        // --- 2. Import Rates ---
        // Assume first sheet is rates OR specific name? 
        // Existing Import Script used 'USA DIRECT'. Let's try 'USA DIRECT' first, else fallback to first sheet.
        let rateSheet = workbook.Sheets['USA DIRECT'];
        if (!rateSheet) {
            const sheetName = workbook.SheetNames[0];
            rateSheet = workbook.Sheets[sheetName];
        }

        if (!rateSheet) {
            return res.status(400).json({ message: 'No valid rate sheet found' });
        }

        const data = xlsx.utils.sheet_to_json(rateSheet);

        if (!data || data.length === 0) {
            return res.status(400).json({ message: 'Sheet is empty' });
        }

        // Use active RateTable model
        const RateTable = require('../models/RateTable');
        await RateTable.deleteMany({});

        const rateDocs = [];

        data.forEach(row => {
            // Find weight key
            const keys = Object.keys(row);
            const weightKey = keys.find(k => k.trim().toLowerCase() === 'weight') ||
                keys.find(k => k.trim().toLowerCase() === 'weight '); // strict, or 'Weight ' 

            // Fallback fuzzy
            let finalWeightKey = weightKey;
            if (!finalWeightKey) {
                finalWeightKey = keys.find(k => k.toLowerCase().includes('weight'));
            }

            if (!finalWeightKey) return;

            const weight = parseFloat(row[finalWeightKey]);

            if (!isNaN(weight)) {
                // Copy all other columns as rates = { UCA ecommerce: 100, TUS 2: 50... }
                const rates = { ...row };
                delete rates[finalWeightKey]; // Remove weight itself

                // Clean up numbers
                for (const key in rates) {
                    if (rates[key] !== undefined) {
                        // Parse Number, treat 0 as 0
                        const val = parseFloat(rates[key]);
                        rates[key] = isNaN(val) ? 0 : val;
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
        }

        // --- 3. Refresh Cache in RateCalculator ---
        // Since this is a live update, we must clear the in-memory cache so next request fetches from DB.
        const rateCalculator = require('../utils/rateCalculator');
        rateCalculator.lastLoaded = 0; // Force reload
        rateCalculator.zones = null;
        rateCalculator.rates = null;
        res.status(200).json({
            message: 'Rate sheet processed successfully (Active System Updated)',
            count: rateDocs.length,
            zonesUpdated: !!workbook.Sheets['State Code']
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error processing file' });
    }
};

// @desc    Calculate rate for a shipment
// @route   POST /api/rates/calculate-internal
// @access  Private
const calculateRateInternal = async (req, res) => {
    try {
        const { weight, countryCode } = req.body;

        if (!weight || !countryCode) {
            return res.status(400).json({ message: 'Weight and Country Code are required' });
        }

        // Find the slab
        const rateCard = await RateCard.findOne({
            minWeight: { $lte: weight },
            maxWeight: { $gte: weight }
        });

        if (!rateCard) {
            return res.status(404).json({ message: 'No rate found for this weight' });
        }

        // Get rate for the country
        // We try the ISO code directly
        let rate = rateCard.rates.get(countryCode);

        // If not found, maybe check for "Rest of World" or similar if implemented?
        // For now, exact match.

        if (rate === undefined || rate === null) {
            return res.status(404).json({ message: `No rate found for destination: ${countryCode}` });
        }

        res.json({
            weight,
            countryCode,
            rate,
            currency: 'INR' // Assuming rates are in INR based on context
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    uploadRateSheet,
    calculateRateInternal
};
