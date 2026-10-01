const RateTable = require('../../models/RateTable');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

/**
 * Controller to import Skynet Ecommerce rates from Excel
 */
const importEcommerceRates = async (req, res) => {
    try {
        let workbook;
        if (req.file) {
            // If uploaded via API
            workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        } else {
            // Fallback to local file if it exists (for testing/direct trigger)
            const localPath = path.join(__dirname, '../../../Ecommerce Rates_19012026.xlsx');
            if (fs.existsSync(localPath)) {
                workbook = XLSX.readFile(localPath);
            } else {
                return res.status(400).json({ message: 'No Excel file provided or found at expected location.' });
            }
        }

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        // Mapping from Excel header (row 3) to our zone codes in service_config.json
        // Note: The Excel structure found in dump_excel.js:
        // Row 2 (index 2) contains country names
        const headerRow = data[2];
        const countryMapping = {
            "USA -GA": "S USA-GA",
            "USA PM": "S USA-PM",
            "USA-Saver": "S USA-Saver",
            "CA": "S CA",
            "GB": "S GB",
            "GB_Evri": "S GB_Evri",
            "MY": "S MY",
            "SG": "S SG",
            "Australia": "S AU",
            "DXB": "S UAE",
            "Austria": "S AUT",
            "Belgium": "S BEL",
            "Bulgaria": "S BGR",
            "Croatia": "S HRV",
            "Cyprus": "S CYP",
            "Czech Republic": "S CZE",
            "Denmark": "S DNK",
            "Estonia": "S EST",
            "Finland": "S FIN",
            "France": "S FRA",
            "Germany": "S DEU",
            "Greece": "S GRC",
            "Hungary": "S HUN",
            "Ireland": "S IRL",
            "Italy ": "S ITA",
            "Latvia": "S LVA",
            "Lithuania": "S LTU",
            "Luxembourg": "S LUX",
            "Malta": "S MLT",
            "Netherlands": "S NLD",
            "Poland": "S POL",
            "Portugal": "S PRT",
            "Romania": "S ROU",
            "Slovakia": "S SVK",
            "Slovenia": "S SVN",
            "Spain": "S ESP",
            "Sweden": "S SWE"
        };

        // Determine which columns map to which zones
        const activeColumns = [];
        headerRow.forEach((cell, idx) => {
            if (idx === 0) return; // Skip weight column
            const zoneCode = countryMapping[cell?.trim()];
            if (zoneCode) {
                activeColumns.push({ index: idx, zone: zoneCode });
            }
        });
        // Process data rows (starting from row 5 index 5)
        let successCount = 0;
        for (let i = 5; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0) continue;

            const weightG = parseFloat(row[0]);
            if (isNaN(weightG)) continue;

            const weightKg = weightG / 1000;

            // Find or create rate row for this weight
            let rateDoc = await RateTable.findOne({ weight: weightKg });
            if (!rateDoc) {
                rateDoc = new RateTable({ weight: weightKg, rates: new Map() });
            }

            // Update rates for each active column
            activeColumns.forEach(col => {
                const rate = parseFloat(row[col.index]);
                if (!isNaN(rate)) {
                    rateDoc.rates.set(col.zone, rate);
                }
            });

            await rateDoc.save();
            successCount++;
        }
        res.json({
            message: `Rate import completed successfully.`,
            slabs: successCount,
            columns: activeColumns.length,
            mappedZones: activeColumns.map(c => c.zone)
        });

    } catch (err) {
        res.status(500).json({ message: 'Internal server error during rate import', error: err.message });
    }
};

module.exports = { importEcommerceRates };
