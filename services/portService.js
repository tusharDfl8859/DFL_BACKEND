const xlsx = require('xlsx');
const path = require('path');

class PortService {
    constructor() {
        this.ports = [];
        this.initialized = false;
        this.init();
    }

    init() {
        try {
            const fs = require('fs');
            // Path to the Excel file (check project root first, then fallback)
            const candidates = [
                path.join(__dirname, '../World_Ports_List.xlsx'),
                path.join(__dirname, '../../World_Ports_List.xlsx'),
                path.join(process.cwd(), 'World_Ports_List.xlsx')
            ];
            const excelPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
            
            // Read the file
            const workbook = xlsx.readFile(excelPath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            
            // Convert to JSON (header: 1 means array of arrays)
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            
            // The first row is headers: ['Country', 'Port/City']
            // We start from index 1 to skip headers
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row && row.length >= 2) {
                    const country = String(row[0] || '').trim();
                    const port = String(row[1] || '').trim();
                    
                    if (country && port) {
                        this.ports.push({
                            country,
                            port,
                            // Pre-compute lowercased searchable string for max speed
                            searchString: `${port} ${country}`.toLowerCase()
                        });
                    }
                }
            }
            
            this.initialized = true;
            console.log(`[PortService] Successfully loaded ${this.ports.length} ports into memory for snappy search.`);
        } catch (error) {
            console.error('[PortService] Failed to load World_Ports_List.xlsx:', error);
            // Non-fatal, search will just return empty until fixed
        }
    }

    searchPorts(query, limit = 20) {
        if (!this.initialized || !query) {
            return [];
        }

        const lowerQuery = query.toLowerCase().trim();
        
        // Fast in-memory filter
        const results = [];
        for (let i = 0; i < this.ports.length; i++) {
            if (this.ports[i].searchString.includes(lowerQuery)) {
                results.push({
                    country: this.ports[i].country,
                    port: this.ports[i].port
                });
                
                if (results.length >= limit) {
                    break;
                }
            }
        }
        
        return results;
    }
}

// Export a singleton instance
module.exports = new PortService();
