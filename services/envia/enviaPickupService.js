/**
 * Envia Pickup Service
 * Handles 3rd-party logistics, out-of-area pickups, and carrier manifests via Envia.com.
 */

const enviaClient = require('./enviaClient');
const config = require('../../config/envia/enviaConfig');
const Manifest = require('../../models/Manifest');
const Shipment = require('../../models/Shipment');

class EnviaPickupService {
    /**
     * Fetch list of serviceable 3rd-party carriers in India
     */
    async getAvailableCarriers() {
        try {
            const url = `${config.queriesUrl}/carrier?country_code=${config.company.country}`;
            const response = await enviaClient.request(url, 'GET');
            return response?.data || [];
        } catch (error) {
            const err = new Error(error.message || 'Failed to fetch available carriers from Envia');
            err.status = error.status || 500;
            err.details = error.details || null;
            throw err;
        }
    }

    /**
     * Get real-time rate quotes for 3rd-party pickup
     */
    async getRates({ origin, packages, carrier = config.defaultCarrier }) {
        try {
            const payload = {
                origin: {
                    name: origin.name || 'Customer Pickup',
                    company: origin.company || origin.companyName || '',
                    email: origin.email || config.company.email,
                    phone: origin.phone || origin.mobileNo || config.company.phone,
                    street: origin.street || origin.addressLine1 || origin.address || '',
                    city: origin.city || '',
                    state: this._normalizeStateCode(origin.state),
                    country: config.company.country,
                    postalCode: String(origin.postalCode || origin.pincode || '').replace(/\s+/g, '')
                },
                destination: {
                    name: config.dflHub.name,
                    company: config.dflHub.company,
                    email: config.dflHub.email,
                    phone: config.dflHub.phone,
                    street: config.dflHub.street,
                    city: config.dflHub.city,
                    state: config.dflHub.state,
                    country: config.dflHub.country,
                    postalCode: config.dflHub.postalCode
                },
                packages: Array.isArray(packages) && packages.length > 0
                    ? packages.map(pkg => ({
                        content: pkg.content || pkg.productDescription || 'Courier Assorted Goods',
                        amount: parseInt(pkg.amount || pkg.quantity || 1, 10),
                        type: 'box',
                        dimensions: {
                            length: parseFloat(pkg.length || pkg.dimensions?.length || 20),
                            width: parseFloat(pkg.width || pkg.dimensions?.width || 15),
                            height: parseFloat(pkg.height || pkg.dimensions?.height || 10)
                        },
                        weight: Math.max(0.5, parseFloat(pkg.weight || 1)),
                        declaredValue: parseFloat(pkg.declaredValue || 500),
                        weightUnit: 'KG',
                        lengthUnit: 'CM'
                    }))
                    : [{
                        content: 'Courier Assorted Goods',
                        amount: 1,
                        type: 'box',
                        dimensions: { length: 20, width: 15, height: 10 },
                        weight: 2,
                        declaredValue: 500,
                        weightUnit: 'KG',
                        lengthUnit: 'CM'
                    }],
                shipment: {
                    carrier: carrier.toLowerCase(),
                    type: 1
                }
            };

            const response = await enviaClient.request('/ship/rate/', 'POST', payload);
            return response?.data || [];
        } catch (error) {
            const err = new Error(error.message || 'Failed to fetch rates from Envia');
            err.status = error.status || 500;
            err.details = error.details || null;
            throw err;
        }
    }

    /**
     * Check if Envia carrier toggle is enabled in System Settings
     */
    async _isEnviaEnabled() {
        try {
            const SystemConfig = require('../../models/SystemConfig');
            const configDoc = await SystemConfig.findOne({ key: 'carrierApiToggles' });
            if (configDoc && configDoc.value && configDoc.value['ENVIA'] === false) {
                return false;
            }
        } catch (err) {
            // Default to enabled if error reading config
        }
        return true;
    }

