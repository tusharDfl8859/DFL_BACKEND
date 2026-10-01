/**
 * DFL AI Chatbot Orchestrator Service
 * Combines Prompt Injection Protection, Tenant Isolation Data Retrieval,
 * PII Pre-Masking, OpenAI API Call with Fallback, and Output Privacy Guard.
 */

const ChatSession = require('../../models/ChatSession');
const User = require('../../models/User');
const Ticket = require('../../models/Ticket');
const { sanitizePii } = require('./piiMaskingService');
const { inspectPromptSecurity } = require('./promptGuardService');
const { sanitizeOutput } = require('./outputGuardService');
const {
    getShipmentContext,
    getUserRecentShipmentsContext,
    getUserShipmentSummaryContext,
    getUserLatestTransaction
} = require('./shipmentContextService');
const {
    DFL_COMPANY_INFO,
    DFL_BRANCHES,
    DFL_SERVICES,
    DFL_PRIVACY_POLICY_SUMMARY,
    DFL_TERMS_SUMMARY,
    DFL_PROHIBITED_ITEMS
} = require('../../constants/dflKnowledgeBase');
const { generateOpenAIResponse } = require('./openaiService');
const { logChatbotEvent } = require('./chatbotAuditService');

/**
 * Tool: Calculate Live Shipping Rate Estimate from Pricing Engine
 */
const calculateShippingRate = async (weight, destinationCountry = 'United States', userId = null) => {
    const numericWeight = parseFloat(weight) || 1.0;

    let countryCode = 'US';
    let cleanCountry = 'United States';
    const destLower = String(destinationCountry).toLowerCase();

    if (destLower.includes('uk') || destLower.includes('united kingdom') || destLower.includes('london') || destLower.includes('england') || destLower.includes('gb') || destLower.includes('britain')) {
        countryCode = 'GB';
        cleanCountry = 'United Kingdom';
    } else if (destLower.includes('canada') || destLower.includes('ca')) {
        countryCode = 'CA';
        cleanCountry = 'Canada';
    } else if (destLower.includes('australia') || destLower.includes('au') || destLower.includes('sydney') || destLower.includes('melbourne')) {
        countryCode = 'AU';
        cleanCountry = 'Australia';
    } else if (destLower.includes('uae') || destLower.includes('dubai') || destLower.includes('emirates') || destLower.includes('ae')) {
        countryCode = 'AE';
        cleanCountry = 'United Arab Emirates';
    } else if (destLower.includes('germany') || destLower.includes('de') || destLower.includes('berlin')) {
        countryCode = 'DE';
        cleanCountry = 'Germany';
    } else if (destLower.includes('singapore') || destLower.includes('sg')) {
        countryCode = 'SG';
        cleanCountry = 'Singapore';
    } else if (destLower.includes('france') || destLower.includes('fr') || destLower.includes('paris')) {
        countryCode = 'FR';
        cleanCountry = 'France';
    } else if (destLower.includes('netherlands') || destLower.includes('nl') || destLower.includes('amsterdam') || destLower.includes('holland')) {
        countryCode = 'NL';
        cleanCountry = 'Netherlands';
    } else if (destLower.includes('japan') || destLower.includes('jp') || destLower.includes('tokyo')) {
        countryCode = 'JP';
        cleanCountry = 'Japan';
    } else if (destLower.includes('hong kong') || destLower.includes('hk')) {
        countryCode = 'HK';
        cleanCountry = 'Hong Kong';
    } else if (destLower.includes('us') || destLower.includes('usa') || destLower.includes('america') || destLower.includes('states')) {
        countryCode = 'US';
        cleanCountry = 'United States';
    } else {
        // Strip weight and units to get country name
        const stripped = destinationCountry.replace(/\d+(\.\d+)?/g, '').replace(/kgs?|kilo(gram)?s?/gi, '').trim();
        if (stripped) {
            cleanCountry = stripped;
        }
    }

    try {
        const { calculateRatesInternal } = require('../../controllers/ratesController');
        const mockRes = { json: (data) => data, status: () => mockRes };
        const destinationObj = {
            country: cleanCountry,
            countryCode: countryCode,
            city: 'Destination City',
            state: countryCode === 'US' ? 'CA' : '',
            zip: countryCode === 'US' ? '95901' : (countryCode === 'GB' ? 'SW1A 1AA' : '10001')
        };

        const rateData = await calculateRatesInternal({
            weight: numericWeight,
            destination: destinationObj,
            packageDetails: { box: [{ weight: numericWeight, length: 10, width: 10, height: 10 }] },
            shipmentType: 'Parcel',
            userId: userId
        }, mockRes);

        const rawCharges = Array.isArray(rateData)
            ? rateData
            : (rateData?.data?.charges || rateData?.charges || rateData?.data || []);

        if (Array.isArray(rawCharges) && rawCharges.length > 0) {
            const emojiIcons = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const formattedOptions = rawCharges.map((rc, idx) => {
                const totalPricing = Math.round((rc.totalPricing || rc.rate || 0) * 100) / 100;
                const gstAmount = Math.round((rc.gstAmount || rc.breakdown?.gst || (totalPricing * 0.18)) * 100) / 100;
                const totalPrice = Math.round((rc.totalAmount || (totalPricing + gstAmount)) * 100) / 100;
                const serviceName = rc.displayName || rc.serviceName || rc.name || `Service ${idx + 1}`;
                const transitDays = rc.deliveryDays || rc.transitTime || '4 - 7 Business Days';

                // Extract carrier buying cost & markup breakdown
                const rawCostVal = rc.breakdown?.rawBase ?? rc.breakdown?.base ?? rc.cost ?? rc.carrierBase;
                const carrierCost = (rawCostVal !== undefined && rawCostVal !== null && !isNaN(parseFloat(rawCostVal)))
                    ? parseFloat(rawCostVal)
                    : (totalPricing * 0.85);

                const markupVal = rc.breakdown?.markup ?? rc.markup;
                const markup = (markupVal !== undefined && markupVal !== null && !isNaN(parseFloat(markupVal)))
                    ? parseFloat(markupVal)
                    : Math.max(0, totalPricing - carrierCost);

                const handling = parseFloat(rc.breakdown?.handlingCharge ?? rc.handling ?? 0) || 0;
                const countrySurcharge = parseFloat(rc.breakdown?.countrySurcharge ?? rc.countrySurcharge ?? 0) || 0;
                const fuelSurcharge = parseFloat(rc.breakdown?.fuelSurcharge ?? rc.fuelSurcharge ?? 0) || 0;
                const dflCost = parseFloat(rc.dflCost ?? rc.breakdown?.dflCost ?? carrierCost) || carrierCost;

                return {
                    serviceName,
                    serviceCode: rc.serviceCode || rc.id || serviceName,
                    carrierCode: rc.carrierCode || rc.carrierId || null,
                    carrierName: rc.carrierName || (serviceName.includes('Commerce') ? 'Willow Commerce' : (serviceName.includes('USPS') ? 'USPS' : 'DFL Express')),
                    provider: rc.provider || (serviceName.includes('Willow') ? 'Willow Commerce' : 'DFL Express'),
                    basePrice: totalPricing, // Selling subtotal before GST
                    cost: Math.round(carrierCost * 100) / 100, // Carrier buying base cost
                    markup: Math.round(markup * 100) / 100,
                    handling: Math.round(handling * 100) / 100,
                    countrySurcharge: Math.round(countrySurcharge * 100) / 100,
                    fuelSurcharge: Math.round(fuelSurcharge * 100) / 100,
                    dflCost: Math.round(dflCost * 100) / 100,
                    gstAmount,
                    totalPrice,
                    basePriceFormatted: `₹${totalPricing.toLocaleString('en-IN')}`,
                    totalPriceFormatted: `₹${totalPrice.toLocaleString('en-IN')}`,
                    transitDays,
                    breakdown: rc.breakdown || {}
                };
            });

            const summaryLines = formattedOptions.map((o, idx) => {
                const icon = emojiIcons[idx] || `•`;
                return `${icon} *${o.serviceName}*\n   💵 Rate: *${o.totalPriceFormatted}* (Base: ${o.basePriceFormatted} + 18% GST)\n   ⏱️ Est. Transit: ${o.transitDays}`;
            });

            return {
                success: true,
                weight: `${numericWeight} kg`,
                destination: cleanCountry,
                options: formattedOptions,
                startingRate: formattedOptions[0]?.totalPriceFormatted,
                summaryText: summaryLines.join('\n\n')
            };
        }
    } catch (err) {
        console.error('[chatbotService] Live rate engine calculation error:', err.message);
    }

    // Fallback estimation if rate cards non-matching
    const isUS = destLower.includes('states') || destLower.includes('usa') || countryCode === 'US';
    const fallbackBase = Math.round(numericWeight * (isUS ? 1795 : 1850));
    const fallbackTotal = Math.round(fallbackBase * 1.18);
    return {
        success: true,
        weight: `${numericWeight} kg`,
        destination: cleanCountry,
        startingRate: `₹${fallbackTotal.toLocaleString('en-IN')}`,
        summaryText: `• *DFL EXPRESS - Standard*: ₹${fallbackTotal.toLocaleString('en-IN')} (Base: ₹${fallbackBase.toLocaleString('en-IN')} + 18% GST)`
    };
};

/**
 * Strictly Scoped Tool: Get User KYC Status
 */
const getUserKycStatus = async (userId) => {
    const user = await User.findById(userId).select('kycVerified kycData accountType');
    if (!user) return { success: false, message: 'User profile not found.' };

    let status = 'Not Submitted';
    if (user.kycVerified || user.kycData?.status === 'verified') {
        status = 'Verified';
    } else if (user.kycData?.status === 'pending') {
        status = 'Pending Review';
    } else if (user.kycData?.status === 'rejected') {
        status = 'Rejected';
    }

    const submittedDate = user.kycData?.kycSubmittedAt || user.kycData?.submittedAt;
    const submittedAt = submittedDate ? new Date(submittedDate).toLocaleDateString('en-IN') : 'N/A';

    return {
        success: true,
        accountType: user.accountType || 'Personal',
        status: status,
        submittedAt: submittedAt,
        rejectionReason: user.kycData?.rejectionReason || null
    };
};

/**
 * Tool: Create Support Ticket on Escalation
 */
const createSupportTicket = async (subject, description, userId) => {
    try {
        const ticketId = `TCK-${Date.now().toString().slice(-6)}`;
        const ticket = await Ticket.create({
            ticketId: ticketId,
            user: userId,
            shipmentId: 'GENERAL-QUERY',
            issueType: 'Other',
            priority: 'Medium',
            description: sanitizePii(description),
            status: 'Pending'
        });
        return { success: true, ticketNumber: ticket.ticketId };
    } catch (err) {
        console.error('Failed to auto-create support ticket:', err);
        return { success: false, ticketNumber: `TCK-${Math.floor(100000 + Math.random() * 900000)}` };
    }
};

