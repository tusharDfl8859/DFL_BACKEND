const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../config/service_config.json');
const outputPath = path.join(__dirname, '../service_config_export.csv');

try {
    const rawData = fs.readFileSync(configPath);
    const config = JSON.parse(rawData);

    const headers = ['Provider', 'Service Code', 'Country', 'Zone', 'Transit Time', 'Type', 'Partner', 'Zone Match'];
    const rows = [];

    // Helper to escape CSV fields containing commas
    const escapeCsv = (val) => {
        if (val === undefined || val === null) return '';
        const str = String(val);
        if (str.includes(',')) return `"${str}"`;
        return str;
    };

    Object.keys(config).forEach(provider => {
        const providerData = config[provider];
        if (providerData.services && Array.isArray(providerData.services)) {
            providerData.services.forEach(svc => {
                rows.push([
                    escapeCsv(provider),
                    escapeCsv(svc.code),
                    escapeCsv(svc.country),
                    escapeCsv(svc.zone),
                    escapeCsv(svc.transitTime),
                    escapeCsv(svc.type),
                    escapeCsv(svc.partnerFullName),
                    escapeCsv(svc.zoneMatch)
                ].join(','));
            });
        }
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(outputPath, csvContent);

    console.log(`✅ Successfully exported service config to: ${outputPath}`);
    console.log(`📊 Total rows exported: ${rows.length}`);

} catch (error) {
    console.error('❌ Error exporting CSV:', error);
    process.exit(1);
}
