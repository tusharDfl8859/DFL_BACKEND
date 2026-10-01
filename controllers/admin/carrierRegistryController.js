const Carrier = require('../../models/Carrier');
const makeCode = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const listCarriers = async (req, res) => {
    try {
        const carriers = await Carrier.find().sort({ createdAt: -1 }).lean();
        res.json(carriers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createCarrier = async (req, res) => {
    try {
        if (!req.body.name || !String(req.body.name).trim()) {
            return res.status(400).json({ message: 'Carrier name is required.' });
        }
        if (!req.body.email || !String(req.body.email).trim()) {
            return res.status(400).json({ message: 'Carrier email is required.' });
        }
        const initialEmail = String(req.body.email).trim().toLowerCase();
        const baseCode = makeCode(req.body.code || req.body.name);
        const generatedCode = baseCode ? `${baseCode}-${Date.now().toString(36).slice(-5).toUpperCase()}` : `CARRIER-${Date.now().toString(36).toUpperCase()}`;
        const carrier = await Carrier.create({
            code: generatedCode,
            name: req.body.name.trim(),
            email: initialEmail,
            emails: [initialEmail],
            active: req.body.active ?? true,
            notes: req.body.notes ?? '',
        });
        res.status(201).json(carrier);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const addCarrierEmail = async (req, res) => {
    try {
        const { email } = req.body;
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) {
            return res.status(400).json({ message: 'Email address is required.' });
        }
        const carrier = await Carrier.findById(req.params.id);
        if (!carrier) return res.status(404).json({ message: 'Carrier not found.' });

        const emails = Array.isArray(carrier.emails) && carrier.emails.length > 0
            ? carrier.emails
            : (carrier.email ? [carrier.email] : []);

        if (!emails.includes(normalizedEmail)) {
            emails.push(normalizedEmail);
        }
        carrier.emails = emails;
        if (!carrier.email) carrier.email = normalizedEmail;
        await carrier.save();
        res.json(carrier);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const removeCarrierEmail = async (req, res) => {
    try {
        const { email } = req.body;
        const normalizedEmail = String(email || '').trim().toLowerCase();
        const carrier = await Carrier.findById(req.params.id);
        if (!carrier) return res.status(404).json({ message: 'Carrier not found.' });

        let emails = Array.isArray(carrier.emails) && carrier.emails.length > 0
            ? carrier.emails
            : (carrier.email ? [carrier.email] : []);

        emails = emails.filter((em) => em !== normalizedEmail);
        carrier.emails = emails;
        if (carrier.email === normalizedEmail) {
            carrier.email = emails[0] || '';
        }
        await carrier.save();
        res.json(carrier);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateCarrier = async (req, res) => {
    try {
        const carrier = await Carrier.findByIdAndUpdate(
            req.params.id,
            {
                ...(req.body.code ? { code: req.body.code } : {}),
                ...(req.body.name ? { name: req.body.name } : {}),
                ...(req.body.email !== undefined ? { email: req.body.email } : {}),
                ...(req.body.emails !== undefined ? { emails: req.body.emails } : {}),
                ...(req.body.active !== undefined ? { active: req.body.active } : {}),
                ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
            },
            { new: true, runValidators: true }
        );
        if (!carrier) return res.status(404).json({ message: 'Carrier not found.' });
        res.json(carrier);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteCarrier = async (req, res) => {
    try {
        const carrier = await Carrier.findByIdAndDelete(req.params.id);
        if (!carrier) return res.status(404).json({ message: 'Carrier not found.' });
        res.json({ message: 'Carrier deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    listCarriers,
    createCarrier,
    addCarrierEmail,
    removeCarrierEmail,
    updateCarrier,
    deleteCarrier,
};
