const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, '..', '..', 'DFL Express Rate Card  (1).xlsx');
console.log(`Loading Excel from: ${filePath}`);

if (!require('fs').existsSync(filePath)) {
    console.error('File not found at:', filePath);
    process.exit(1);
}

const workbook = xlsx.readFile(filePath);
console.log('Sheet Names:', workbook.SheetNames);

const targetSheet = workbook.SheetNames.find(n => n.toLowerCase().includes('skynet') && n.toLowerCase().includes('australia'));
if (targetSheet) {
    console.log(`\n--- Sheet: ${targetSheet} ---`);
    const sheet = workbook.Sheets[targetSheet];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }).slice(0, 5);
    console.log(JSON.stringify(data, null, 2));
} else {
    console.log('\nWarning: Could not find a sheet strictly matching "australia skynet". Dumping "Australia State Code" if exists...');
    const altSheet = workbook.Sheets['Australia State Code'];
    if(altSheet) {
        console.log(`\n--- Sheet: Australia State Code ---`);
        const data = xlsx.utils.sheet_to_json(altSheet, { header: 1 }).slice(0, 5);
        console.log(JSON.stringify(data, null, 2));
    }
}