/**
 * Helper: Resolve City, State, Country from Postal Code via Google Geocoding
 */
const resolvePincodeGeocode = async (pincode, countryHint = '') => {
    if (!pincode || typeof pincode !== 'string') return null;
    const cleanPin = pincode.trim().toUpperCase();
    if (cleanPin.length < 3) return null;

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCSo4mUY_iGa0MUFUpaPE7ZFYC-Tc5MJjQ';
    if (!apiKey) return null;

    try {
        const axios = require('axios');
        // 1. Try components=postal_code query
        let url = `https://maps.googleapis.com/maps/api/geocode/json?components=postal_code:${encodeURIComponent(cleanPin)}&key=${apiKey}`;
        let res = await axios.get(url, { timeout: 3500 });

        // 2. Fallback to address query if postal_code filter alone yielded zero results
        if (!res.data || res.data.status !== 'OK' || !res.data.results || res.data.results.length === 0) {
            const query = countryHint ? `${cleanPin}, ${countryHint}` : cleanPin;
            url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
            res = await axios.get(url, { timeout: 3500 });
        }

        if (res.data && res.data.status === 'OK' && res.data.results.length > 0) {
            const r = res.data.results[0];
            let city = '';
            let state = '';
            let country = '';
            let countryCode = '';

            r.address_components.forEach(c => {
                if (c.types.includes('locality')) city = c.long_name;
                else if (c.types.includes('postal_town') && !city) city = c.long_name;
                else if (c.types.includes('sublocality_level_1') && !city) city = c.long_name;
                else if (c.types.includes('administrative_area_level_2') && !city) city = c.long_name;

                if (c.types.includes('administrative_area_level_1')) state = c.long_name;
                if (c.types.includes('country')) {
                    country = c.long_name;
                    countryCode = c.short_name;
                }
            });

            if (country) {
                return {
                    city: city || state || '',
                    state: state || '',
                    country: country,
                    countryCode: countryCode || 'US',
                    formattedAddress: r.formatted_address || ''
                };
            }
        }
    } catch (err) {
        console.warn('[ChatbotGeocode] Pincode lookup error:', err.message);
    }
    return null;
};

/**
 * Helper: Parse Consignee Details from Natural User Input
 */
const parseConsigneeInput = async (text, existing = {}) => {
    const lower = text.toLowerCase();

    // Country Detection
    let country = existing.country || null;
    let countryCode = existing.countryCode || null;
    if (lower.includes('uk') || lower.includes('united kingdom') || lower.includes('london') || lower.includes('england') || lower.includes('gb')) {
        country = 'United Kingdom';
        countryCode = 'GB';
    } else if (lower.includes('canada') || lower.includes('toronto') || lower.includes('ca')) {
        country = 'Canada';
        countryCode = 'CA';
    } else if (lower.includes('uae') || lower.includes('dubai') || lower.includes('emirates') || lower.includes('ae')) {
        country = 'UAE';
        countryCode = 'AE';
    } else if (lower.includes('australia') || lower.includes('sydney') || lower.includes('au')) {
        country = 'Australia';
        countryCode = 'AU';
    } else if (lower.includes('germany') || lower.includes('berlin') || lower.includes('de')) {
        country = 'Germany';
        countryCode = 'DE';
    } else if (lower.includes('usa') || lower.includes('united states') || /\b(us|usa)\b/i.test(text) || lower.includes('america') || lower.includes('california') || lower.includes('new york') || lower.includes('texas')) {
        country = 'United States';
        countryCode = 'US';
    } else if (lower.includes('india') || lower.includes('delhi') || lower.includes('mumbai') || lower.includes('noida')) {
        country = 'India';
        countryCode = 'IN';
    }

    // Phone Detection
    const phoneMatch = text.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10,12}\b/);
    const mobileNo = phoneMatch ? phoneMatch[0].trim() : (existing.mobileNo || null);

    // Zipcode / Pincode Detection
    let pincode = null;
    // 1. Explicit keyword pin: ... or zip: ... e.g. "pincode: 201301", "zip 10001", "pin code RG25 2AR"
    const explicitPin = text.match(/(?:pincode|pin\s*code|postcode|post\s*code|zip\s*code|zip)[\s:=]+([A-Za-z0-9\s]{3,10})/i);
    if (explicitPin) pincode = explicitPin[1].trim();

    // 2. Keyword after code: 'RG25 2AR pin code' or '95901 zip'
    if (!pincode) {
        const reversePin = text.match(/([A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}|\b\d{5,6}\b|[A-Za-z]{1,2}\d{1,2}[A-Za-z]?)\s+(?:pincode|pin\s*code|postcode|post\s*code|zip\s*code|zip)\b/i);
        if (reversePin) pincode = reversePin[1].trim();
    }

    // 3. Full UK Postcode (e.g. RG25 2AR, SW1A 1AA)
    if (!pincode) {
        const fullUk = text.match(/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/i);
        if (fullUk) pincode = fullUk[0].trim();
    }

    // 4. US / India / Numeric Pincodes (5 or 6 digits)
    if (!pincode) {
        const numericPin = text.match(/\b\d{5,6}\b/);
        if (numericPin) pincode = numericPin[0].trim();
    }

    // 5. UK Outward code (e.g. RG25, SW1A, EC1) if UK context or distinct token
    if (!pincode) {
        const isUKContext = /uk|united kingdom|great britain|gb|london|england/i.test(text) || (country && /uk|united kingdom|gb/i.test(country));
        if (isUKContext) {
            const ukOutward = text.match(/\b[A-Za-z]{1,2}\d{1,2}[A-Za-z]?\b/i);
            if (ukOutward) pincode = ukOutward[0].trim();
        }
    }

    pincode = pincode ? pincode.toUpperCase() : (existing.pincode || null);

    let city = existing.city || null;
    let state = existing.state || null;

    // Automatic Geocode from Pincode: Ground truth for City, State, Country
    if (pincode) {
        const geo = await resolvePincodeGeocode(pincode, country);
        if (geo && geo.country) {
            city = geo.city || city;
            state = geo.state || state;
            // Pincode overrides country if there was a conflict (e.g. 10001 with Australia)
            country = geo.country;
            countryCode = geo.countryCode;
        }
    }

    // Clean address / name text
    const cleanText = text
        .replace(/address\s*[:=]?/gi, '')
        .replace(/name\s*[:=]?/gi, '')
        .replace(/receiver\s*[:=]?/gi, '')
        .trim();

    const lines = cleanText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

    let consigneeName = existing.consigneeName || null;
    let addressLine1 = existing.addressLine1 || null;

    if (!consigneeName && lines.length > 0) {
        // If line contains only a person's name (letters and spaces only, no street/house/digits)
        if (/^[a-zA-Z\s.]{2,40}$/.test(lines[0]) && !/(address|street|road|box|parcel|pincode|zip|country)/i.test(lines[0])) {
            consigneeName = lines[0];
            if (lines.length > 1) {
                // Filter out tokens that are purely phone numbers, pincodes, or country tags from addressLine1
                const addressParts = lines.slice(1).filter(l => {
                    const lClean = l.trim().toLowerCase();
                    if (mobileNo && l.replace(/\D/g, '') === mobileNo.replace(/\D/g, '')) return false;
                    if (pincode && (lClean === pincode.toLowerCase() || pincode.toLowerCase().startsWith(lClean))) return false;
                    if (country && (lClean === country.toLowerCase() || lClean === 'uk' || lClean === 'usa' || lClean === 'us' || lClean === 'gb' || lClean === 'india')) return false;
                    return true;
                });
                addressLine1 = addressParts.length > 0 ? addressParts.join(', ') : lines.slice(1).join(', ');
            }
        } else {
            addressLine1 = cleanText;
        }
    } else if (consigneeName && !addressLine1) {
        addressLine1 = cleanText;
    } else if (addressLine1 && cleanText && !addressLine1.includes(cleanText)) {
        addressLine1 = `${addressLine1}, ${cleanText}`;
    }

    // Check if input looks like a complete address (has address/destination/pincode)
    const hasAddressInfo = Boolean(
        country ||
        pincode ||
        mobileNo ||
        (addressLine1 && addressLine1 !== consigneeName && addressLine1.length > 5) ||
        lines.length > 1
    );

    const isUK = (country && /uk|united kingdom|gb/i.test(country)) || countryCode === 'GB';
    const isIN = (country && /india/i.test(country)) || countryCode === 'IN';
    const defaultPin = isUK ? 'RG25 2AR' : (isIN ? '110001' : '10001');

    return {
        consigneeName: consigneeName || 'Consignee Receiver',
        mobileNo: mobileNo || '+1 555-0199',
        email: existing.email || 'consignee@example.com',
        addressLine1: addressLine1 || cleanText || 'Delivery Address',
        city: city || existing.city || (isUK ? 'London' : (country === 'United States' ? 'New York' : 'Destination City')),
        state: state || existing.state || (isUK ? 'England' : (country === 'United States' ? 'New York' : 'Destination State')),
        country: country || existing.country || 'United States',
        countryCode: countryCode || existing.countryCode || 'US',
        pincode: pincode || existing.pincode || defaultPin,
        hasAddressInfo,
        hasExplicitCountry: Boolean(country)
    };
};

/**
 * Helper: Parse Dimensions & Package Details from User Input
 */
