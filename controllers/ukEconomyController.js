const UKNonServiceablePostcode = require('../models/UKNonServiceablePostcode');
const SystemConfig = require('../models/SystemConfig');

// --- Helper Functions ---

const extractPostcodePrefix = (postcode) => {
    if (!postcode) return '';
    const cleaned = postcode.trim().toUpperCase().replace(/\s+/g, '');
    // UK postcode format: AA9 9AA, A9 9AA, A99 9AA, AA99 9AA
    // Prefix = all leading letters + first digit group
    // We only want the letters for the non-serviceable table (e.g. BT, HS)
    const match = cleaned.match(/^([A-Z]{1,2})\d/);
    return match ? match[1] : cleaned.substring(0, 2);
};

// --- Config Endpoints ---

exports.getUKEconomyConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'ukEconomyConfig' });
        if (!config) {
            config = {
                value: {
                    isActive: true,
                    airFreightPerKg: 400,
                    indiaTHCPerKg: 13,
                    indiaCustomsPerShipment: 60,
                    ukCustomsPerShipment: 65,
                    ukDeliveryCost: 250,
                    transitTime: '7-12',
                    displayName: 'DFL EXPRESS Standard'
                }
            };
        }
        res.json(config.value);
    } catch (err) {

        res.status(500).json({ message: 'Error fetching config' });
    }
};

exports.updateUKEconomyConfig = async (req, res) => {
    try {
        const { value } = req.body;
        // The req.body is already the config object in this case
        const updateData = req.body.isActive !== undefined ? req.body : value;

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'ukEconomyConfig' },
            { 
                value: updateData,
                updatedBy: req.user ? req.user._id : null
            },
            { upsert: true, new: true }
        );
        res.json(config.value);
    } catch (err) {

        res.status(500).json({ message: 'Error updating config' });
    }
};

exports.getUKPriorityConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'ukPriorityConfig' });
        if (!config) {
            config = {
                value: {
                    isActive: true,
                    airFreightPerKg: 500,
                    indiaTHCPerKg: 15,
                    indiaCustomsPerShipment: 60,
                    ukCustomsPerShipment: 65,
                    ukDeliveryCost: 350,
                    transitTime: '3-5',
                    displayName: 'DFL EXPRESS Priority'
                }
            };
        }
        res.json(config.value);
    } catch (err) {

        res.status(500).json({ message: 'Error fetching config' });
    }
};

exports.updateUKPriorityConfig = async (req, res) => {
    try {
        const { value } = req.body;
        const updateData = req.body.isActive !== undefined ? req.body : value;

        const config = await SystemConfig.findOneAndUpdate(
            { key: 'ukPriorityConfig' },
            { 
                value: updateData,
                updatedBy: req.user ? req.user._id : null
            },
            { upsert: true, new: true }
        );
        res.json(config.value);
    } catch (err) {

        res.status(500).json({ message: 'Error updating config' });
    }
};

// --- Postcode CRUD ---

exports.listPostcodes = async (req, res) => {
    try {
        const postcodes = await UKNonServiceablePostcode.find().sort({ prefix: 1 });
        res.json(postcodes);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching postcodes' });
    }
};

exports.addPostcode = async (req, res) => {
    try {
        const { prefix, remarks } = req.body;
        if (!prefix) return res.status(400).json({ message: 'Prefix is required' });

        const existing = await UKNonServiceablePostcode.findOne({ prefix: prefix.toUpperCase() });
        if (existing) return res.status(400).json({ message: 'Prefix already exists' });

        const newPc = new UKNonServiceablePostcode({
            prefix: prefix.toUpperCase(),
            remarks,
            createdBy: req.user ? req.user._id : null
        });
        await newPc.save();
        res.json(newPc);
    } catch (err) {
        res.status(500).json({ message: 'Error adding postcode' });
    }
};

exports.updatePostcode = async (req, res) => {
    try {
        const { id } = req.params;
        const pc = await UKNonServiceablePostcode.findByIdAndUpdate(
            id,
            { ...req.body, updatedBy: req.user ? req.user._id : null },
            { new: true }
        );
        res.json(pc);
    } catch (err) {
        res.status(500).json({ message: 'Error updating postcode' });
    }
};

exports.deletePostcode = async (req, res) => {
    try {
        await UKNonServiceablePostcode.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting postcode' });
    }
};

// --- Seed Default Postcodes ---
exports.seedDefaultPostcodes = async () => {
    try {
        const count = await UKNonServiceablePostcode.countDocuments();
        if (count === 0) {
            const defaults = ['BT', 'HS', 'IM', 'IV', 'JE', 'KW', 'PA', 'PH', 'ZE', 'GY', 'FK', 'KA', 'ML', 'AB', 'DD', 'DG', 'EH', 'KY', 'TD'];
            const toInsert = defaults.map(p => ({ prefix: p, remarks: 'Default Seed' }));
            await UKNonServiceablePostcode.insertMany(toInsert);

        }
    } catch (err) {
        console.error('Failed to seed default UK non-serviceable postcodes:', err);
    }
};

// --- Rate Calculation Logic ---