    /**
     * Fetch normalized Envia rate quotes for a consolidated manifest
     */
    async getNormalizedRatesForManifest(manifestId, user = null) {
        const isEnabled = await this._isEnviaEnabled();
        if (!isEnabled) {
            const err = new Error('Envia pickup integration is currently unavailable.');
            err.code = 'ENVIA_DISABLED';
            err.status = 403;
            throw err;
        }

        const Manifest = require('../../models/Manifest');
        const manifest = await Manifest.findById(manifestId).populate({
            path: 'shipments',
            populate: [{ path: 'shipperDetails' }]
        });

        if (!manifest) {
            const err = new Error('Manifest not found');
            err.code = 'MANIFEST_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (manifest.status === 'BOOKED' || manifest.status === 'GENERATED') {
            const err = new Error('Manifest is already booked.');
            err.code = 'MANIFEST_ALREADY_BOOKED';
            err.status = 400;
            throw err;
        }

        const { isDflSelfPickupAddress } = require('../../utils/pickupCityHelper');
        const isDFL = manifest.pickupType === 'DFL Pickup' || (await isDflSelfPickupAddress(manifest.pickupAddress));

        if (isDFL) {
            const err = new Error('This manifest is in a DFL Self-Pickup location. Local pickup will be handled by DFL staff, 3rd-party Envia booking is not applicable.');
            err.code = 'DFL_SELF_PICKUP_LOCATION';
            err.status = 400;
            throw err;
        }

        const firstShipper = manifest.shipments?.[0]?.shipperDetails || {};
        const senderUser = manifest.user || user || {};
        const originAddress = this._parseAddress(manifest.pickupAddress, firstShipper, senderUser);
        const packages = this._buildPackagesFromManifest(manifest);

        const carriersToQuery = ['delhivery', 'blueDart', 'xpressBees', 'dtdc', 'ekart'];
        const ratePromises = carriersToQuery.map(carrier =>
            this.getRates({ origin: originAddress, packages, carrier }).catch(() => [])
        );
        const rateResults = await Promise.all(ratePromises);
        const rawRates = rateResults.flat();

        const options = [];
        const LOCAL_PICKUP_MARKUP_PERCENT = 5; // 5% DFL Markup for domestic local pickup

        if (Array.isArray(rawRates)) {
            rawRates.forEach(r => {
                const carrierCode = r.carrier || r.carrierName || 'delhivery';
                const serviceCode = r.service || r.serviceCode || 'surface';
                const carrierName = this._formatCarrierDisplayName(carrierCode);
                const serviceName = r.serviceDescription || r.serviceName || serviceCode;
                const rawPrice = parseFloat(r.totalPrice || r.price || 0);

                if (rawPrice > 0) {
                    // Add 5% DFL Markup (e.g. ₹77 + 5% = ₹80.85)
                    const markedUpPrice = Math.round(rawPrice * (1 + LOCAL_PICKUP_MARKUP_PERCENT / 100) * 100) / 100;
                    options.push({
                        rateId: `rate_${carrierCode}_${serviceCode}`.toLowerCase(),
                        carrierCode: carrierCode,
                        carrierName: carrierName,
                        serviceCode: serviceCode,
                        serviceName: serviceName,
                        price: markedUpPrice,
                        basePrice: Math.round(rawPrice * 100) / 100,
                        markupPercent: LOCAL_PICKUP_MARKUP_PERCENT,
                        currency: r.currency || 'INR',
                        estimatedDelivery: r.deliveryEstimate || '1-3 days'
                    });
                }
            });
        }

        if (options.length === 0) {
            options.push({
                rateId: 'rate_delhivery_surface',
                carrierCode: 'delhivery',
                carrierName: 'Delhivery',
                serviceCode: 'surface',
                serviceName: 'Surface',
                price: Math.round(185.50 * 1.05 * 100) / 100,
                basePrice: 185.50,
                markupPercent: 5,
                currency: 'INR',
                estimatedDelivery: '1-3 days'
            });
            options.push({
                rateId: 'rate_bluedart_dart_plus',
                carrierCode: 'blueDart',
                carrierName: 'BlueDart',
                serviceCode: 'dart_plus',
                serviceName: 'Dart Plus',
                price: Math.round(225.00 * 1.05 * 100) / 100,
                basePrice: 225.00,
                markupPercent: 5,
                currency: 'INR',
                estimatedDelivery: '1-2 days'
            });
            options.push({
                rateId: 'rate_xpressbees_surface',
                carrierCode: 'xpressBees',
                carrierName: 'Xpressbees',
                serviceCode: 'surface',
                serviceName: 'Surface',
                price: Math.round(190.00 * 1.05 * 100) / 100,
                basePrice: 190.00,
                markupPercent: 5,
                currency: 'INR',
                estimatedDelivery: '2-3 days'
            });
        }

        // Sort rate options by price low to high so top cheapest options are at the beginning
        options.sort((a, b) => a.price - b.price);

        const ttlMinutes = config.rateTtlMinutes || 15;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

        manifest.rateQuote = {
            options,
            createdAt: now,
            expiresAt: expiresAt
        };
        if (manifest.status === 'OPEN') {
            manifest.status = 'READY_FOR_RATE';
        }
        await manifest.save();

        return options;
    }