const parsePackageInput = (text, consigneeCountry = 'United States') => {
    const lower = text.toLowerCase();

    // 1. Extract Dimensions e.g. 20x20x15 cm or 20*20*15
    let length = 10, width = 10, height = 10;
    let dimsFound = false;
    const dimMatch = text.match(/(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)/i) ||
                     text.match(/(\d+(\.\d+)?)\s*\*\s*(\d+(\.\d+)?)\s*\*\s*(\d+(\.\d+)?)/i);

    let textWithoutDims = text;
    if (dimMatch) {
        length = parseFloat(dimMatch[1]) || 10;
        width = parseFloat(dimMatch[3]) || 10;
        height = parseFloat(dimMatch[5]) || 10;
        dimsFound = true;
        textWithoutDims = text.replace(dimMatch[0], '');
    }

    // 2. Extract Weight: MUST look for explicit "kg", "kgs", "kilo", "kilos", or "wt: X"
    let weight = 0;
    let weightFound = false;
    const explicitWeightMatch = textWithoutDims.match(/(\d+(\.\d+)?)\s*(kg|kgs|kilo|kilos)\b/i) ||
                                textWithoutDims.match(/weight\s*[:=]?\s*(\d+(\.\d+)?)/i);

    if (explicitWeightMatch) {
        const parsedWeight = parseFloat(explicitWeightMatch[1]);
        if (parsedWeight > 0 && parsedWeight <= 500) {
            weight = parsedWeight;
            weightFound = true;
        }
    } else if (dimsFound) {
        // If dimensions were explicitly provided, a small standalone number may be weight (e.g. "20x20x15, 2.5")
        const smallNumMatch = textWithoutDims.match(/\b(\d{1,2}(\.\d+)?)\b/);
        if (smallNumMatch) {
            const parsed = parseFloat(smallNumMatch[1]);
            if (parsed > 0 && parsed <= 50) {
                weight = parsed;
                weightFound = true;
            }
        }
    }

    // Default weight only if dims are given, else keep default 1.5kg
    if (!weightFound) {
        weight = 1.5;
    }

    // Volumetric Weight: (L x W x H) / 5000
    const volWeight = Number(((length * width * height) / 5000).toFixed(2));
    const chargeableWeight = Math.max(weight, volWeight);

    // 3. HS Code (Must explicitly have "hs" / "hsn", or 4-8 digits that are NOT a 5-digit US zip)
    const hsMatch = text.match(/hs\s*code\s*[:=]?\s*(\d{4,8})/i) || text.match(/hsn\s*[:=]?\s*(\d{4,8})/i);
    const hsCode = hsMatch ? hsMatch[1] : '6205';

    // 4. Product description
    let itemDesc = 'Garments / Personal Items';
    if (lower.includes('shirt') || lower.includes('cloth') || lower.includes('garment') || lower.includes('apparel')) itemDesc = 'Cotton Apparel / Garments';
    else if (lower.includes('spice') || lower.includes('food') || lower.includes('tea')) itemDesc = 'Food Spices / Packaged Items';
    else if (lower.includes('document') || lower.includes('paper')) itemDesc = 'Personal Documents';
    else if (lower.includes('handicraft') || lower.includes('gift')) itemDesc = 'Handicrafts & Gifts';

    return {
        length,
        width,
        height,
        weight,
        volWeight,
        chargeableWeight,
        itemDesc,
        hsCode,
        consigneeCountry,
        weightFound,
        dimsFound
    };
};

/**
 * Helper: Calculate Live Rates for a Booking Draft
 */
const calculateRatesForDraft = async (pkg, consigneeOrCountry, userId) => {
    let rateOptions = [];
    let destCountry = 'United States';
    let destCountryCode = 'US';
    let destPincode = '10001';
    let destCity = '';
    let destState = '';

    try {
        const { getRates } = require('../../controllers/ratesController');

        if (consigneeOrCountry && typeof consigneeOrCountry === 'object') {
            destCountry = consigneeOrCountry.country || destCountry;
            destCountryCode = consigneeOrCountry.countryCode || destCountryCode;
            destPincode = consigneeOrCountry.pincode || consigneeOrCountry.zip || destPincode;
            destCity = consigneeOrCountry.city || '';
            destState = consigneeOrCountry.state || '';
        } else if (typeof consigneeOrCountry === 'string') {
            destCountry = consigneeOrCountry;
        }

        const lowerCountry = destCountry.toLowerCase();
        if (lowerCountry.includes('uk') || lowerCountry.includes('united kingdom') || destCountryCode === 'GB') {
            destCountry = 'United Kingdom';
            destCountryCode = 'GB';
            if (!destPincode || destPincode === '10001') destPincode = 'RG25 2AR';
        } else if (lowerCountry.includes('canada') || destCountryCode === 'CA') {
            destCountry = 'Canada';
            destCountryCode = 'CA';
        } else if (lowerCountry.includes('uae') || lowerCountry.includes('emirates') || destCountryCode === 'AE') {
            destCountry = 'UAE';
            destCountryCode = 'AE';
        } else if (lowerCountry.includes('australia') || destCountryCode === 'AU') {
            destCountry = 'Australia';
            destCountryCode = 'AU';
        } else if (lowerCountry.includes('germany') || destCountryCode === 'DE') {
            destCountry = 'Germany';
            destCountryCode = 'DE';
        } else if (lowerCountry.includes('india') || destCountryCode === 'IN') {
            destCountry = 'India';
            destCountryCode = 'IN';
        }

        const req = {
            body: {
                weight: pkg.chargeableWeight || pkg.weight || 1,
                destination: {
                    country: destCountry,
                    countryCode: destCountryCode,
                    pincode: destPincode,
                    zip: destPincode,
                    postalCode: destPincode,
                    city: destCity,
                    state: destState
                },
                package: {
                    box: [{
                        weight: pkg.weight || pkg.chargeableWeight || 1,
                        length: pkg.length || 10,
                        width: pkg.width || 10,
                        height: pkg.height || 10
                    }]
                },
                shipmentType: 'Parcel',
                userId: userId
            }
        };

        let rawCharges = [];
        const res = {
            status: (code) => ({
                json: (data) => {
                    console.error('[ChatbotRateCalc] getRates status error:', code, data);
                }
            }),
            json: (data) => {
                if (data && data.data && Array.isArray(data.data.charges)) {
                    rawCharges = data.data.charges;
                } else if (Array.isArray(data)) {
                    rawCharges = data;
                }
            }
        };

        await getRates(req, res);

        if (Array.isArray(rawCharges) && rawCharges.length > 0) {
            rateOptions = rawCharges.slice(0, 3).map((rc, idx) => {
                const numCost = Number(rc.totalPricing || rc.totalPrice || rc.rate || rc.totalAmount || 0);
                const costVal = Number(numCost.toFixed(2));
                const rawTransit = rc.transitTime || rc.deliveryDays || '4 - 7';
                const transitClean = String(rawTransit).replace(/business\s*days/gi, '').trim();
                return {
                    id: `OPT_${idx + 1}`,
                    serviceName: rc.serviceName || rc.displayName || `DFL Express Service ${idx + 1}`,
                    transitDays: transitClean ? `${transitClean} Business Days` : '4 - 7 Business Days',
                    cost: costVal,
                    formattedCost: `₹${costVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} INR`
                };
            });
        }
    } catch (err) {
        console.error('[ChatbotRateCalc] Error computing real rates via getRates:', err.message);
    }

    if (rateOptions.length === 0) {
        const isUK = destCountry.toLowerCase().includes('uk') || destCountry.toLowerCase().includes('united kingdom') || destCountryCode === 'GB';
        const isUS = destCountry.toLowerCase().includes('states') || destCountry.toLowerCase().includes('usa') || destCountryCode === 'US';
        const baseCost = isUK ? 1389.45 : Number((pkg.chargeableWeight * (isUS ? 1713.36 : 1850)).toFixed(2));
        const defaultServiceName = isUK ? 'DFL EXPRESS Priority' : 'DFL EXPRESS - USPS';
        const defaultTransit = isUK ? '3-5 Business Days' : '7 - 10 Business Days';

        rateOptions = [
            {
                id: 'OPT_1',
                serviceName: defaultServiceName,
                transitDays: defaultTransit,
                cost: baseCost,
                formattedCost: `₹${baseCost.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} INR`
            }
        ];
    }
    return rateOptions;
};

/**
 * Helper: Process Conversational Booking Machine Steps
 */
