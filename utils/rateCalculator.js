const RateZone = require('../models/RateZone');
const RateTable = require('../models/RateTable');
const ServiceConfig = require('../config/service_config.json');
const AustraliaZones = require('../config/australia_zones.json');

// Helper for US State Normalization
const US_STATES = {
    'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR', 'CALIFORNIA': 'CA',
    'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE', 'FLORIDA': 'FL', 'GEORGIA': 'GA',
    'HAWAII': 'HI', 'IDAHO': 'ID', 'ILLINOIS': 'IL', 'INDIANA': 'IN', 'IOWA': 'IA',
    'KANSAS': 'KS', 'KENTUCKY': 'KY', 'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD',
    'MASSACHUSETTS': 'MA', 'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS', 'MISSOURI': 'MO',
    'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
    'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH',
    'OKLAHOMA': 'OK', 'OREGON': 'OR', 'PENNSYLVANIA': 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
    'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT', 'VERMONT': 'VT',
    'VIRGINIA': 'VA', 'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV', 'WISCONSIN': 'WI', 'WYOMING': 'WY',
    'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR'
};

class RateCalculator {
    constructor() {
        this.zones = null;
        this.rates = null;
        this.lastLoaded = null;
        this.zones = null;
        this.rates = null;
        this.lastLoaded = null;
        this.serviceMap = null; // { CountryCode: { services: [] } }
        this.skynetAuZones = null; // [NEW] Separate cache for Skynet AU Virtual Zones
    }

    // --- Initialization Logic ---
    _buildServiceMap() {
        const map = {};

        // Helper to normalize country names to ISO (or whatever key we use)
        const countryAliases = {
            'USA': 'US', 'UNITED STATES': 'US', 'US': 'US',
            'UK': 'GB', 'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB', 'GB': 'GB',
            'AUSTRALIA': 'AU', 'AU': 'AU',
            'NEW ZEALAND': 'NZ', 'NZ': 'NZ',
            'FRANCE': 'FR', 'FR': 'FR',
            'GERMANY': 'DE', 'DE': 'DE',
            'NETHERLANDS': 'NL', 'NL': 'NL',
            'IRELAND': 'IE', 'IE': 'IE',
            'ITALY': 'IT', 'IT': 'IT',
            'SPAIN': 'ES', 'ES': 'ES',
            'AUSTRIA': 'AT', 'AT': 'AT',
            'FINLAND': 'FI', 'FI': 'FI',
            'UAE': 'AE', 'UNITED ARAB EMIRATES': 'AE', 'AE': 'AE',
            'CANADA': 'CA', 'CA': 'CA',
            'MEXICO': 'MX', 'MX': 'MX',
            'SAUDI ARABIA': 'SA', 'SA': 'SA', 'KSA': 'SA',
            'ROMANIA': 'RO', 'RO': 'RO',
            'SWEDEN': 'SE', 'SE': 'SE',
            'PORTUGAL': 'PT', 'PT': 'PT',
            'POLAND': 'PL', 'PL': 'PL',
            'BELGIUM': 'BE', 'BE': 'BE',
            'BULGARIA': 'BG', 'BG': 'BG',
            'CROATIA': 'HR', 'HR': 'HR',
            'CYPRUS': 'CY', 'CY': 'CY',
            'CZECH REPUBLIC': 'CZ', 'CZ': 'CZ',
            'DENMARK': 'DK', 'DK': 'DK',
            'ESTONIA': 'EE', 'EE': 'EE',
            'GREECE': 'GR', 'GR': 'GR',
            'HUNGARY': 'HU', 'HU': 'HU',
            'LATVIA': 'LV', 'LV': 'LV',
            'LITHUANIA': 'LT', 'LT': 'LT',
            'LUXEMBOURG': 'LU', 'LU': 'LU',
            'MALTA': 'MT', 'MT': 'MT',
            'SLOVENIA': 'SI', 'SI': 'SI',
            'SLOVAKIA': 'SK', 'SK': 'SK',
            'MALAYSIA': 'MY', 'MY': 'MY',
            'SINGAPORE': 'SG', 'SG': 'SG'
        };

        const processProvider = (providerName, providerData) => {
            if (!providerData.services) return;

            providerData.services.forEach(svc => {
                const cName = svc.country ? svc.country.toUpperCase() : 'UNKNOWN';
                const iso = countryAliases[cName] || cName; // Fallback to config name if no alias

                if (!map[iso]) map[iso] = { services: [] };

                // Determine Service Type logic
                let category = 'standard';
                if (svc.type === 'SMALL_PARCELS') category = 'economy';
                if (providerName === 'SKYNET' || providerName === 'SKYNET-ECOMMERCE') category = 'special';

                map[iso].services.push({
                    code: svc.code, // e.g., TUS3, SAE, UUK
                    serviceCode: svc.serviceCode, // e.g., DFLS100
                    carrierCode: svc.carrierCode || providerName, // Capture explicit carrier code
                    skynetBillingCode: svc.skynetBillingCode, // [NEW] Capture billing code
                    zoneOverride: svc.zone, // 3, 4, etc.
                    type: svc.type, // HEAVY, SMALL_PARCELS
                    provider: providerName,
                    category: category,
                    partner: svc.partnerFullName,
                    zoneMatch: svc.zoneMatch, // IMPORTANT: Pass zoneMatch for FBA logic
                    transitTime: svc.transitTime, // [NEW] Capture transit time from config
                    displayName: svc.displayName // [NEW] Capture display name
                });
            });
        };

        // Iterate over TPL, UNITED, SKYNET
        Object.keys(ServiceConfig).forEach(key => {
            processProvider(key, ServiceConfig[key]);
        });

        this.serviceMap = map;
    }