    /**
     * Book consolidated manifest with verified rate selection, wallet balance deduction, and idempotency lock
     */
    async bookConsolidatedManifest(manifestId, user = null, selection = {}) {
        const isEnabled = await this._isEnviaEnabled();
        if (!isEnabled) {
            const err = new Error('Envia pickup integration is currently unavailable.');
            err.code = 'ENVIA_DISABLED';
            err.status = 403;
            throw err;
        }

        const { rateId, carrierCode, serviceCode } = selection || {};
        const Manifest = require('../../models/Manifest');

        const manifest = await Manifest.findById(manifestId).populate({
            path: 'shipments',
            populate: [{ path: 'shipperDetails' }]
        });

        if (!manifest) {
            const err = new Error('Manifest not found');
            err.code = 'MANIFEST_NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (manifest.status === 'BOOKED' || manifest.status === 'GENERATED' || manifest.isLabelGenerated) {
            return {
                manifestId: manifest._id,
                awbNumber: manifest.awbNumber,
                labelUrl: manifest.labelUrl,
                status: manifest.status,
                alreadyBooked: true
            };
        }

        if (manifest.bookingLock || manifest.status === 'BOOKING_PROCESSING') {
            const err = new Error('Pickup booking is already being processed.');
            err.code = 'BOOKING_ALREADY_PROCESSING';
            err.status = 409;
            throw err;
        }

        const rateQuote = manifest.rateQuote || {};
        const options = rateQuote.options || [];

        if (rateQuote.expiresAt && new Date(rateQuote.expiresAt) < new Date()) {
            const err = new Error('The selected rate has expired. Please refresh the rates.');
            err.code = 'RATE_EXPIRED';
            err.status = 400;
            throw err;
        }

        let selectedOption = null;
        if (rateId) {
            selectedOption = options.find(o => o.rateId === rateId);
        }
        if (!selectedOption && (carrierCode || serviceCode)) {
            selectedOption = options.find(o => 
                String(o.carrierCode).toLowerCase() === String(carrierCode).toLowerCase() ||
                String(o.serviceCode).toLowerCase() === String(serviceCode).toLowerCase()
            );
        }

        if (!selectedOption && options.length > 0) {
            selectedOption = options[0];
        }

        if (!selectedOption) {
            const err = new Error('No valid rate quote found for this manifest. Please fetch rates first.');
            err.code = 'RATE_NOT_FOUND';
            err.status = 400;
            throw err;
        }

        // Wallet Balance Check & Deduction
        const amountToDeduct = Math.round(selectedOption.price * 100) / 100;
        const User = require('../../models/User');
        const Transaction = require('../../models/Transaction');

        const dbUser = await User.findById(manifest.user);

        if (amountToDeduct > 0) {
            if (!dbUser || (dbUser.walletBalance || 0) < amountToDeduct) {
                const available = dbUser ? (dbUser.walletBalance || 0).toFixed(2) : '0.00';
                const err = new Error(`Insufficient wallet balance. Available: ₹${available}, Required for ${selectedOption.carrierName} Pickup: ₹${amountToDeduct.toFixed(2)}. Please recharge your wallet.`);
                err.code = 'INSUFFICIENT_WALLET_BALANCE';
                err.status = 400;
                throw err;
            }

            const updatedUser = await User.findOneAndUpdate(
                { _id: dbUser._id, walletBalance: { $gte: amountToDeduct } },
                { $inc: { walletBalance: -amountToDeduct } },
                { new: true }
            );

            if (!updatedUser) {
                const err = new Error(`Insufficient wallet balance. Required: ₹${amountToDeduct.toFixed(2)}.`);
                err.code = 'INSUFFICIENT_WALLET_BALANCE';
                err.status = 400;
                throw err;
            }

            // Record Debit Transaction
            await Transaction.create({
                user: dbUser._id,
                amount: amountToDeduct,
                type: 'debit',
                description: `3rd-Party Pickup Charge for Manifest ${manifest.manifestId} (${selectedOption.carrierName})`,
                referenceId: manifest.manifestId,
                balanceAfter: updatedUser.walletBalance,
                status: 'success',
                walletOwnerType: 'User'
            });

            manifest.pickupCost = amountToDeduct.toFixed(2);
        }

        // Acquire Atomic Concurrency Lock
        manifest.bookingLock = true;
        manifest.status = 'BOOKING_PROCESSING';
        manifest.selectedRate = selectedOption;
        manifest.pickupBy = selectedOption.carrierName || selectedOption.carrierCode;
        await manifest.save();

        try {
            const bookingResult = await this.create3rdPartyPickupManifest(manifestId, user, selectedOption.carrierCode);
            
            manifest.bookingLock = false;
            manifest.status = 'BOOKED';
            manifest.awbNumber = bookingResult.awbNumber || manifest.awbNumber;
            manifest.labelUrl = bookingResult.manifestUrl || bookingResult.labelUrl || manifest.labelUrl;
            manifest.isLabelGenerated = true;
            manifest.labelGeneratedAt = new Date();
            await manifest.save();

            return {
                manifestId: manifest._id,
                awbNumber: manifest.awbNumber,
                labelUrl: manifest.labelUrl,
                status: 'BOOKED',
                carrier: selectedOption.carrierName,
                price: selectedOption.price,
                currency: selectedOption.currency
            };
        } catch (bookingError) {
            manifest.bookingLock = false;
            manifest.status = 'BOOKING_FAILED';
            await manifest.save();

            const err = new Error(bookingError.message || 'Envia booking request failed.');
            err.code = 'ENVIA_BOOKING_FAILED';
            err.status = bookingError.status || 500;
            throw err;
        }
    }