const handleBookingStepMachine = async (session, userId, trimmedMsg, lowerMsg) => {
    if (!session.bookingState) {
        session.bookingState = { step: 'IDLE', draftData: {} };
    }

    const state = session.bookingState;

    // GLOBAL INTERCEPTORS (Active Booking in progress)
    if (state.step !== 'IDLE') {
        // 1. CANCEL / RESET INTENT
        const isCancelIntent = /\b(canc[ea]l|abort|stop|reset|restart|start over)\b/i.test(lowerMsg) ||
            ['band karo', 'nahi karni', 'nahi karna', 'hata do', 'hatao', 'chhod do', 'chhor do', 'cancel booking', 'booking cancel', 'cancel shipment', 'cancle shipment'].some(w => lowerMsg.includes(w));
        if (isCancelIntent) {
            state.step = 'IDLE';
            state.draftData = {};
            session.markModified('bookingState');
            await session.save();

            return {
                handled: true,
                botResponse: `❌ **Shipment Booking Cancelled.**\n\nYour active draft has been cleared. Whenever you'd like to book a shipment, just say \`Book shipment\`!`,
                actionPayload: { type: 'booking_cancelled' }
            };
        }

        // 2. CHANGE / EDIT CONSIGNEE ADDRESS INTENT
        const isAddressChange = (
            (lowerMsg.includes('address') || lowerMsg.includes('consignee') || lowerMsg.includes('receiver')) &&
            (lowerMsg.includes('change') || lowerMsg.includes('badal') || lowerMsg.includes('update') || lowerMsg.includes('edit') || lowerMsg.includes('galat') || lowerMsg.includes('wrong') || lowerMsg.includes('naya') || lowerMsg.includes('new'))
        ) || lowerMsg.includes('change consignee') || lowerMsg.includes('consignee change') || lowerMsg.includes('receiver change') || lowerMsg.includes('change receiver');

        if (isAddressChange) {
            const newAddressText = trimmedMsg
                .replace(/^.*?(change|update|edit|badal|set|to)\s*(address|consignee|receiver)?\s*(to|is|hai|kardo|krke|krdo)?\s*[:=]?\s*/i, '')
                .trim();

            const looksLikeAddress = newAddressText.length > 3 && (
                /\b\d{5,6}\b/.test(newAddressText) ||
                /\b[A-Za-z]{1,2}\d/i.test(newAddressText) ||
                /(usa|us|uk|canada|uae|australia|germany|street|road|st|lane|city|sector|pin|zip|postcode)/i.test(newAddressText)
            );

            if (looksLikeAddress) {
                const updatedConsignee = await parseConsigneeInput(newAddressText, state.draftData.consignee || {});
                state.draftData.consignee = updatedConsignee;
                session.markModified('bookingState');
                await session.save();

                // Recalculate rates if package is already provided
                if (state.draftData.package && state.draftData.package.weight) {
                    const newRateOptions = await calculateRatesForDraft(state.draftData.package, updatedConsignee, userId);
                    state.draftData.rateOptions = newRateOptions;
                    state.step = 'AWAITING_SERVICE_SELECTION';
                    session.markModified('bookingState');
                    await session.save();

                    const optionsText = newRateOptions.map((opt, idx) => `${idx + 1}️⃣ **${opt.serviceName}**\n   - Rate: **${opt.formattedCost}**\n   - Delivery: ${opt.transitDays}`).join('\n\n');

                    return {
                        handled: true,
                        botResponse: `📍 **Consignee Address Updated!**\n\n` +
                            `- **Receiver:** ${updatedConsignee.consigneeName}\n` +
                            `- **New Destination:** ${updatedConsignee.city ? updatedConsignee.city + ', ' : ''}${updatedConsignee.country} (Zip: ${updatedConsignee.pincode})\n` +
                            `- **Address:** ${updatedConsignee.addressLine1}\n\n` +
                            `💰 **Updated Live Rates for ${updatedConsignee.country}:**\n\n` +
                            `${optionsText}\n\n` +
                            `*Reply \`1\` or \`2\` to confirm your shipment booking!*`,
                        actionPayload: { type: 'select_service_options', options: newRateOptions, draft: state.draftData }
                    };
                }

                return {
                    handled: true,
                    botResponse: `📍 **Consignee Address Updated!**\n\n` +
                        `- **Receiver:** ${updatedConsignee.consigneeName}\n` +
                        `- **New Destination:** ${updatedConsignee.city ? updatedConsignee.city + ', ' : ''}${updatedConsignee.country} (Zip: ${updatedConsignee.pincode})\n` +
                        `- **Address:** ${updatedConsignee.addressLine1}\n\n` +
                        `Please reply with your parcel details to continue booking:\n` +
                        `• **Weight:** in kg (e.g. \`2.5 kg\`)\n` +
                        `• **Dimensions:** Length x Width x Height in cm (e.g. \`20x20x15 cm\`)`,
                    actionPayload: { type: 'booking_step', step: 'AWAITING_PACKAGE', draft: state.draftData }
                };
            } else {
                // User just stated their intent to change address
                state.step = 'AWAITING_CONSIGNEE';
                session.markModified('bookingState');
                await session.save();

                return {
                    handled: true,
                    botResponse: `📍 **Sure! Let's update the Receiver's Address.**\n\n` +
                        `Please reply with the new **Delivery Address**, **Pincode / Zip**, and **Destination Country** (e.g. USA, UK, Canada, UAE):`,
                    actionPayload: { type: 'booking_step', step: 'AWAITING_CONSIGNEE', draft: state.draftData }
                };
            }
        }

        // 3. CHANGE / EDIT WEIGHT OR DIMENSIONS INTENT
        const isPackageChange = (lowerMsg.includes('weight') || lowerMsg.includes('dimension') || lowerMsg.includes('box')) &&
            (lowerMsg.includes('change') || lowerMsg.includes('badal') || lowerMsg.includes('update') || lowerMsg.includes('edit') || lowerMsg.includes('galat') || lowerMsg.includes('wrong'));

        if (isPackageChange) {
            const hasNewWeight = trimmedMsg.match(/(\d+(\.\d+)?)\s*(kg|kilos|kilo)/i);
            if (hasNewWeight) {
                const pkg = parsePackageInput(trimmedMsg, state.draftData.consignee?.country || 'United States');
                state.draftData.package = pkg;
                const newRateOptions = await calculateRatesForDraft(pkg, state.draftData.consignee, userId);
                state.draftData.rateOptions = newRateOptions;
                state.step = 'AWAITING_SERVICE_SELECTION';
                session.markModified('bookingState');
                await session.save();

                const optionsText = newRateOptions.map((opt, idx) => `${idx + 1}️⃣ **${opt.serviceName}**\n   - Rate: **${opt.formattedCost}**\n   - Delivery: ${opt.transitDays}`).join('\n\n');

                return {
                    handled: true,
                    botResponse: `📦 **Package Specifications Updated!**\n\n` +
                        `- **New Weight:** ${pkg.weight} kg (Chargeable: ${pkg.chargeableWeight} kg)\n` +
                        `- **Dimensions:** ${pkg.length}x${pkg.width}x${pkg.height} cm\n\n` +
                        `💰 **Recalculated Rate Options:**\n\n` +
                        `${optionsText}\n\n` +
                        `*Reply \`1\` or \`2\` to confirm your shipment booking!*`,
                    actionPayload: { type: 'select_service_options', options: newRateOptions, draft: state.draftData }
                };
            } else {
                state.step = 'AWAITING_PACKAGE';
                session.markModified('bookingState');
                await session.save();

                return {
                    handled: true,
                    botResponse: `📦 **Sure! Let's update your parcel specifications.**\n\n` +
                        `Please reply with your new **Weight in kg** (e.g. \`3 kg\`) and **Box Dimensions in cm** (e.g. \`20x20x15 cm\`):`,
                    actionPayload: { type: 'booking_step', step: 'AWAITING_PACKAGE', draft: state.draftData }
                };
            }
        }
    }

    // STEP 0: Trigger Intent Check (if IDLE)
    const isBookingIntent = (lowerMsg.includes('book') && (lowerMsg.includes('shipment') || lowerMsg.includes('courier') || lowerMsg.includes('parcel') || lowerMsg.includes('pickup'))) ||
        lowerMsg.includes('shipment book') ||
        lowerMsg.includes('ship parcel') ||
        lowerMsg.includes('booking karni') ||
        lowerMsg.includes('booking krni') ||
        lowerMsg.includes('shipment book krni');

    if (state.step === 'IDLE' && isBookingIntent) {
        const fullUser = await User.findById(userId);
        if (!fullUser) {
            return {
                handled: true,
                botResponse: '⚠️ User account could not be found. Please log in to book a shipment.',
                actionPayload: { type: 'booking_error', reason: 'USER_NOT_FOUND' }
            };
        }

        if (fullUser.isRestricted) {
            return {
                handled: true,
                botResponse: '⚠️ Your account is currently restricted from creating new bookings. Please contact DFL Support for assistance.',
                actionPayload: { type: 'booking_error', reason: 'ACCOUNT_RESTRICTED' }
            };
        }

        const shipper = {
            shipperName: fullUser.name || 'Shipper',
            companyName: fullUser.companyName || 'Personal',
            mobileNo: fullUser.phone || '+91 9876543210',
            email: fullUser.email || 'shipper@example.com',
            addressLine1: fullUser.address?.street || fullUser.address?.addressLine1 || 'Pickup Location',
            city: fullUser.address?.city || 'Noida',
            state: fullUser.address?.state || 'UP',
            country: fullUser.address?.country || 'India',
            countryCode: fullUser.address?.countryCode || 'IN',
            pincode: fullUser.address?.pincode || '201305'
        };

        state.step = 'AWAITING_CONSIGNEE';
        state.draftData = { shipper, consignee: {} };
        session.markModified('bookingState');
        await session.save();

        return {
            handled: true,
            botResponse: `👋 **Let's book your shipment right here in this chat!** 📦\n\n` +
                `Your profile details have been auto-loaded as the **Shipper (Sender)**:\n` +
                `- **Sender Name:** ${shipper.shipperName}\n` +
                `- **Contact Mobile:** ${shipper.mobileNo}\n` +
                `- **Pickup City:** ${shipper.city}, ${shipper.country}\n\n` +
                `📍 **Step 1: Consignee (Receiver) Details**\n` +
                `Please reply in chat with the **Receiver's Info**:\n` +
                `1. Receiver Name & Mobile Number\n` +
                `2. Complete Delivery Address & Pincode / Zip\n` +
                `3. Destination Country (e.g. USA, UK, Canada, UAE, Germany)`,
            actionPayload: { type: 'booking_step', step: 'AWAITING_CONSIGNEE', draft: state.draftData }
        };
    }

    // STEP 1: Awaiting Consignee Details Input
    if (state.step === 'AWAITING_CONSIGNEE') {
        const consignee = await parseConsigneeInput(trimmedMsg, state.draftData.consignee || {});
        state.draftData.consignee = consignee;

        // If user only provided a name without address or country, ask for the rest!
        if (!consignee.hasAddressInfo) {
            session.markModified('bookingState');
            await session.save();

            return {
                handled: true,
                botResponse: `📌 **Receiver Name Saved:** **${consignee.consigneeName}**\n\n` +
                    `Now please reply with the remaining delivery details:\n` +
                    `• **Delivery Address & Zip/Pincode** (e.g. \`120 Main St, 95901\`)\n` +
                    `• **Destination Country** (e.g. \`USA\`, \`UK\`, \`Canada\`, \`UAE\`)\n` +
                    `• **Contact Mobile Number**`,
                actionPayload: { type: 'booking_step', step: 'AWAITING_CONSIGNEE', draft: state.draftData }
            };
        }

        // If package details were already entered earlier, directly update rates
        if (state.draftData.package && state.draftData.package.weight) {
            const newRateOptions = await calculateRatesForDraft(state.draftData.package, consignee, userId);
            state.draftData.rateOptions = newRateOptions;
            state.step = 'AWAITING_SERVICE_SELECTION';
            session.markModified('bookingState');
            await session.save();

            const optionsText = newRateOptions.map((opt, idx) => `${idx + 1}️⃣ **${opt.serviceName}**\n   - Rate: **${opt.formattedCost}**\n   - Delivery: ${opt.transitDays}`).join('\n\n');

            return {
                handled: true,
                botResponse: `📍 **Consignee Details Updated!**\n\n` +
                    `- **Receiver:** ${consignee.consigneeName}\n` +
                    `- **Destination:** ${consignee.city ? consignee.city + ', ' : ''}${consignee.country} (Zip: ${consignee.pincode})\n` +
                    `- **Address:** ${consignee.addressLine1}\n\n` +
                    `📦 **Existing Parcel:** ${state.draftData.package.weight} kg (${state.draftData.package.length}x${state.draftData.package.width}x${state.draftData.package.height} cm)\n\n` +
                    `💰 **Updated Live Rates for ${consignee.country}:**\n\n` +
                    `${optionsText}\n\n` +
                    `*Reply \`1\` or \`2\` to confirm your shipment booking!*`,
                actionPayload: { type: 'select_service_options', options: newRateOptions, draft: state.draftData }
            };
        }

        state.step = 'AWAITING_PACKAGE';
        session.markModified('bookingState');
        await session.save();

        return {
            handled: true,
            botResponse: `📌 **Consignee Details Recorded!**\n\n` +
                `- **Receiver:** ${consignee.consigneeName}\n` +
                `- **Phone:** ${consignee.mobileNo}\n` +
                `- **Destination:** ${consignee.city ? consignee.city + ', ' : ''}${consignee.country} (Zip: ${consignee.pincode})\n` +
                `- **Address:** ${consignee.addressLine1}\n\n` +
                `📦 **Step 2: Box & Item Details**\n` +
                `Please reply with your parcel specifications:\n` +
                `• **Weight:** in kg (e.g. \`2.5 kg\`)\n` +
                `• **Dimensions:** Length x Width x Height in cm (e.g. \`20x20x15 cm\`)\n` +
                `• **Item Description:** (e.g. \`Cotton Shirts\`, \`Books\`)`,
            actionPayload: { type: 'booking_step', step: 'AWAITING_PACKAGE', draft: state.draftData }
        };
    }

    // STEP 2: Awaiting Package Details Input
    if (state.step === 'AWAITING_PACKAGE') {
        // Special case: User is sending address/pincode details in this step (e.g. "RG25 2AR pin code" or "address 95901 us masvillia")
        const isAddressMessage = (
            lowerMsg.includes('address') ||
            lowerMsg.includes('zip') ||
            lowerMsg.includes('pincode') ||
            lowerMsg.includes('pin code') ||
            lowerMsg.includes('postcode') ||
            lowerMsg.includes('post code') ||
            lowerMsg.includes('street') ||
            lowerMsg.includes('road') ||
            /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/i.test(trimmedMsg) ||
            /\b[A-Za-z]{1,2}\d{1,2}[A-Za-z]?\s*(pin|pincode|postcode|zip)\b/i.test(trimmedMsg)
        ) && !lowerMsg.includes('kg') && !lowerMsg.includes('kilo') && !trimmedMsg.match(/\d+\s*[x*]\s*\d+/i);

        if (isAddressMessage) {
            const updatedConsignee = await parseConsigneeInput(trimmedMsg, state.draftData.consignee || {});
            state.draftData.consignee = updatedConsignee;
            session.markModified('bookingState');
            await session.save();

            return {
                handled: true,
                botResponse: `📍 **Delivery Address Updated!**\n\n` +
                    `- **Receiver:** ${updatedConsignee.consigneeName}\n` +
                    `- **Address:** ${updatedConsignee.addressLine1}\n` +
                    `- **Destination:** ${updatedConsignee.city ? updatedConsignee.city + ', ' : ''}${updatedConsignee.country} (Zip: ${updatedConsignee.pincode})\n\n` +
                    `📦 **Now, please reply with your Box & Item Specs:**\n` +
                    `• **Weight in kg:** (e.g. \`2.5 kg\` or \`5 kg\`)\n` +
                    `• **Dimensions:** (e.g. \`20x20x15 cm\`)\n` +
                    `• **Item Description:** (e.g. \`Garments\`)`,
                actionPayload: { type: 'booking_step', step: 'AWAITING_PACKAGE', draft: state.draftData }
            };
        }

        const consigneeCountry = state.draftData.consignee?.country || 'United States';
        const pkg = parsePackageInput(trimmedMsg, consigneeCountry);

        // Sanity Check: If user provided neither weight nor dimensions, ask clearly
        if (!pkg.weightFound && !pkg.dimsFound) {
            return {
                handled: true,
                botResponse: `📦 **Please provide your parcel specifications:**\n\n` +
                    `• **Weight in kg:** (e.g. \`2 kg\` or \`5 kg\`)\n` +
                    `• **Dimensions in cm:** Length x Width x Height (e.g. \`20x20x15 cm\`)\n` +
                    `• **Item Description:** (e.g. \`Garments\`)`,
                actionPayload: { type: 'booking_step', step: 'AWAITING_PACKAGE', draft: state.draftData }
            };
        }

        state.draftData.package = pkg;

        // Compute Live Rates using ratesController or RateCard database
        const rateOptions = await calculateRatesForDraft(pkg, state.draftData.consignee, userId);

        state.draftData.rateOptions = rateOptions;
        state.step = 'AWAITING_SERVICE_SELECTION';
        session.markModified('bookingState');
        await session.save();

        let optionsFormattedText = rateOptions.map((opt, idx) => 
            `${idx + 1}️⃣ **${opt.serviceName}**\n   - Rate: **${opt.formattedCost}**\n   - Delivery: ${opt.transitDays}`
        ).join('\n\n');

        return {
            handled: true,
            botResponse: `✅ **Package Specifications Saved!**\n\n` +
                `- **Chargeable Weight:** ${pkg.chargeableWeight} kg (Volumetric: ${pkg.volWeight} kg)\n` +
                `- **Item:** ${pkg.itemDesc} (HS Code: ${pkg.hsCode})\n\n` +
                `💰 **Step 3: Live Rate Options for Your Shipment**\n\n` +
                `${optionsFormattedText}\n\n` +
                `*Reply \`1\` or \`2\` (or click option button below) to confirm your shipment booking!*`,
            actionPayload: { type: 'select_service_options', options: rateOptions, draft: state.draftData }
        };
    }

    // STEP 3: Awaiting Service Selection & Final Booking Creation with Wallet Balance Check
    if (state.step === 'AWAITING_SERVICE_SELECTION') {
        const Shipment = require('../../models/Shipment');
        const Transaction = require('../../models/Transaction');

        // Auto-heal corrupt weight from old drafts (> 500 kg)
        if (state.draftData.package && Number(state.draftData.package.weight) > 500) {
            state.draftData.package.weight = 1.5;
            state.draftData.package.chargeableWeight = 1.5;
            state.draftData.rateOptions = await calculateRatesForDraft(state.draftData.package, state.draftData.consignee, userId);
            session.markModified('bookingState');
            await session.save();
        }

        let rateOptions = state.draftData.rateOptions || [];

        // Determine if user message is an explicit selection or confirmation
        const isOpt2 = trimmedMsg === '2' || /\b(option 2|opt 2|opt_2|standard|dusra|second)\b/i.test(lowerMsg);
        const isOpt3 = trimmedMsg === '3' || /\b(option 3|opt 3|opt_3|third)\b/i.test(lowerMsg);
        const isOpt1 = trimmedMsg === '1' || /\b(option 1|opt 1|opt_1|usps|first|pehla)\b/i.test(lowerMsg);
        const isGenericConfirm = /^(confirm|yes|proceed|book|book it|finalize|done|ha|haan|ok|okay|kardo|krdo)\b/i.test(trimmedMsg) ||
            lowerMsg.includes('book karo') || lowerMsg.includes('book krdo') || lowerMsg.includes('confirm booking');

        const isSelection = isOpt1 || isOpt2 || isOpt3 || isGenericConfirm;

        if (!isSelection) {
            // User sent casual message or greeting (e.g. "hy", "hello")
            const draft = state.draftData;
            const optionsText = rateOptions.map((opt, idx) => `${idx + 1}️⃣ **${opt.serviceName}** - **${opt.formattedCost}** (${opt.transitDays})`).join('\n');

            return {
                handled: true,
                botResponse: `📦 **Your Shipment Draft is Ready:**\n\n` +
                    `- **Receiver:** ${draft.consignee?.consigneeName || 'Consignee'} (${draft.consignee?.country || 'Destination'})\n` +
                    `- **Package:** ${draft.package?.weight || 1.5} kg (${draft.package?.length}x${draft.package?.width}x${draft.package?.height} cm)\n\n` +
                    `💰 **Service Rate Options:**\n${optionsText}\n\n` +
                    `👉 Reply **\`1\`** or **\`2\`** to confirm booking.\n` +
                    `• To change address: reply \`change address\`\n` +
                    `• To change weight: reply \`change weight to 2kg\`\n` +
                    `• To cancel: reply \`cancel booking\``,
                actionPayload: { type: 'select_service_options', options: rateOptions, draft: state.draftData }
            };
        }

        if (!Array.isArray(rateOptions) || rateOptions.length === 0) {
            rateOptions = await calculateRatesForDraft(state.draftData?.package || { chargeableWeight: 1.5, weight: 1.5 }, state.draftData?.consignee || {}, userId);
            state.draftData.rateOptions = rateOptions;
        }

        let selectedOption = rateOptions[0] || {
            serviceName: 'DFL EXPRESS Priority',
            cost: 1389.45,
            formattedCost: '₹1,389.45 INR',
            transitDays: '3-5 Business Days'
        };
        if (isOpt2 && rateOptions[1]) {
            selectedOption = rateOptions[1];
        } else if (isOpt3 && rateOptions[2]) {
            selectedOption = rateOptions[2];
        }

        const amountToDeduct = Number(selectedOption.cost || 0);

        // Verify user & wallet balance
        const user = await User.findById(userId);
        if (!user) {
            return {
                handled: true,
                botResponse: '⚠️ User account could not be found. Please log in again.',
                actionPayload: { type: 'booking_error', reason: 'USER_NOT_FOUND' }
            };
        }

        const currentBalance = Number(user.walletBalance || 0);
        if (currentBalance < amountToDeduct) {
            const shortfall = Math.round(amountToDeduct - currentBalance);
            return {
                handled: true,
                botResponse: `⚠️ **Insufficient Wallet Balance**\n\n` +
                    `• **Selected Service:** ${selectedOption.serviceName}\n` +
                    `• **Required Amount:** ${selectedOption.formattedCost || `₹${amountToDeduct}`}\n` +
                    `• **Current Wallet Balance:** ₹${currentBalance.toLocaleString('en-IN')}\n` +
                    `• **Shortfall:** ₹${shortfall.toLocaleString('en-IN')}\n\n` +
                    `Please recharge at least **₹${shortfall.toLocaleString('en-IN')}** under **Billing > Wallet**.\n\n` +
                    `*Once your wallet is topped up, reply with \`1\` or \`confirm\` to finalize your shipment booking without re-entering details!*`,
                actionPayload: {
                    type: 'insufficient_wallet_balance',
                    required: amountToDeduct,
                    available: currentBalance,
                    shortfall,
                    draft: state.draftData
                }
            };
        }

        // Atomic Wallet Deduction
        const updatedUser = await User.findOneAndUpdate(
            { _id: userId, walletBalance: { $gte: amountToDeduct } },
            { $inc: { walletBalance: -amountToDeduct } },
            { new: true }
        );

        if (!updatedUser) {
            return {
                handled: true,
                botResponse: `⚠️ Wallet balance could not be deducted. Required: ₹${amountToDeduct.toLocaleString('en-IN')}. Please verify your balance and try again.`,
                actionPayload: { type: 'insufficient_wallet_balance', required: amountToDeduct }
            };
        }

        const draft = state.draftData;
        const autoShipmentId = `DFL${Math.floor(10000000 + Math.random() * 90000000)}`;

        // Log Transaction Record
        try {
            await Transaction.create({
                user: userId,
                walletOwnerId: userId,
                walletOwnerType: 'User',
                amount: -amountToDeduct,
                type: 'debit',
                description: `Shipment Booking: ${autoShipmentId} (via AI Chatbot)`,
                referenceId: autoShipmentId,
                status: 'success',
                balanceAfter: updatedUser.walletBalance
            });
        } catch (txnErr) {
            console.error('[ChatbotBooking] Failed to log transaction record:', txnErr.message);
        }

        // Create Shipment in Database matching the real schema
        const newShipment = await Shipment.create({
            user: userId,
            partnerId: user.partnerId || null,
            bookedByType: 'User',
            bookedById: userId,
            billingOwnerType: 'User',
            billingOwnerId: userId,
            bookingSource: 'CUSTOMER_DASHBOARD',
            shipmentId: autoShipmentId,
            status: 'Pending',
            paymentMode: 'Wallet',
            shipperDetails: {
                shipperName: draft.shipper?.shipperName || user.name || 'Shipper',
                companyName: draft.shipper?.companyName || user.companyName || 'Personal',
                mobileNo: draft.shipper?.mobileNo || user.phone || '+91 9876543210',
                email: draft.shipper?.email || user.email || 'shipper@example.com',
                addressLine1: draft.shipper?.addressLine1 || user.address?.street || 'Pickup Location',
                city: draft.shipper?.city || user.address?.city || 'Noida',
                state: draft.shipper?.state || user.address?.state || 'UP',
                country: draft.shipper?.country || user.address?.country || 'India',
                countryCode: draft.shipper?.countryCode || user.address?.countryCode || 'IN',
                pincode: draft.shipper?.pincode || user.address?.pincode || '201305'
            },
            consigneeDetails: {
                consigneeName: draft.consignee?.consigneeName || 'Consignee Receiver',
                companyName: draft.consignee?.companyName || 'Personal Receiver',
                mobileNo: draft.consignee?.mobileNo || '+1 555-0199',
                email: draft.consignee?.email || 'consignee@example.com',
                addressLine1: draft.consignee?.addressLine1 || 'Delivery Address',
                city: draft.consignee?.city || (draft.consignee?.country === 'United States' ? 'New York' : 'Destination City'),
                state: draft.consignee?.state || (draft.consignee?.country === 'United States' ? 'New York' : 'Destination State'),
                country: draft.consignee?.country || 'United States',
                countryCode: draft.consignee?.countryCode || 'US',
                pincode: draft.consignee?.pincode || (draft.consignee?.countryCode === 'GB' ? 'RG25 2AR' : (draft.consignee?.countryCode === 'IN' ? '110001' : '10001'))
            },
            shipmentDetails: {
                shipmentType: 'Parcel',
                shipmentCategory: 'personal',
                invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
                invoiceDate: new Date(),
                currency: draft.consignee?.country?.toLowerCase()?.includes('india') ? 'INR' : 'USD',
                boxes: [{
                    length: String(draft.package.length),
                    width: String(draft.package.width),
                    height: String(draft.package.height),
                    weight: String(draft.package.weight),
                    items: [{
                        productName: draft.package.itemDesc,
                        hsnCode: draft.package.hsCode,
                        quantity: '1',
                        unitPrice: '1000'
                    }]
                }]
            },
            serviceDetails: {
                carrierName: 'DFL Express',
                serviceName: selectedOption.serviceName,
                price: selectedOption.formattedCost || `₹${amountToDeduct}`,
                cost: amountToDeduct,
                chargeableWeight: String(draft.package.chargeableWeight),
                eta: selectedOption.transitDays || '4 - 7 Business Days'
            },
            trackingHistory: [{
                status: 'Pending',
                location: draft.shipper.city || 'Origin Hub',
                description: 'Shipment booked via DFL AI Assistant',
                timestamp: new Date()
            }]
        });

        // Reset booking state
        state.step = 'IDLE';
        state.draftData = {};
        session.markModified('bookingState');
        await session.save();

        return {
            handled: true,
            botResponse: `🎉 **Shipment Booking Successfully Created!**\n\n` +
                `🔖 **Booking Reference / DFL ID:** **#${newShipment.shipmentId}**\n` +
                `✈️ **Service:** ${selectedOption.serviceName}\n` +
                `💰 **Amount Paid:** **${selectedOption.formattedCost}** (Deducted from Wallet)\n` +
                `💳 **Remaining Wallet Balance:** **₹${Number(updatedUser.walletBalance).toLocaleString('en-IN')}**\n` +
                `👤 **Consignee:** ${draft.consignee.consigneeName} (${draft.consignee.country})\n` +
                `📦 **Package Weight:** ${draft.package.chargeableWeight} kg\n\n` +
                `Your shipment has been registered under your account! You can track and manage it under **My Bookings**.`,
            actionPayload: {
                type: 'booking_created',
                data: {
                    shipmentId: newShipment.shipmentId,
                    status: newShipment.status,
                    walletBalance: updatedUser.walletBalance
                }
            }
        };
    }

    return { handled: false };
};