    async loadData(force = false) {
        // Build map first
        if (!this.serviceMap) this._buildServiceMap();

        // Simple cache mechanism (reload if > 1 hour old or first load), unless forced
        if (!force && this.zones && this.rates && (Date.now() - this.lastLoaded < 3600000)) {
            return;
        }
        // 1. Fetch Zones
        const zoneDocs = await RateZone.find({}).lean();

        this.zones = {
            US: {},
            AU: {},
            NZ: {}
        };
        this.skynetAuZones = {}; // Initialize SK_AU storage

        zoneDocs.forEach(doc => {
            if (doc.country === 'US' && doc.state) {
                this.zones.US[doc.state] = doc.zone;
            } else if (doc.country === 'AU' && doc.postcode) {
                this.zones.AU[doc.postcode] = doc.zone;
            } else if (doc.country === 'NZ' && doc.postcode) {
                this.zones.NZ[doc.postcode] = doc.zone;
            } else if (doc.country === 'CA' && doc.postcode) {
                // Ensure CA sub-object exists if not initialised above
                if (!this.zones.CA) this.zones.CA = {};
                this.zones.CA[doc.postcode] = doc.zone;
            } else if (doc.country === 'SK_AU' && doc.postcode) {
                // [NEW] Load Virtual Country SK_AU
                this.skynetAuZones[doc.postcode] = doc.zone;
            }
        });

        // 2. Fetch Rates
        const rateDocs = await RateTable.find({}).sort({ weight: 1 }).lean();

        this.rates = rateDocs.map(doc => {
            const normalizedRate = {
                weight: doc.weight !== undefined ? Number(doc.weight) : Number(doc['Weight ']),
                rates: {} // Store normalized keys here
            };

            // Normalize keys: Remove spaces, handle nested 'rates' object if source has it, or flat structure
            const sourceRates = doc.rates || doc;
            Object.keys(sourceRates).forEach(key => {
                // Skip non-rate keys
                if (key === 'weight' || key === 'Weight ' || key === '_id' || key === '__v') return;

                const normKey = key.replace(/\s+/g, '');
                normalizedRate.rates[normKey] = sourceRates[key];
            });

            return normalizedRate;
        });

        this.lastLoaded = Date.now();
        this.cache = new Map(); // Initialize/Clear Cache
    }

    // Force Reload Proxy
    async forceReload() {
        await this.loadData(true);
    }

    // --- Core Logic ---

