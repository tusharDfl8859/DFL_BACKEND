const SystemConfig = require('../models/SystemConfig');
const currencyRateService = require('../services/currency/currencyRateService');

const defaultConfig = {
    willowApiEnabled: true,
    usdToInrRate: 87,
    uspsGround: {
        isActive: true,
        displayName: 'DFL Commerce Ground',
        airFreightPerKg: 400,
        indiaTHCPerKg: 15,
        indiaCustomsPerShipment: 60,
        usCustomsPerShipment: 65,
        transitTime: '3-5'
    },
    uniuni: {
        isActive: true,
        displayName: 'DFL Commerce Uni Uni',
        airFreightPerKg: 380,
        indiaTHCPerKg: 15,
        indiaCustomsPerShipment: 60,
        usCustomsPerShipment: 65,
        transitTime: '4-7'
    }
};

exports.getWillowConfig = async (req, res) => {
    try {
        let config = await SystemConfig.findOne({ key: 'willowCommerceConfig' });
        if (!config) {
            config = { value: defaultConfig };
        }
        const effectiveUsdToInr = await currencyRateService.getEffectiveUsdToInrRate();
        const mergedValue = {
            willowApiEnabled: config.value?.willowApiEnabled !== false,
            usdToInrRate: effectiveUsdToInr,
            uspsGround: { ...defaultConfig.uspsGround, ...(config.value?.uspsGround || {}) },
            uniuni: { ...defaultConfig.uniuni, ...(config.value?.uniuni || {}) }
        };
        if (!mergedValue.uspsGround.displayName || mergedValue.uspsGround.displayName.includes('Willow Commerce')) {
            mergedValue.uspsGround.displayName = 'DFL Commerce Ground';
        }
        if (!mergedValue.uniuni.displayName || mergedValue.uniuni.displayName.includes('Willow Commerce')) {
            mergedValue.uniuni.displayName = 'DFL Commerce Uni Uni';
        }
        delete mergedValue.uspsGround?.handlingFee;
        delete mergedValue.uniuni?.handlingFee;
        delete mergedValue.uspsGround?.markupPercentage;
        delete mergedValue.uniuni?.markupPercentage;
        res.json(mergedValue);
    } catch (err) {
        console.error('Error fetching Willow Commerce config:', err);
        res.status(500).json({ message: 'Error fetching Willow Commerce configuration' });
    }
};

exports.updateWillowConfig = async (req, res) => {
    try {
        const updateData = req.body;
        if (updateData.usdToInrRate !== undefined && updateData.usdToInrRate !== null) {
            try {
                await currencyRateService.setManualOverride(updateData.usdToInrRate, req.user ? req.user._id : null);
            } catch (rateErr) {
                console.warn('[WillowConfigController] Manual rate override sync warning:', rateErr.message);
            }
        }
        if (updateData.willowApiEnabled !== undefined) {
            try {
                let carrierTogglesDoc = await SystemConfig.findOne({ key: 'carrierApiToggles' });
                if (carrierTogglesDoc && carrierTogglesDoc.value) {
                    carrierTogglesDoc.value.WILLOW = updateData.willowApiEnabled;
                    carrierTogglesDoc.markModified('value');
                    await carrierTogglesDoc.save();
                }
            } catch (toggleErr) {
                console.warn('[WillowConfigController] Carrier API toggle sync warning:', toggleErr.message);
            }
        }
        const config = await SystemConfig.findOneAndUpdate(
            { key: 'willowCommerceConfig' },
            {
                value: updateData,
                updatedBy: req.user ? req.user._id : null
            },
            { upsert: true, new: true }
        );
        res.json(config.value);
    } catch (err) {
        console.error('Error updating Willow Commerce config:', err);
        res.status(500).json({ message: 'Error updating Willow Commerce configuration' });
    }
};

