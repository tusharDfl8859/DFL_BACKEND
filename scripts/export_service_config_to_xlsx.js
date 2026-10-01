const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Paths
const jsonPath = path.join(__dirname, '../config/service_config.json');
const outputPath = path.join(__dirname, '../service_config.xlsx');

/**
 * Export service_config.json to Excel
 */
function exportToExcel() {
    try {
        console.log('Reading service_config.json...');
        const rawData = fs.readFileSync(jsonPath, 'utf8');
        const config = JSON.parse(rawData);

        const flattenedData = [];

        // Iterate through each carrier
        for (const [carrierCode, carrierGroup] of Object.entries(config)) {
            if (!carrierGroup.services || !Array.isArray(carrierGroup.services)) continue;

            const prefix = carrierGroup.prefix || '';

            // Iterate through each service of the carrier
            carrierGroup.services.forEach(service => {
                flattenedData.push({
                    'Carrier': carrierCode,
                    'Prefix': prefix,
                    'Service Name': service.displayName || '',
                    'Display Code': service.code || '',
                    'Internal Service Code': service.serviceCode || '',
                    'Skynet Billing Code': service.skynetBillingCode || '',
                    'Country': service.country || '',
                    'Transit Time': service.transitTime || '',
                    'Zone': service.zone || '',
                    'Type': service.type || '',
                    'Partner Full Name': service.partnerFullName || '',
                    'Zone Match': service.zoneMatch || ''
                });
            });
        }

        console.log(`Flattened ${flattenedData.length} services.`);

        // Create Excel Workbook
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(flattenedData);

        // Add worksheet to workbook
        XLSX.utils.book_append_sheet(wb, ws, 'Service Config');

        // Write to file
        XLSX.writeFile(wb, outputPath);

        console.log(`✅ Export successful! File saved at: ${outputPath}`);
    } catch (err) {
        console.error('❌ Failed to export Excel:', err.message);
    }
}

exportToExcel();