    getRate(params) {
        if (!this.zones || !this.rates) {
            throw new Error('Rate data not loaded. Call loadData() first.');
        }

        const { weight, country, state, postcode } = params;
        const numWeight = parseFloat(weight);

        if (isNaN(numWeight) || numWeight <= 0) {
            throw new Error('Invalid weight');
        }

        // 1. Resolve Country
        const countryRaw = country ? country.trim().toUpperCase() : '';
        const countryAliases = {
            "USA": "US",
            "UNITED STATES": "US",
            "US": "US",
            "UK": "GB",
            "UNITED KINGDOM": "GB",
            "GREAT BRITAIN": "GB",
            "GB": "GB",
            "AUSTRALIA": "AU",
            "AU": "AU",
            "AUS": "AU",
            "S AU": "AU",
            "S AUS1": "AU",
            "S AUS2": "AU",
            "S AUS3": "AU",
            "NEW ZEALAND": "NZ",
            "NZ": "NZ",
            "FRANCE": "FR",
            "GERMANY": "DE",
            "NETHERLANDS": "NL",
            "IRELAND": "IE",
            "ITALY": "IT",
            "SPAIN": "ES",
            "AUSTRIA": "AT",
            "FINLAND": "FI",
            "UAE": "AE",
            "UNITED ARAB EMIRATES": "AE",
            "CANADA": "CA",
            "CA": "CA",
            "MEXICO": "MX",
            "SAUDI ARABIA": "SA",
            "KSA": "SA",
            "ROMANIA": "RO",
            "RO": "RO",
            "SWEDEN": "SE",
            "SE": "SE",
            "PORTUGAL": "PT",
            "PT": "PT",
            "POLAND": "PL",
            "PL": "PL",
            "BELGIUM": "BE",
            "BE": "BE",
            "BULGARIA": "BG",
            "BG": "BG",
            "CROATIA": "HR",
            "HR": "HR",
            "CYPRUS": "CY",
            "CY": "CY",
            "CZECH REPUBLIC": "CZ",
            "CZ": "CZ",
            "DENMARK": "DK",
            "DK": "DK",
            "ESTONIA": "EE",
            "EE": "EE",
            "GREECE": "GR",
            "GR": "GR",
            "HUNGARY": "HU",
            "HU": "HU",
            "LATVIA": "LV",
            "LV": "LV",
            "LITHUANIA": "LT",
            "LT": "LT",
            "LUXEMBOURG": "LU",
            "LU": "LU",
            "MALTA": "MT",
            "MT": "MT",
            "SLOVENIA": "SI",
            "SI": "SI",
            "SLOVAKIA": "SK",
            "SK": "SK",
            "MALAYSIA": "MY",
            "MY": "MY",
            "SINGAPORE": "SG",
            "SG": "SG",
            "TUS1": "US",
            "TUS2": "US",
            "TUS3": "US",
            "TUS4": "US",
            "TUS5": "US",
            "TUS6": "US",
            "TUS7": "US",
            "TUS8": "US",
            "TUS -2 (FBA & CO )": "US",
            "TUS 3 (FBA & CO )": "US",
            "TUS 4 (FBA & CO )": "US",
            "TUS 5 (FBA & CO )": "US",
            "TUS 6 (FBA & CO )": "US",
            "TUS 7 (FBA & CO )": "US",
            "TUS 8 (FBA & CO )": "US",
            "TUK": "GB",
            "TAU1": "AU",
            "TAU2": "AU",
            "TAU3": "AU",
            "TAU4": "AU",
            "TAU5": "AU",
            "TFR": "FR",
            "TDE": "DE",
            "TNL": "NL",
            "TIE": "IE",
            "TIT": "IT",
            "TES": "ES",
            "TAS": "AT",
            "TAT": "FI",
            "TNZ1": "NZ",
            "TNZ2": "NZ",
            "TNZ3": "NZ",
            "TMX": "MX",
            "TSA": "SA",
            "TUSPS": "US",
            "UUSPS": "US",
            "SUK": "GB",
            "UCA ECOMMERCE": "CA",
            "UCA": "CA",
            "SAE": "AE",
            "S CA 1": "CA",
            "S CA 2": "CA",
            "S CA 3": "CA",
            "S CA 4": "CA",
            "S CA 5": "CA",
            "S CA 6": "CA",
            "S CA 7": "CA",
            "S CA 8": "CA",
            "S CA 9": "CA",
            "S CA 10": "CA",
            "S CA 11": "CA",
            "S CA 12": "CA",
            "S CA 13": "CA",
            "S CA 14": "CA",
            "S CA 15": "CA",
            "S CA 16": "CA",
            "S IT": "IT",
            "S IE": "IE",
            "S NL": "NL",
            "S FR": "FR",
            "S DE": "DE",
            "S ES": "ES",
            "S AT": "AT",
            "S USA-GA": "US",
            "S USA-SAVER": "US",
            "S CA": "CA",
            "S GB": "GB",
            "S GB_EVRI": "GB",
            "S MY": "MY",
            "S SG": "SG",
            "S UAE": "AE",
            "S BEL": "BE",
            "S BGR": "BG",
            "S HRV": "HR",
            "S CYP": "CY",
            "S CZE": "CZ",
            "S DNK": "DK",
            "S EST": "EE",
            "S FIN": "FI",
            "S GRC": "GR",
            "S HUN": "HU",
            "S LVA": "LV",
            "S LTU": "LT",
            "S LUX": "LU",
            "S MLT": "MT",
            "S POL": "PL",
            "S PRT": "PT",
            "S ROU": "RO",
            "S SVN": "SI",
            "S SWE": "SE",
            "S SAU": "SA"
        };
        const iso = countryAliases[countryRaw] || countryRaw;
        const services = this.serviceMap[iso];
        if (!services) {
            // throw new Error(`No service configuration found for country: ${country} (${iso})`);
            return { rates: [] };
        }

        const results = [];

        // 2. Iterate Configured Services for this Country
        services.services.forEach(svc => {
            let resolvedZoneCode = null;

            // Logic to determine if this specific service entry applies

            // --- Zone-Based Check (US, AU, NZ, CA) ---
            // If the Service Entry implies a Zone (e.g. TUS3), we check if the user's location maps to it.
            if (['US', 'AU', 'NZ', 'CA'].includes(iso) && (svc.provider === 'TPL' || (iso === 'CA' && (svc.provider === 'SKYNET' || svc.provider === 'SKYNET-ECOMMERCE')))) {
                // TPL/Skynet split by zones
                let dbZone = null;
                if (iso === 'US') {
                    if (!state) return; // Can't map
                    let st = state.toUpperCase().trim();
                    if (st.length > 2) st = US_STATES[st] || st;
                    dbZone = this.zones.US[st];
                } else if (iso === 'AU') {
                    if (!postcode) return;

                    // [NEW] Skynet Special Logic for AU
                    if (svc.provider === 'SKYNET' || svc.provider === 'SKYNET-ECOMMERCE') {
                        // Hardcoded Override: 4209 Upper Coomera falls under Zone 2 for Skynet
                        if (postcode === '4209') {
                            dbZone = 'S AUS2';
                        } else {
                            // Check Virtual Zone Map
                            dbZone = this.skynetAuZones[postcode];
                        }
                        if (!dbZone) return; // Strict Allowlist
                    } else {
                        // Standard TPL/FedEx Logic
                        // Hardcoded Override: 4209 Upper Coomera falls under Zone 4
                        if (postcode === '4209') {
                            dbZone = 'TAU4';
                        } else {
                            dbZone = this.zones.AU[postcode];
                        }

                        // fallback for AU: 0800 vs 800
                        if (!dbZone && postcode.startsWith('0')) {
                            dbZone = this.zones.AU[postcode.substring(1)];
                        }
                    }
                } else if (iso === 'NZ') {
                    if (!postcode) return;
                    dbZone = this.zones.NZ[postcode];
                } else if (iso === 'CA') {
                    if (!postcode) return;
                    // Canada uses FSA (First 3 chars)
                    const fsa = postcode.trim().substring(0, 3).toUpperCase();
                    if (this.zones.CA) {
                        dbZone = this.zones.CA[fsa];
                    }
                }

                if (dbZone) { // Allow US and others to use this matching logic
                    const normDb = dbZone.replace(/\s+/g, '');
                    const normSvc = svc.code.replace(/\s+/g, ''); // "S CA 1" -> "SCA1"

                    if (normDb === normSvc) {
                        resolvedZoneCode = dbZone;
                    } else if (svc.zoneMatch && svc.zoneMatch === dbZone) {
                        // Support for FBA/CO services that map to a base zone
                        resolvedZoneCode = svc.code; // Use the service code (Column Name) as the zone code for rate lookup
                    } else if (iso === 'CA' && svc.code === 'S CA' && !svc.zone) {
                        // S CA is a country-wide service - always include for any Canada destination
                        resolvedZoneCode = 'S CA';
                    } else if (iso === 'US' && svc.code === 'TUSPS') {
                        // TUSPS is a country-wide US service (USPS Small Parcels)
                        resolvedZoneCode = 'TUSPS';
                    }
                } else if (iso === 'CA' && svc.code === 'S CA' && !svc.zone) {
                    // S CA fallback when zone lookup fails
                    resolvedZoneCode = 'S CA';
                } else if (iso === 'US' && svc.code === 'TUSPS') {
                    // TUSPS fallback for US
                    resolvedZoneCode = 'TUSPS';
                }
            }
            // --- Skynet Australia Zone Filtering (S AU, S AUS1, S AUS2, S AUS3) ---
            else if (iso === 'AU' && (svc.provider === 'SKYNET' || svc.provider === 'SKYNET-ECOMMERCE')) {
                if (!postcode) return;
                const svcCode = svc.code; // e.g., 'S AU', 'S AUS1', 'S AUS2', 'S AUS3'
                // Check if this is an S AUS zone service
                if (svcCode.startsWith('S AUS')) {
                    // Look up the correct zone from our JSON mapping
                    const skynetZone = AustraliaZones.skynet_aus[postcode] ||
                        AustraliaZones.skynet_aus[postcode.replace(/^0+/, '')]; // Handle leading zeros
                    // Only match if the lookup zone matches this service
                    if (skynetZone && skynetZone === svcCode) {
                        resolvedZoneCode = svcCode;
                    }
                    // If no zone found or doesn't match, skip this service
                } else if (svcCode === 'S AU') {
                    // S AU is the general Australia service - always include
                    resolvedZoneCode = svcCode;
                }
            }
            // --- Country-Wide Service (UNITED, SKYNET-non-AU, TPL-Europe) ---
            else {
                if (svc.zoneOverride) {
                    // Specific zone entry, if not matched above, skip.
                } else {
                    // No specific zone restriction -> Country Wide
                    resolvedZoneCode = svc.code; // e.g., SAE, TFR
                }
            }

            if (resolvedZoneCode) {
                // 3. Get Rate Value (and Matched Weight)
                const rateResult = this._findRate(resolvedZoneCode, numWeight);

                if (rateResult) {
                    let sName = svc.displayName || `DFL EXPRESS - ${svc.code}`;
                    // [NEW] Use transit time from config, with fallback
                    let transit = svc.transitTime || "5-7 Working Days";

                    results.push({
                        serviceName: sName,
                        serviceCode: svc.serviceCode, // DFLS code
                        carrierCode: svc.carrierCode, // [NEW] Explicit carrier code
                        carrierName: svc.provider, // [NEW] Explicit carrier name for controller
                        skynetBillingCode: svc.skynetBillingCode, // [NEW] Explicit billing code
                        zone: resolvedZoneCode,
                        chargableWeight: numWeight,
                        matchedWeight: rateResult.matchedWeight, // The actual slab used
                        rate: rateResult.price,
                        currency: 'INR',
                        transitTime: transit,
                        provider: svc.provider,
                        image: this._getServiceImage(svc.provider)
                    });
                }
            }
        });

        if (results.length === 0) {
            // throw new Error(`Rate not available for ${country} at weight ${numWeight}kg`);
            // Suppress error for now in case partial results found? No, existing logic throws.
            // We can return empty list or throw.
            // throw new Error(`Rate not found`);
        }

        // Sort by Price
        results.sort((a, b) => a.rate - b.rate);
        if (results.length > 0) {
            results[0].bestValue = true;
            results.forEach(r => r.bestValue = !!r.bestValue);
        }

        return { rates: results };
    }