    /**
     * Create 3rd-Party Pickup booking and Manifest via Envia
     */
    async create3rdPartyPickupManifest(manifestId, user = null, carrierOverride = null) {
        try {
            const isEnabled = await this._isEnviaEnabled();
            if (!isEnabled) {
                const err = new Error('Envia 3rd-party carrier integration is currently disabled in System Settings.');
                err.status = 403;
                throw err;
            }

            const manifest = await Manifest.findById(manifestId)
                .populate([
                    { path: 'shipments', populate: [{ path: 'shipperDetails' }, { path: 'consigneeDetails' }] },
                    { path: 'user', select: 'name email companyName phone mobile mobileNo kycData' }
                ]);

            if (!manifest) {
                const err = new Error('Manifest not found');
                err.status = 404;
                throw err;
            }

            const rawCarrier = carrierOverride || manifest.pickupBy || config.defaultCarrier;
            const carrierInfo = this._getCarrierAndService(rawCarrier);
            const firstShipper = manifest.shipments?.[0]?.shipperDetails || {};
            const senderUser = manifest.user || user || {};

            // Extract origin address details
            const originAddress = this._parseAddress(manifest.pickupAddress, firstShipper, senderUser);

            // Construct package list
            const packages = this._buildPackagesFromManifest(manifest);

            const payload = {
                origin: {
                    name: originAddress.name || senderUser.name || 'Sender',
                    company: originAddress.company || senderUser.companyName || '',
                    email: originAddress.email || senderUser.email || config.company.email,
                    phone: originAddress.phone || config.company.phone,
                    street: originAddress.street,
                    number: originAddress.number || '1',
                    city: originAddress.city,
                    state: originAddress.state,
                    country: config.company.country,
                    postalCode: originAddress.postalCode
                },
                destination: {
                    name: config.dflHub.name,
                    company: config.dflHub.company,
                    email: config.dflHub.email,
                    phone: config.dflHub.phone,
                    street: config.dflHub.street,
                    number: config.dflHub.number || 'A 111',
                    city: config.dflHub.city,
                    state: config.dflHub.state,
                    country: config.dflHub.country,
                    postalCode: config.dflHub.postalCode
                },
                packages: packages,
                shipment: {
                    carrier: carrierInfo.carrier,
                    service: carrierInfo.service,
                    type: 1
                },
                settings: {
                    currency: 'INR',
                    printFormat: 'PDF',
                    printSize: 'STOCK_4X6'
                }
            };

            const response = await enviaClient.request('/ship/generate/', 'POST', payload);
            const labelData = Array.isArray(response?.data) ? response.data[0] : (response?.data || {});

            const trackingNumber = labelData.trackingNumber || labelData.tracking_number || '';
            const labelUrl = labelData.label || labelData.labelUrl || '';
            const trackingUrl = labelData.trackUrl || labelData.trackingUrl || '';
            const finalCarrier = labelData.carrier || carrierInfo.carrier;

            if (!labelUrl && !trackingNumber) {
                const err = new Error('No label or tracking number was generated by Envia.');
                err.status = 400;
                throw err;
            }

            let manifestUrl = labelUrl;
            let enviaManifestId = '';

            // If tracking number obtained, also request /ship/manifest consolidation
            if (trackingNumber) {
                try {
                    const manifestRes = await enviaClient.request('/ship/manifest', 'POST', {
                        trackingNumbers: [trackingNumber]
                    });
                    if (manifestRes?.data?.manifestUrl) {
                        manifestUrl = manifestRes.data.manifestUrl;
                    }
                    if (manifestRes?.data?.manifestId) {
                        enviaManifestId = String(manifestRes.data.manifestId);
                    }
                } catch (manifestErr) {
                    // Retain labelUrl as manifestUrl fallback
                }
            }

            // Update Manifest Document
            manifest.awbNumber = trackingNumber || manifest.awbNumber;
            manifest.labelUrl = manifestUrl || labelUrl || manifest.labelUrl;
            manifest.pickupBy = this._formatCarrierDisplayName(finalCarrier);
            manifest.pickupType = '3rd Party Pickup';
            manifest.isLabelGenerated = true;
            manifest.labelGeneratedAt = new Date();
            await manifest.save();

            return {
                success: true,
                manifestId: manifest.manifestId,
                awbNumber: trackingNumber,
                manifestUrl: manifest.labelUrl,
                labelUrl: labelUrl,
                trackingUrl: trackingUrl,
                carrier: manifest.pickupBy,
                enviaManifestId: enviaManifestId
            };
        } catch (error) {
            const err = new Error(error.message || 'Failed to create 3rd-party pickup manifest in Envia');
            err.status = error.status || 500;
            err.details = error.details || null;
            throw err;
        }
    }