/**
 * Core Orchestrator: Process Chat Message with OpenAI & Fallback Rules
 */
const processChatMessage = async (userId, messageText, sessionId = null) => {
    const startTime = Date.now();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
        throw new Error('Valid user message is required.');
    }

    const trimmedMsg = messageText.trim();
    const lowerMsg = trimmedMsg.toLowerCase();

    // 1. Prompt Injection & Security Guard Inspection
    const securityResult = inspectPromptSecurity(trimmedMsg);
    if (securityResult.isThreat) {
        logChatbotEvent({
            requestId,
            userId,
            intent: 'UNSAFE_REQUEST',
            latency: Date.now() - startTime,
            status: 'ERROR',
            errorCategory: 'PROMPT_INJECTION'
        });
        return {
            success: true,
            message: `Hello! I am bounded to DFL Group logistics assistance. Please ask me about your shipments, tracking, rates, or KYC.`,
            actionPayload: { type: 'blocked_prompt', reason: securityResult.reason }
        };
    }

    // Load or create chat session
    let session = null;
    if (sessionId) {
        session = await ChatSession.findOne({ sessionId, userId });
    }
    if (!session) {
        let activeSessionId = sessionId;
        if (activeSessionId) {
            // Check if this sessionId is already in use by another user
            const existingWithOtherUser = await ChatSession.findOne({ sessionId: activeSessionId });
            if (existingWithOtherUser) {
                // If it belongs to another user or collision occurs, generate a fresh unique sessionId
                activeSessionId = null;
            }
        }
        if (!activeSessionId) {
            activeSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        }
        try {
            session = await ChatSession.create({
                userId,
                sessionId: activeSessionId,
                messages: []
            });
        } catch (createErr) {
            if (createErr.code === 11000) {
                // Handle concurrent or duplicate key edge case gracefully with a new session ID
                session = await ChatSession.create({
                    userId,
                    sessionId: `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                    messages: []
                });
            } else {
                throw createErr;
            }
        }
    }

    // Save sanitized input to session history
    session.messages.push({
        role: 'user',
        content: sanitizePii(trimmedMsg),
        timestamp: new Date()
    });

    let botResponse = '';
    let actionPayload = null;
    let detectedIntent = 'GENERAL_QUERY';
    let contextFacts = null;

    // Evaluate Conversational Booking State Machine
    const bookingResult = await handleBookingStepMachine(session, userId, trimmedMsg, lowerMsg);
    if (bookingResult.handled) {
        botResponse = bookingResult.botResponse;
        actionPayload = bookingResult.actionPayload;

        session.messages.push({
            role: 'assistant',
            content: sanitizeOutput(botResponse),
            timestamp: new Date()
        });
        session.updatedAt = new Date();
        await session.save();

        logChatbotEvent({
            requestId,
            userId,
            intent: 'CONVERSATIONAL_BOOKING',
            latency: Date.now() - startTime,
            status: 'SUCCESS'
        });

        return {
            success: true,
            message: sanitizeOutput(botResponse),
            sessionId: session.sessionId,
            actionPayload
        };
    }

    // 2. Greetings & Persona Check
    const GREETING_KEYWORDS = [
        'hi', 'hii', 'hiii', 'hello', 'helloo', 'hey', 'heyy', 'hy', 'hlo', 'hlw',
        'namaste', 'namaskar', 'greetings', 'good morning', 'good afternoon', 'good evening',
        'kese ho', 'kaise ho', 'kaisa hai', 'kaise ho aap', 'kaise hain', 'kaise h',
        'how are you', 'how r u', 'whats up', 'whatsup', 'sup', 'start', 'help',
        'ola', 'kem cho', 'vanakkam', 'ram ram', 'radhe radhe', 'jai shree ram'
    ];
    const cleanedLower = lowerMsg.trim().replace(/[^\w\s]/gi, '');
    const isGreeting = GREETING_KEYWORDS.includes(cleanedLower) ||
        GREETING_KEYWORDS.some(kw => cleanedLower === kw || (cleanedLower.startsWith(kw) && cleanedLower.length <= kw.length + 8));

    if (isGreeting) {
        detectedIntent = 'GREETING';
        botResponse = `Hello! I'm Shelina, how may I assist you?`;
    }
    // 3. KYC Verification Query
    else if (lowerMsg.includes('kyc') || lowerMsg.includes('document') || lowerMsg.includes('aadhaar') || lowerMsg.includes('pan') || lowerMsg.includes('gst') || lowerMsg.includes('verify') || lowerMsg.includes('verification') || lowerMsg.includes('iec') || lowerMsg.includes('lut')) {
        detectedIntent = 'KYC_STATUS';
        const kycInfo = await getUserKycStatus(userId);
        contextFacts = { kyc: kycInfo };
        let statusBadge = '⚠️ Not Submitted';
        let guidance = 'Please upload your Aadhaar, PAN card, and Signature on the Settings > KYC page to start shipping.';

        if (kycInfo.status === 'Verified') {
            statusBadge = '✅ Fully Verified';
            guidance = 'Your account is verified! You can book commercial & CSBV shipments without restrictions.';
        } else if (kycInfo.status === 'Pending Review') {
            statusBadge = '⏳ Under Verification Review';
            guidance = 'Your KYC documents have been submitted and are currently being reviewed by our DFL compliance team.';
        } else if (kycInfo.status === 'Rejected') {
            statusBadge = '❌ KYC Rejected';
            guidance = `Reason: ${kycInfo.rejectionReason || 'Document mismatch'}. Please re-upload valid documents on the KYC page.`;
        }

        botResponse = `📄 **Your KYC Verification Details**\n\n` +
            `- **Account Type:** ${kycInfo.accountType.toUpperCase()}\n` +
            `- **KYC Status:** **${statusBadge}**\n` +
            `- **Submitted Date:** ${kycInfo.submittedAt}\n\n` +
            guidance;
        actionPayload = { type: 'kyc_status', data: kycInfo };
    }
    // 4. Shipment Count / Summary Query
    else if (lowerMsg.includes('kitni') || lowerMsg.includes('kitne') || lowerMsg.includes('how many') || lowerMsg.includes('total shipment') || lowerMsg.includes('total order') || lowerMsg.includes('shipment count') || lowerMsg.includes('book kri') || lowerMsg.includes('book ki') || lowerMsg.includes('booked')) {
        detectedIntent = 'SHIPMENT_SUMMARY';
        const summary = await getUserShipmentSummaryContext(userId);
        contextFacts = { summary };
        let recentText = '';
        if (summary.recentShipments && summary.recentShipments.length > 0) {
            recentText = '\n\n**Recent Bookings:**\n' + summary.recentShipments.map(s => `• **#${s.shipmentId}** (AWB: ${s.awbNumber || 'Pending'}) -> \`${s.status}\``).join('\n');
        }

        botResponse = `📦 **Your Shipment Summary**\n\n` +
            `- **Total Booked Shipments:** **${summary.totalCount}**\n` +
            `- **Active / In-Transit:** **${summary.inTransitCount}**\n` +
            `- **Successfully Delivered:** **${summary.deliveredCount}**` +
            recentText;
        actionPayload = { type: 'shipment_summary', data: summary };
    }
    // 5. AWB / DFL Shipment Tracking or Recent Shipments List
    else if (lowerMsg.includes('track') || lowerMsg.includes('tracking') || lowerMsg.includes('where is') || lowerMsg.includes('shipment') || lowerMsg.includes('shipments') || lowerMsg.includes('recent') || lowerMsg.includes('order') || lowerMsg.includes('orders') || lowerMsg.includes('package') || trimmedMsg.match(/\b(DFL[A-Z0-9-]+|[0-9]{8,12})\b/i)) {
        detectedIntent = 'TRACK_SHIPMENT';
        const awbMatch = trimmedMsg.match(/\b(DFL[A-Z0-9-]+|[0-9]{8,12})\b/i);
        const searchAwb = awbMatch ? awbMatch[0] : null;

        if (searchAwb) {
            const trackingResult = await getShipmentContext(searchAwb, userId);
            if (trackingResult.success) {
                const d = trackingResult.data;
                contextFacts = { shipment: d };
                botResponse = `📦 **Shipment Tracking Details for #${d.shipmentId}**\n\n` +
                    `- **AWB Number:** ${d.awbNumber}\n` +
                    `- **Current Status:** \`${d.status}\`\n` +
                    `- **Origin:** ${d.origin}\n` +
                    `- **Destination:** ${d.destination}\n` +
                    `- **Consignee:** ${d.consigneeName}\n` +
                    `- **Weight:** ${d.weight}\n` +
                    `- **Booked Date:** ${d.bookingDate}`;
                actionPayload = { type: 'shipment_tracking', data: d };
            } else {
                botResponse = trackingResult.message;
            }
        } else {
            const recent = await getUserRecentShipmentsContext(userId);
            contextFacts = { recentShipments: recent.shipments };
            if (recent.count > 0) {
                let listText = recent.shipments.map(s => `• **#${s.shipmentId}** (AWB: ${s.awbNumber}) -> Status: \`${s.status}\` (From ${s.origin} to ${s.destination})`).join('\n');
                botResponse = `Here are your most recent shipments:\n\n${listText}\n\nType an AWB / DFL ID to view detailed tracking updates!`;
                actionPayload = { type: 'recent_shipments', data: recent.shipments };
            } else {
                botResponse = `You don't have any active shipments booked yet. You can book your first shipment anytime from the Book Shipment page!`;
            }
        }
    }
    // 5c. Transit Time & Delivery Estimate Query
    else if (lowerMsg.includes('transit') || lowerMsg.includes('delivery time') || lowerMsg.includes('kab tak') || lowerMsg.includes('kab milega') || lowerMsg.includes('expected delivery') || lowerMsg.includes('est. delivery') || lowerMsg.includes('kitne din')) {
        detectedIntent = 'TRANSIT_TIME';
        const awbMatch = trimmedMsg.match(/\b(DFL[A-Z0-9-]+|[0-9]{8,12})\b/i);
        const searchAwb = awbMatch ? awbMatch[0] : null;

        let targetShipment = null;
        if (searchAwb) {
            const res = await getShipmentContext(searchAwb, userId);
            if (res.success) targetShipment = res.data;
        } else {
            const recent = await getUserRecentShipmentsContext(userId, 1);
            if (recent.count > 0) targetShipment = recent.shipments[0];
        }

        if (targetShipment) {
            contextFacts = { shipment: targetShipment };
            botResponse = `⏱️ **Transit Time & Estimated Delivery for #${targetShipment.shipmentId} (AWB: ${targetShipment.awbNumber})**\n\n` +
                `- **Estimated Transit Time:** **${targetShipment.transitTime}**\n` +
                `- **Current Status:** \`${targetShipment.status}\`\n` +
                `- **Route:** ${targetShipment.origin} -> ${targetShipment.destination}\n` +
                `- **Booked Date:** ${targetShipment.bookingDate}`;
            actionPayload = { type: 'transit_time', data: targetShipment };
        } else {
            botResponse = `Standard DFL International Express delivery transit time is **4 - 7 Business Days** (Express) or **7 - 10 Business Days** (Economy). Type your AWB number to check your specific shipment's estimated delivery date!`;
        }
    }
    // 5d. Delayed Cargo & Reason Query
    else if (lowerMsg.includes('delay') || lowerMsg.includes('late') || lowerMsg.includes('stuck') || lowerMsg.includes('der kyu') || lowerMsg.includes('der ho') || lowerMsg.includes('customs hold')) {
        detectedIntent = 'CARGO_DELAY';
        const awbMatch = trimmedMsg.match(/\b(DFL[A-Z0-9-]+|[0-9]{8,12})\b/i);
        const searchAwb = awbMatch ? awbMatch[0] : null;

        let targetShipment = null;
        if (searchAwb) {
            const res = await getShipmentContext(searchAwb, userId);
            if (res.success) targetShipment = res.data;
        } else {
            const recent = await getUserRecentShipmentsContext(userId, 1);
            if (recent.count > 0) targetShipment = recent.shipments[0];
        }

        contextFacts = { shipment: targetShipment };
        let shipmentDetailText = targetShipment ? `\n\n📍 **Your Latest Shipment Status (#${targetShipment.shipmentId}):**\n- **Status:** \`${targetShipment.status}\`\n- **Route:** ${targetShipment.origin} -> ${targetShipment.destination}\n- **Est. Transit:** ${targetShipment.transitTime}` : '';

        botResponse = `🚚 **Why International Cargo May Experience Delays:**\n\n` +
            `1. **Customs Inspection & Formalities:** Destination customs authorities (e.g. US CBP, UK HMRC) perform random security or duty verification.\n` +
            `2. **Flight Schedules & Airline Capacity:** International air freight is subject to flight availability and transit hub connections.\n` +
            `3. **Last-Mile Delivery Handover:** Local postal partners (USPS, UniUni, Royal Mail) process local sorting before dispatch.\n` +
            `4. **Weather / Regional Holidays:** Non-operational days at destination hubs.` +
            shipmentDetailText +
            `\n\n*If your tracking has not updated for over 48 hours, reply **"Support"** to raise a priority ticket with our operations team!*`;
        actionPayload = { type: 'cargo_delay', data: targetShipment };
    }
    // 5e. Refund Process Query
    else if (lowerMsg.includes('refund') || lowerMsg.includes('paise wapas') || lowerMsg.includes('cancel refund') || lowerMsg.includes('failed booking refund') || lowerMsg.includes('money back')) {
        detectedIntent = 'REFUND_POLICY';
        botResponse = `💸 **DFL Refund Process & Guidelines:**\n\n` +
            `1. **Cancelled / Unprocessed Shipments:**\n` +
            `   - If a shipment booking is cancelled before pickup/dispatch, the full booking amount is **automatically credited to your DFL Wallet within 24 - 48 hours**.\n\n` +
            `2. **Failed Payment Gateway Transactions:**\n` +
            `   - If money was deducted during top-up but failed, payment gateways reverse the transaction directly to your bank account within **3 - 5 business days**.\n\n` +
            `3. **Wallet Balance Refund to Bank:**\n` +
            `   - Unused wallet balance can be refunded to your original bank/UPI account upon request. Type **"Support"** to submit a wallet refund ticket!`;
        actionPayload = { type: 'refund_policy' };
    }
    // 6. Contact Phone Number Query
    else if (lowerMsg.includes('number') || lowerMsg.includes('phone') || lowerMsg.includes('contact') || lowerMsg.includes('mobile') || lowerMsg.includes('mera number')) {
        detectedIntent = 'USER_PHONE';
        const user = await User.findById(userId).select('name phone customerId');
        if (user && user.phone) {
            botResponse = `📱 **Your Registered Phone Number:** **${user.phone}**\n(Customer ID: \`${user.customerId}\`)`;
        } else {
            botResponse = `No phone number is linked to your profile.`;
        }
    }
    // 7. User Profile / Account Details Query
    else if (lowerMsg.includes('detail') || lowerMsg.includes('details') || lowerMsg.includes('name') || lowerMsg.includes('who am i') || lowerMsg.includes('profile') || lowerMsg.includes('mera naam') || lowerMsg.includes('my email') || lowerMsg.includes('info')) {
        detectedIntent = 'USER_PROFILE';
        const user = await User.findById(userId).select('name email customerId phone accountType walletBalance');
        if (user) {
            contextFacts = { userProfile: user };
            botResponse = `👤 **Your Account Profile Details**\n\n` +
                `- **Name:** ${user.name}\n` +
                `- **Customer ID:** \`${user.customerId}\`\n` +
                `- **Contact Phone:** ${user.phone ? user.phone : 'N/A'}\n` +
                `- **Email:** ${user.email}\n` +
                `- **Wallet Balance:** ₹${user.walletBalance || 0}\n` +
                `- **Account Type:** ${user.accountType ? user.accountType.toUpperCase() : 'PERSONAL'}`;
            actionPayload = { type: 'user_profile', data: { name: user.name, customerId: user.customerId } };
        } else {
            botResponse = `I could not retrieve your profile details at the moment.`;
        }
    }
    // 8. Wallet Balance Query
    else if (lowerMsg.includes('wallet') || lowerMsg.includes('balance') || lowerMsg.includes('paise')) {
        detectedIntent = 'WALLET_BALANCE';
        const user = await User.findById(userId).select('name walletBalance customerId');
        if (user) {
            botResponse = `💰 **Your Wallet Balance:** **₹${user.walletBalance || 0} INR**`;
        } else {
            botResponse = `Unable to fetch wallet balance right now.`;
        }
    }
    // 8b. Recent / Last Transaction Query
    else if (lowerMsg.includes('transaction') || lowerMsg.includes('last payment') || lowerMsg.includes('last txn') || lowerMsg.includes('recent payment') || lowerMsg.includes('history payment')) {
        detectedIntent = 'WALLET_TRANSACTION';
        const txn = await getUserLatestTransaction(userId);
        if (txn) {
            contextFacts = { latestTransaction: txn };
            botResponse = `💳 **Your Most Recent Wallet Transaction**\n\n` +
                `- **Amount:** **${txn.amount}** (${txn.type})\n` +
                `- **Description:** ${txn.description}\n` +
                `- **Status:** \`${txn.status}\`\n` +
                `- **Balance After:** ${txn.balanceAfter}\n` +
                `- **Date:** ${txn.date}`;
            actionPayload = { type: 'latest_transaction', data: txn };
        } else {
            botResponse = `No recent wallet transactions found in your registered account.`;
        }
    }
    // 9. Rate Estimate / Pricing
    else if (lowerMsg.includes('rate') || lowerMsg.includes('price') || lowerMsg.includes('cost') || lowerMsg.includes('quote') || lowerMsg.includes('charge') || lowerMsg.includes('kg') || lowerMsg.match(/\b\d+(\.\d+)?\s*(kg|g)\b/i)) {
        detectedIntent = 'RATE_ESTIMATE';
        const weightMatch = lowerMsg.match(/(\d+(\.\d+)?)\s*(kg)?/);
        const weight = weightMatch ? weightMatch[1] : '1';
        let dest = 'United States';
        if (lowerMsg.includes('uk') || lowerMsg.includes('london')) dest = 'United Kingdom';
        if (lowerMsg.includes('canada')) dest = 'Canada';
        if (lowerMsg.includes('uae') || lowerMsg.includes('dubai')) dest = 'UAE';
        if (lowerMsg.includes('australia')) dest = 'Australia';

        const rateResult = await calculateShippingRate(weight, dest, userId);
        contextFacts = { rateResult };
        botResponse = `💰 **Live Shipping Rate Quote for ${rateResult.destination} (${rateResult.weight})**\n\n` +
            `${rateResult.summaryText}\n\n` +
            `*Rates include your account tier discounts. Final charges depend on exact volumetric dimensions at pickup.*`;
        actionPayload = { type: 'rate_estimate', data: rateResult };
    }
    // 10a. Branch Locations Query
    else if (lowerMsg.includes('branch') || lowerMsg.includes('office') || lowerMsg.includes('location') || lowerMsg.includes('noida') || lowerMsg.includes('mumbai') || lowerMsg.includes('ahmedabad') || lowerMsg.includes('nagina') || lowerMsg.includes('vadodara') || lowerMsg.includes('bangkok') || lowerMsg.includes('dubai') || lowerMsg.includes('kahan hai') || lowerMsg.includes('address')) {
        detectedIntent = 'BRANCH_LOCATIONS';
        contextFacts = { branches: DFL_BRANCHES };
        const branchList = DFL_BRANCHES.map(b => `• **${b.city} (${b.type})**: ${b.address}\n  📞 Phone: ${b.phones.join(', ')} | ✉️ Email: ${b.emails.join(', ')}`).join('\n\n');
        botResponse = `📍 **DFL Group Official Branch Offices Directory:**\n\n${branchList}\n\n*Headquarters: Noida, India. International Branches: Bangkok (Thailand) & Dubai (UAE).*`;
        actionPayload = { type: 'branch_locations', data: DFL_BRANCHES };
    }
    // 10b. Privacy Policy Query
    else if (lowerMsg.includes('privacy') || lowerMsg.includes('privacy policy') || lowerMsg.includes('data policy')) {
        detectedIntent = 'PRIVACY_POLICY';
        contextFacts = { privacyPolicy: DFL_PRIVACY_POLICY_SUMMARY };
        botResponse = `🔒 **DFL Express Privacy Policy Highlights:**\n${DFL_PRIVACY_POLICY_SUMMARY}\n\nFor privacy inquiries, contact: **privacy@thedflgroup.com**`;
        actionPayload = { type: 'privacy_policy' };
    }
    // 10c. Terms & Conditions Query
    else if (lowerMsg.includes('terms') || lowerMsg.includes('terms of service') || lowerMsg.includes('t&c') || lowerMsg.includes('conditions')) {
        detectedIntent = 'TERMS_AND_CONDITIONS';
        contextFacts = { termsSummary: DFL_TERMS_SUMMARY };
        botResponse = `📜 **DFL Express Terms & Conditions Highlights:**\n${DFL_TERMS_SUMMARY}`;
        actionPayload = { type: 'terms_and_conditions' };
    }
    // 10d. Prohibited / Restricted Items Query
    else if (lowerMsg.includes('prohibited') || lowerMsg.includes('restricted') || lowerMsg.includes('banned') || lowerMsg.includes('kya nahi bhej sakte') || lowerMsg.includes('forbidden')) {
        detectedIntent = 'PROHIBITED_ITEMS';
        contextFacts = { prohibitedItems: DFL_PROHIBITED_ITEMS };
        const itemsList = DFL_PROHIBITED_ITEMS.map(i => `• ${i}`).join('\n');
        botResponse = `🚫 **Prohibited & Restricted Items List:**\n\nThe following items are strictly non-permissible for shipping via DFL Express:\n\n${itemsList}\n\n*Shipping restricted cargo may lead to customs seizure and account suspension.*`;
        actionPayload = { type: 'prohibited_items', data: DFL_PROHIBITED_ITEMS };
    }
    // 10e. DFL Logistics Services Overview
    else if (lowerMsg.includes('service') || lowerMsg.includes('services') || lowerMsg.includes('air freight') || lowerMsg.includes('ocean freight') || lowerMsg.includes('customs') || lowerMsg.includes('csbv') || lowerMsg.includes('warehousing')) {
        detectedIntent = 'COMPANY_SERVICES';
        contextFacts = { services: DFL_SERVICES };
        botResponse = `🚚 **DFL Express Logistics Services & Solutions:**\n\n` +
            `• **Express Courier:** ${DFL_SERVICES.expressCourier}\n\n` +
            `• **Air Freight:** ${DFL_SERVICES.airFreight}\n\n` +
            `• **Ocean Freight:** ${DFL_SERVICES.oceanFreight}\n\n` +
            `• **Customs Clearance:** ${DFL_SERVICES.customsClearance}\n\n` +
            `• **Warehousing & Fulfillment:** ${DFL_SERVICES.warehousing}\n\n` +
            `• **E-commerce Integrations:** ${DFL_SERVICES.ecommerceIntegrations}`;
        actionPayload = { type: 'company_services', data: DFL_SERVICES };
    }
    // 10. Support Escalation / Ticket Creation
    else if (lowerMsg.includes('human') || lowerMsg.includes('support') || lowerMsg.includes('ticket') || lowerMsg.includes('agent')) {
        detectedIntent = 'SUPPORT_ESCALATION';
        const ticketResult = await createSupportTicket('Chatbot Escalation Support Request', trimmedMsg, userId);
        botResponse = `🎫 **Support Ticket Created**\n\n` +
            `I have created a support ticket **#${ticketResult.ticketNumber}** for your issue.\n\n` +
            `Our DFL Customer Support team has been notified and will reach out to you shortly!`;
        actionPayload = { type: 'ticket_created', data: ticketResult };
    }

    // Auto-attach user's latest context (shipments + transaction + DFL Knowledge Base) for OpenAI follow-up questions
    const recentContext = await getUserRecentShipmentsContext(userId, 3);
    const latestTxn = await getUserLatestTransaction(userId);
    contextFacts = {
        ...contextFacts,
        dflCompanyInfo: DFL_COMPANY_INFO,
        dflBranches: DFL_BRANCHES,
        dflServices: DFL_SERVICES,
        dflPrivacyPolicy: DFL_PRIVACY_POLICY_SUMMARY,
        dflTerms: DFL_TERMS_SUMMARY,
        dflProhibitedItems: DFL_PROHIBITED_ITEMS,
        latestTransaction: latestTxn,
        recentShipments: recentContext.shipments,
        latestShipment: recentContext.shipments[0] || null
    };

    // 11. OpenAI Integration for Natural Multi-Lingual Responses (Hindi, Hinglish, English)
    if (process.env.OPENAI_API_KEY) {
        const aiResult = await generateOpenAIResponse(trimmedMsg, contextFacts || {});
        if (aiResult.success) {
            botResponse = aiResult.message;
            detectedIntent = 'OPENAI_CONVERSATIONAL';
        }
    }

    // 4. Output Privacy Guard Scan
    const sanitizedBotResponse = sanitizeOutput(botResponse);
    const finalBotResponse = (sanitizedBotResponse && String(sanitizedBotResponse).trim()) || botResponse || 'How can I assist you with your DFL shipment today?';

    // Save assistant response to session
    session.messages.push({
        role: 'assistant',
        content: finalBotResponse,
        timestamp: new Date()
    });

    session.updatedAt = new Date();
    await session.save();

    logChatbotEvent({
        requestId,
        userId,
        intent: detectedIntent,
        latency: Date.now() - startTime,
        status: 'SUCCESS'
    });

    return {
        success: true,
        message: finalBotResponse,
        sessionId: session.sessionId,
        actionPayload
    };
};

/**
 * Get Session Chat History
 */
const getChatHistory = async (userId, sessionId) => {
    if (!sessionId) {
        const latestSession = await ChatSession.findOne({ userId }).sort({ updatedAt: -1 });
        return latestSession ? latestSession.messages : [];
    }
    const session = await ChatSession.findOne({ userId, sessionId });
    return session ? session.messages : [];
};

/**
 * Clear Chat Session History
 */
const clearChatHistory = async (userId, sessionId = null) => {
    if (sessionId) {
        await ChatSession.deleteOne({ userId, sessionId });
    } else {
        await ChatSession.deleteMany({ userId });
    }
    return { success: true, message: 'Chat history cleared' };
};

module.exports = {
    processChatMessage,
    getChatHistory,
    clearChatHistory,
    getShipmentStatus: getShipmentContext,
    getShipmentContext,
    getUserRecentShipments: getUserRecentShipmentsContext,
    getUserRecentShipmentsContext,
    getUserShipmentSummary: getUserShipmentSummaryContext,
    calculateShippingRate,
    getUserKycStatus,
    createSupportTicket,
    resolvePincodeGeocode,
    calculateRatesForDraft
};
