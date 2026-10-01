const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const excelPath = path.join(__dirname, '..', '..', 'DFL Express Rate Card  (1).xlsx');
const jsonPath = path.join(__dirname, '..', 'config', 'australia_zones.json');

console.log(`Loading Excel from: ${excelPath}`);
if (!fs.existsSync(excelPath)) {
    console.error('Excel file not found');
    process.exit(1);
}

// Load Excel
const workbook = xlsx.readFile(excelPath);
const sheetName = 'Australia skynet state code';
const sheet = workbook.Sheets[sheetName];

if (!sheet) {
    console.error(`Sheet "${sheetName}" not found!`);
    process.exit(1);
}

// Parse Rows
// Structure: Row 0 ["ZONE LIST"], Row 1 ["ZIPCODE", "ZONE"], Row 2+ Data
const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

const newSkynetZones = {};
let count = 0;

rows.forEach((row, index) => {
    // Skip header rows (0 and 1)
    if (index < 2) return;

    const postcodeRaw = row[0];
    const zoneRaw = row[1];

    if (postcodeRaw && zoneRaw) {
        // Normalize Postcode: Ensure 4 digits (e.g., 800 -> "0800")
        let postcode = postcodeRaw.toString().trim();
        if (/^\d+$/.test(postcode)) {
            postcode = postcode.padStart(4, '0');
        }

        // Normalize Zone: "ZONE 1" -> "S AUS1"
        let zone = zoneRaw.toString().trim().toUpperCase();
        if (zone === 'ZONE 1') zone = 'S AUS1';
        else if (zone === 'ZONE 2') zone = 'S AUS2';
        else if (zone === 'ZONE 3') zone = 'S AUS3';
        // Add more mappings if needed, or fallback to raw if already correct format

        newSkynetZones[postcode] = zone;
        count++;
    }
});

console.log(`Parsed ${count} Skynet AU zones.`);

// Load Existing JSON
console.log(`Loading JSON config: ${jsonPath}`);
let config = {};
if (fs.existsSync(jsonPath)) {
    try {
        config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
        console.error('Error parsing JSON, starting fresh object', e);
    }
}

// Update skynet_aus
config.skynet_aus = newSkynetZones;
// Add metadata count for verification
config.skynet_aus_count = count;

// Write back
fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2));
console.log('SUCCESS: Updated australia_zones.json');