    _findRate(zoneKey, weight) {
        // Cache Key
        const cacheKey = `${zoneKey}_${weight}`;
        if (this.cache && this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        if (!this.rates || this.rates.length === 0) return null;

        // 1. Binary Search for Weight
        let left = 0;
        let right = this.rates.length - 1;
        let foundIndex = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (this.rates[mid].weight >= weight) {
                foundIndex = mid;
                right = mid - 1; // Try to find a smaller sufficient weight
            } else {
                left = mid + 1;
            }
        }

        if (foundIndex !== -1) {
            const normZoneKey = zoneKey.replace(/\s+/g, '');

            // Iterate forward from foundIndex to find a rate (fallback to higher weights if needed)
            for (let i = foundIndex; i < this.rates.length; i++) {
                const r = this.rates[i];
                const val = r.rates[normZoneKey]; // Direct Access O(1)

                if (val && parseFloat(val) > 0) {
                    const result = {
                        price: parseFloat(val),
                        matchedWeight: r.weight || r['Weight ']
                    };

                    // LRU Cache Logic (Simple Map limit)
                    if (this.cache.size > 1000) {
                        const firstKey = this.cache.keys().next().value;
                        this.cache.delete(firstKey);
                    }
                    this.cache.set(cacheKey, result);

                    return result;
                }
            }
        }

        return null;
    }

    _getServiceImage(provider) {
        // Use local DFL logo for all DFL Express services
        return "/dfl_express_logo.png";
    }
}

module.exports = new RateCalculator();