exports.calculateUKEconomyRate = async ({ weightGrams, postcode, tierMarkup, handlingCharge = 0 }) => {
    try {
        // 1. Load config from SystemConfig
        let config = await SystemConfig.findOne({ key: 'ukEconomyConfig' });
        if (!config || !config.value || !config.value.isActive) return null;

        const cfg = config.value;

        // 2. Postcode validation
        const prefix = extractPostcodePrefix(postcode);
        if (prefix) {
            const blocked = await UKNonServiceablePostcode.findOne({
                prefix: prefix,
                isActive: true
            });
            if (blocked) {
                return { blocked: true, message: `DFL EXPRESS Standard service is not available for postcode area "${prefix}".` };
            }
        }

        // 3. Weight conversion and New Logic (<= 2KG)
        const exactWeightGrams = parseFloat(weightGrams) || 0;
        
        // --- NEW LOGIC: Weight <= 2 KG uses Fixed Base Cost (if enabled) ---
        if (exactWeightGrams <= 2000 && cfg.isFixedRateEnabled !== false) {
            const fixedRates = (cfg.fixedRates && cfg.fixedRates.length > 0) ? cfg.fixedRates : [
                { maxGrams: 50, cost: 266.964286 },
                { maxGrams: 100, cost: 294.642857 },
                { maxGrams: 150, cost: 312.5 },
                { maxGrams: 200, cost: 326.785714 },
                { maxGrams: 250, cost: 339.285714 },
                { maxGrams: 300, cost: 361.607143 },
                { maxGrams: 350, cost: 383.928571 },
                { maxGrams: 400, cost: 419.642857 },
                { maxGrams: 500, cost: 455.357143 },
                { maxGrams: 600, cost: 490.178571 },
                { maxGrams: 700, cost: 536.607143 },
                { maxGrams: 800, cost: 624.107143 },
                { maxGrams: 900, cost: 668.75 },
                { maxGrams: 1000, cost: 713.392857 },
                { maxGrams: 1500, cost: 847.321429 },
                { maxGrams: 2000, cost: 981.25 }
            ];

            let baseCost = fixedRates[fixedRates.length - 1].cost;
            let chargeableWeight = 2; // 2 KG
            for (let i = 0; i < fixedRates.length; i++) {
                if (exactWeightGrams <= fixedRates[i].maxGrams) {
                    baseCost = fixedRates[i].cost;
                    chargeableWeight = fixedRates[i].maxGrams / 1000;
                    break;
                }
            }

            const markup = baseCost * (tierMarkup || 0);
            const subtotal = baseCost + markup;
            const taxableAmount = subtotal + handlingCharge;
            const gst = taxableAmount * 0.18;
            const sellingPrice = taxableAmount + gst;

            return {
                blocked: false,
                serviceName: 'DFL EXPRESS Standard',
                totalPricing: Math.round(sellingPrice * 100) / 100,
                transitTime: cfg.transitTime || '7-12',
                chargeableWeight: chargeableWeight,
                id: 'dfl_uk_economy',
                isInternal: true,
                provider: 'UK-ECONOMY',
                serviceImage: '/dfl_express_logo.png',
                breakdown: {
                    airFreight: 0, indiaTHC: 0, indiaCustoms: 0, ukCustoms: 0, ukDelivery: 0,
                    totalCost: baseCost, markup, gst, base: baseCost, handlingCharge,
                    source: 'FixedRateSheet'
                }
            };
        }

        // --- FALLBACK LOGIC: Weight > 2 KG ---
        let weightKg = Math.ceil(exactWeightGrams / 1000);

        // 4. Cost components
        const airFreight     = weightKg * (cfg.airFreightPerKg || 400);
        const indiaTHC       = weightKg * (cfg.indiaTHCPerKg || 13);
        const indiaCustoms   = cfg.indiaCustomsPerShipment || 60;
        const ukCustoms      = cfg.ukCustomsPerShipment || 65;
        const ukDelivery     = cfg.ukDeliveryCost || 250;

        const totalCost = airFreight + indiaTHC + indiaCustoms + ukCustoms + ukDelivery;

        // 5. Apply markup (uses existing tierMarkup from caller)
        const markup = totalCost * (tierMarkup || 0);
        const taxableAmount = totalCost + markup + handlingCharge;
        const gst = taxableAmount * 0.18;
        const sellingPrice = taxableAmount + gst;

        return {
            blocked: false,
            serviceName: 'DFL EXPRESS Standard',
            totalPricing: Math.round(sellingPrice * 100) / 100,
            transitTime: cfg.transitTime || '7-12',
            chargeableWeight: weightKg, // Keep it as Kg for display
            id: 'dfl_uk_economy',
            isInternal: true,
            provider: 'UK-ECONOMY',
            serviceImage: '/dfl_express_logo.png',
            breakdown: {
                airFreight, indiaTHC, indiaCustoms, ukCustoms,
                ukDelivery, totalCost, markup, gst, base: totalCost, handlingCharge
            }
        };
    } catch (err) {

        return null;
    }
};