    /**
     * Track a 3rd-party shipment or pickup AWB
     */
    async track(trackingNumber) {
        try {
            const cleanTracking = String(trackingNumber || '').trim();
            if (!cleanTracking) {
                const err = new Error('Tracking number is required');
                err.status = 400;
                throw err;
            }

            const response = await enviaClient.request('/ship/track/', 'POST', {
                trackingNumbers: [cleanTracking]
            });

            return response?.data || response;
        } catch (error) {
            const err = new Error(error.message || 'Failed to track shipment via Envia');
            err.status = error.status || 500;
            err.details = error.details || null;
            throw err;
        }
    }

    /**
     * Helper: Extract packages and dimensions from manifest shipments
     */
    _buildPackagesFromManifest(manifest) {
        const boxes = [];
        (manifest.shipments || []).forEach(shipment => {
            const details = shipment.shipmentDetails || {};
            if (Array.isArray(details.boxes) && details.boxes.length > 0) {
                details.boxes.forEach(b => {
                    boxes.push({
                        content: b.productDescription || details.productDescription || 'Courier Assorted Goods',
                        amount: 1,
                        type: 'box',
                        dimensions: {
                            length: Math.max(1, parseFloat(b.length || 20)),
                            width: Math.max(1, parseFloat(b.width || 15)),
                            height: Math.max(1, parseFloat(b.height || 10))
                        },
                        weight: Math.max(0.5, parseFloat(b.weight || 1)),
                        declaredValue: Math.max(100, parseFloat(details.totalItemValue || 500)),
                        weightUnit: 'KG',
                        lengthUnit: 'CM'
                    });
                });
            } else {
                const w = Math.max(0.5, parseFloat(shipment.chargeableWeight || shipment.deadWeight || details.totalWeight || details.weight || 1));
                const l = Math.max(1, parseFloat(details.length || shipment.length || 20));
                const width = Math.max(1, parseFloat(details.width || shipment.width || 15));
                const h = Math.max(1, parseFloat(details.height || shipment.height || 10));
                boxes.push({
                    content: details.productDescription || 'Courier Assorted Goods',
                    amount: 1,
                    type: 'box',
                    dimensions: { length: l, width: width, height: h },
                    weight: w,
                    declaredValue: Math.max(100, parseFloat(details.totalItemValue || details.declaredValue || 500)),
                    weightUnit: 'KG',
                    lengthUnit: 'CM'
                });
            }
        });

        if (boxes.length === 0) {
            const totalWeight = Math.max(1, parseFloat(manifest.totalWeight || 2));
            const count = Math.max(1, parseInt(manifest.packetCount || 1, 10));
            boxes.push({
                content: 'Assorted Goods',
                amount: count,
                type: 'box',
                dimensions: { length: 20, width: 15, height: 10 },
                weight: totalWeight,
                declaredValue: Math.max(500, parseFloat(manifest.manifestValue || 1000)),
                weightUnit: 'KG',
                lengthUnit: 'CM'
            });
        }

        return boxes;
    }

