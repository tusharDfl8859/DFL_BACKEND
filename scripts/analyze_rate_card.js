const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, '../../updated rate card (1).xlsx');
const workbook = XLSX.readFile(filePath);

const sheetName = workbook.SheetNames[0]; // Assuming first sheet, but let's list them
console.log('Sheet Names:', workbook.SheetNames);

// Let's dump the first few rows of the first sheet to see the structure
const sheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0, defval: null });

console.log('First 10 rows of sheet:', sheetName);
console.log(JSON.stringify(data.slice(0, 10), null, 2));

// Search for "Skynet" or "S AUS" keywords in the whole file to find where the table starts
workbook.SheetNames.forEach(name => {
    const s = workbook.Sheets[name];
    const d = XLSX.utils.sheet_to_json(s, { header: 1 });
    d.forEach((row, rHtml) => {
        row.forEach((cell, cIdx) => {
            if (typeof cell === 'string' && (cell.includes('Skynet') || cell.includes('S AUS'))) {
                console.log(`Found "${cell}" in Sheet "${name}" at Row ${rHtml}, Col ${cIdx}`);
            }
        });
    });
});
