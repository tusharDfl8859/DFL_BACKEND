const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../config/service_config.json');
// Fix: User's file is in root, so go up two levels from Backend/scripts
const csvPath = path.join(__dirname, '../../service_config_export.csv');

try {
    const rawConfig = fs.readFileSync(configPath);
    let config = JSON.parse(rawConfig);

    console.log(`Reading CSV from: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');
    const headers = lines[0].trim().split(',').map(h => h.trim());

    const getVal = (row, headerName) => {
        const index = headers.indexOf(headerName);
        if (index === -1) return undefined;

        // Simple CSV parser respecting quotes
        let values = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < row.length; i++) {
            const char = row[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim());

        let val = values[index];
        if (val && val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
        }
        return val === '' ? undefined : val;
    };

    let addedCount = 0;
    let skippedCount = 0;

    for (let i = 1; i < lines.length; i++) {
        const row = lines[i];
        if (!row.trim()) continue;

        const provider = getVal(row, 'Provider');
        const code = getVal(row, 'Service Code');

        if (!provider || !code) continue;

        if (!config[provider]) {
            console.warn(`Provider ${provider} not found in config. Skipping.`);
            continue;
        }

        const existingServiceIndex = config[provider].services.findIndex(s => s.code === code);

        if (existingServiceIndex !== -1) {
            skippedCount++;
            continue;
        }

        // Add new service
        const newService = {
            code: code,
            country: getVal(row, 'Country'),
            transitTime: getVal(row, 'Transit Time'),
            type: getVal(row, 'Type'),
            partnerFullName: getVal(row, 'Partner'),
            zoneMatch: getVal(row, 'Zone Match')
        };

        const zone = getVal(row, 'Zone');
        if (zone) newService.zone = isNaN(Number(zone)) ? zone : Number(zone);

        // Cleanup undefined
        Object.keys(newService).forEach(key => newService[key] === undefined && delete newService[key]);

        config[provider].services.push(newService);
        addedCount++;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

    console.log(`✅ Import Complete.`);
    console.log(`➕ Added: ${addedCount}`);
    console.log(`⏭️ Skipped (Existing): ${skippedCount}`);

} catch (error) {
    console.error('❌ Error:', error);
}