exports.calculateUKPriorityRate = async ({ weightGrams, postcode, tierMarkup, handlingCharge = 0 }) => {
    try {
        // Priority ONLY up to 30kg
        const exactWeightKg = parseFloat(weightGrams) / 1000;
        if (exactWeightKg > 30) return null;

        // 1. Load config from SystemConfig
        let config = await SystemConfig.findOne({ key: 'ukPriorityConfig' });
        if (!config || !config.value || !config.value.isActive) return null;

        const cfg = config.value;

        // 2. Postcode validation
        const prefix = extractPostcodePrefix(postcode);
        if (prefix) {
            const blocked = await UKNonServiceablePostcode.findOne({
                prefix: prefix,
                isActive: true
            });
            if (blocked) {
                return { blocked: true, message: `DFL EXPRESS Priority service is not available for postcode area "${prefix}".` };
            }
        }

        // 3. Weight conversion and New Logic (<= 2KG)
        const exactWeightGrams = parseFloat(weightGrams) || 0;
        
        // --- NEW LOGIC: Weight <= 2 KG uses Fixed Base Cost (if enabled) ---
        if (exactWeightGrams <= 2000 && cfg.isFixedRateEnabled !== false) {
            const fixedRates = (cfg.fixedRates && cfg.fixedRates.length > 0) ? cfg.fixedRates : [
                { maxGrams: 50, cost: 266.964286 },
                { maxGrams: 100, cost: 294.642857 },
                { maxGrams: 150, cost: 312.5 },
                { maxGrams: 200, cost: 326.785714 },
                { maxGrams: 250, cost: 339.285714 },
                { maxGrams: 300, cost: 361.607143 },
                { maxGrams: 350, cost: 383.928571 },
                { maxGrams: 400, cost: 419.642857 },
                { maxGrams: 500, cost: 455.357143 },
                { maxGrams: 600, cost: 490.178571 },
                { maxGrams: 700, cost: 536.607143 },
                { maxGrams: 800, cost: 624.107143 },
                { maxGrams: 900, cost: 668.75 },
                { maxGrams: 1000, cost: 713.392857 },
                { maxGrams: 1500, cost: 847.321429 },
                { maxGrams: 2000, cost: 981.25 }
            ];

            let baseCost = fixedRates[fixedRates.length - 1].cost;
            let chargeableWeight = 2; // 2 KG
            for (let i = 0; i < fixedRates.length; i++) {
                if (exactWeightGrams <= fixedRates[i].maxGrams) {
                    baseCost = fixedRates[i].cost;
                    chargeableWeight = fixedRates[i].maxGrams / 1000;
                    break;
                }
            }

            const markup = baseCost * (tierMarkup || 0);
            const subtotal = baseCost + markup;
            const taxableAmount = subtotal + handlingCharge;
            const gst = taxableAmount * 0.18;
            const sellingPrice = taxableAmount + gst;

            return {
                blocked: false,
                serviceName: 'DFL EXPRESS Priority',
                totalPricing: Math.round(sellingPrice * 100) / 100,
                transitTime: cfg.transitTime || '3-5',
                chargeableWeight: chargeableWeight,
                id: 'dfl_uk_priority',
                isInternal: true,
                provider: 'UK-PRIORITY',
                serviceImage: '/dfl_express_logo.png',
                breakdown: {
                    airFreight: 0, indiaTHC: 0, indiaCustoms: 0, ukCustoms: 0, ukDelivery: 0,
                    totalCost: baseCost, markup, gst, base: baseCost, handlingCharge,
                    source: 'FixedRateSheet'
                }
            };
        }

        // --- FALLBACK LOGIC: Weight > 2 KG ---
        let weightKg = Math.ceil(exactWeightGrams / 1000);

        // 4. Cost components
        const airFreight     = weightKg * (cfg.airFreightPerKg || 500);
        const indiaTHC       = weightKg * (cfg.indiaTHCPerKg || 15);
        const indiaCustoms   = cfg.indiaCustomsPerShipment || 60;
        const ukCustoms      = cfg.ukCustomsPerShipment || 65;
        const ukDelivery     = cfg.ukDeliveryCost || 350;

        const totalCost = airFreight + indiaTHC + indiaCustoms + ukCustoms + ukDelivery;

        // 5. Apply markup (uses existing tierMarkup from caller)
        const markup = totalCost * (tierMarkup || 0);
        const taxableAmount = totalCost + markup + handlingCharge;
        const gst = taxableAmount * 0.18;
        const sellingPrice = taxableAmount + gst;

        return {
            blocked: false,
            serviceName: 'DFL EXPRESS Priority',
            totalPricing: Math.round(sellingPrice * 100) / 100,
            transitTime: cfg.transitTime || '3-5',
            chargeableWeight: weightKg, // Keep it as Kg for display
            id: 'dfl_uk_priority',
            isInternal: true,
            provider: 'UK-PRIORITY',
            serviceImage: '/dfl_express_logo.png',
            breakdown: {
                airFreight, indiaTHC, indiaCustoms, ukCustoms,
                ukDelivery, totalCost, markup, gst, base: totalCost, handlingCharge
            }
        };
    } catch (err) {

        return null;
    }
};
