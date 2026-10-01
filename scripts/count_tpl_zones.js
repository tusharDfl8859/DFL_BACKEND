const fs = require('fs');
const path = require('path');
const jsonPath = path.join(__dirname, '..', 'config', 'australia_zones.json');

const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
console.log('TPL Zone Count:', Object.keys(config.tpl).length);
console.log('Skynet Zone Count:', Object.keys(config.skynet_aus).length);