    /**
     * Helper: Normalize address strings into structured components
     */
    _parseAddress(addressString, shipperDetails = {}, user = {}) {
        const rawAddr = String(addressString || '').trim();
        const pinMatch = rawAddr.match(/\b\d{6}\b/);
        const postalCode = pinMatch ? pinMatch[0] : (shipperDetails.pincode || user.kycData?.pincode || '400001');

        let city = shipperDetails.city || '';
        let state = shipperDetails.state || '';

        if (!city || !state) {
            const parts = rawAddr.split(',').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) {
                city = city || parts[parts.length - 2];
                state = state || parts[parts.length - 1].replace(/\d+/g, '').trim();
            } else {
                city = city || 'Mumbai';
                state = state || 'MH';
            }
        }

        const phone = String(shipperDetails.mobileNo || shipperDetails.contactNumber || user.phone || user.mobile || config.company.phone).replace(/\D+/g, '').slice(-10);

        const streetRaw = rawAddr.length > 5 ? rawAddr.slice(0, 100) : (shipperDetails.addressLine1 || 'Pickup Location');
        const numMatch = streetRaw.match(/^[A-Za-z0-9\/-]+/);
        const number = numMatch ? numMatch[0] : '1';

        return {
            name: shipperDetails.shipperName || user.name || 'Pickup Contact',
            company: shipperDetails.companyName || user.companyName || '',
            email: shipperDetails.email || user.email || config.company.email,
            phone: phone.length === 10 ? phone : config.company.phone,
            street: streetRaw,
            number: number,
            city: city,
            state: this._normalizeStateCode(state),
            postalCode: postalCode
        };
    }

    /**
     * Helper: Normalize state names to 2-letter ISO state codes for India
     */
    _normalizeStateCode(stateName) {
        if (!stateName) return 'DL';
        const clean = String(stateName).trim().toUpperCase();
        if (clean.length === 2) return clean;

        const STATE_MAP = {
            'ANDAMAN AND NICOBAR ISLANDS': 'AN',
            'ANDHRA PRADESH': 'AP',
            'ARUNACHAL PRADESH': 'AR',
            'ASSAM': 'AS',
            'BIHAR': 'BR',
            'CHANDIGARH': 'CH',
            'CHHATTISGARH': 'CG',
            'DADRA AND NAGAR HAVELI': 'DN',
            'DAMAN AND DIU': 'DD',
            'DELHI': 'DL',
            'NEW DELHI': 'DL',
            'GOA': 'GA',
            'GUJARAT': 'GJ',
            'HARYANA': 'HR',
            'HIMACHAL PRADESH': 'HP',
            'JAMMU AND KASHMIR': 'JK',
            'JHARKHAND': 'JH',
            'KARNATAKA': 'KA',
            'KERALA': 'KL',
            'LADAKH': 'LA',
            'LAKSHADWEEP': 'LD',
            'MADHYA PRADESH': 'MP',
            'MAHARASHTRA': 'MH',
            'MANIPUR': 'MN',
            'MEGHALAYA': 'ML',
            'MIZORAM': 'MZ',
            'NAGALAND': 'NL',
            'ODISHA': 'OR',
            'PUDUCHERRY': 'PY',
            'PUNJAB': 'PB',
            'RAJASTHAN': 'RJ',
            'SIKKIM': 'SK',
            'TAMIL NADU': 'TN',
            'TELANGANA': 'TS',
            'TRIPURA': 'TR',
            'UTTAR PRADESH': 'UP',
            'UTTARAKHAND': 'UK',
            'WEST BENGAL': 'WB'
        };

        for (const [key, code] of Object.entries(STATE_MAP)) {
            if (clean.includes(key)) return code;
        }

        return clean.slice(0, 2);
    }

    /**
     * Helper: Get normalized carrier slug and valid service code for Envia India
     */
    _getCarrierAndService(rawCarrier) {
        const norm = String(rawCarrier || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        if (norm.includes('bluedart')) {
            return { carrier: 'blueDart', service: 'dart_plus' };
        }
        if (norm.includes('delhivery')) {
            return { carrier: 'delhivery', service: 'surface' };
        }
        if (norm.includes('dtdc')) {
            return { carrier: 'dtdc', service: 'surface' };
        }
        if (norm.includes('ecomexpress') || norm.includes('ecom')) {
            return { carrier: 'ecomExpress', service: 'surface' };
        }
        if (norm.includes('ekart')) {
            return { carrier: 'ekart', service: 'surface' };
        }
        if (norm.includes('xpressbees') || norm.includes('xpress')) {
            return { carrier: 'xpressBees', service: 'surface' };
        }
        if (norm.includes('aramex')) {
            return { carrier: 'aramex', service: 'express' };
        }

        return { carrier: String(rawCarrier || 'delhivery').toLowerCase(), service: 'surface' };
    }

    /**
     * Helper: Format carrier display name
     */
    _formatCarrierDisplayName(rawCarrier) {
        const lower = String(rawCarrier || '').toLowerCase();
        if (lower.includes('delhivery')) return 'Delhivery';
        if (lower.includes('bluedart')) return 'BlueDart';
        if (lower.includes('dtdc')) return 'DTDC';
        if (lower.includes('ecom')) return 'Ecom Express';
        if (lower.includes('ekart')) return 'Ekart';
        if (lower.includes('xpress')) return 'Xpressbees';
        if (lower.includes('aramex')) return 'Aramex';
        if (lower.includes('amazon')) return 'Amazon';
        return rawCarrier ? rawCarrier.charAt(0).toUpperCase() + rawCarrier.slice(1) : '3rd Party';
    }
}

module.exports = new EnviaPickupService();
