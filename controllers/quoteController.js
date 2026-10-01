const sendEmail = require('../utils/emailService');
const rateCalculator = require('../utils/rateCalculator');
const { getSurchargeRatePerKg } = require('../utils/surchargeCalculator');
const SystemConfig = require('../models/SystemConfig');
const willowCommerceService = require('../services/willow/willowCommerceService');
const currencyRateService = require('../services/currency/currencyRateService');
const { calculateWillowCommerceRates } = require('../services/willow/willowRateCalculator');


const QuoteQuery = require('../models/QuoteQuery');
const User = require('../models/User'); // Ensure User model is available globally if needed

// Initialize Cache Containers
if (!global.speedboxCache) global.speedboxCache = new Map();
if (!global.speedboxInFlight) global.speedboxInFlight = new Map();

// @desc    Request a heavy weight quote
// @route   POST /api/quotes/request
// @access  Public
exports.requestQuote = async (req, res) => {
    try {
        const { weight, numberOfBoxes, country, pinCode, pickupLocation, serviceMode } = req.body;
        const user = req.user; // Populated by protect middleware

        const generatedAt = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'full',
            timeStyle: 'medium'
        });

        // Tag Deciphering Logic
        const TAG_MAP_REVERSE = {
            'e034fb6b66aacc1d48f445ddfb08da98': 'Silver',
            'd95679752134a2d9eb61dbd7b91c4bcc': 'Gold',
            '5c7f383122c4a923d34d3f3511d1377e': 'Platinum',
            '923971e40ebbd2f61e7215f5763567d1': 'Franchise'
        };

        let userTag = 'Standard';
        if (user && user.tag && TAG_MAP_REVERSE[user.tag]) {
            userTag = TAG_MAP_REVERSE[user.tag];
        }

        // Format Billing Address
        let billingAddressStr = 'N/A';
        if (user && user.kycData && user.kycData.billingAddress) {
            const { addressLine1, addressLine2, city, state, country, pincode } = user.kycData.billingAddress;
            const parts = [addressLine1, addressLine2, city, state, country, pincode].filter(Boolean);
            if (parts.length > 0) {
                billingAddressStr = parts.join(', ');
            }
        }

        const message = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1a1a1a; background-color: #f4f4f4; margin: 0; padding: 0; }
                    .container { max-width: 650px; margin: 30px auto; background-color: #ffffff; border: 1px solid #dcdcdc; border-radius: 4px; overflow: hidden; }
                    .header { background-color: #0B4F6C; color: #ffffff; padding: 25px; border-bottom: 4px solid #063852; }
                    .header h2 { margin: 0; font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
                    .header p { margin: 5px 0 0; font-size: 13px; opacity: 0.8; font-family: monospace; }
                    .content { padding: 30px; }
                    .section-title { font-size: 16px; font-weight: 700; color: #0B4F6C; margin-bottom: 15px; text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 8px; }
                    .data-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
                    .data-table th, .data-table td { padding: 12px 15px; border: 1px solid #e0e0e0; text-align: left; }
                    .data-table th { background-color: #f9f9f9; color: #555; font-weight: 600; width: 40%; }
                    .data-table td { color: #333; font-weight: 500; }
                    .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; }
                    .status-verified { color: #155724; font-weight: bold; background-color: #d4edda; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
                    .status-pending { color: #856404; font-weight: bold; background-color: #fff3cd; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>Quote Request</h2>
                        <p>ID: ${Date.now()} | ${generatedAt}</p>
                    </div>
                    
                    <div class="content">
                        <!-- Shipment Details -->
                        <div class="section-title">Shipment Details</div>
                        <table class="data-table">
                            <tr>
                                <th>Weight</th>
                                <td>${weight} kg</td>
                            </tr>
                            <tr>
                                <th>Number of Boxes</th>
                                <td>${numberOfBoxes}</td>
                            </tr>
                            <tr>
                                <th>Service Mode</th>
                                <td>${serviceMode === 'pickup' ? 'Schedule Pickup' : 'Drop off at Warehouse'}</td>
                            </tr>
                            ${serviceMode === 'pickup' ? `
                            <tr>
                                <th>Pickup Location</th>
                                <td>${pickupLocation}</td>
                            </tr>` : ''}
                            <tr>
                                <th>Destination Country</th>
                                <td>${country}</td>
                            </tr>
                            <tr>
                                <th>Destination Zip Code</th>
                                <td>${pinCode}</td>
                            </tr>
                        </table>

                        ${user ? `
                        <!-- Customer Profile -->
                        <div class="section-title">Customer Profile</div>
                        <table class="data-table">
                            <tr>
                                <th>Full Name</th>
                                <td>${user.name || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Email</th>
                                <td><a href="mailto:${user.email}" style="color: #0B4F6C; text-decoration: none;">${user.email || 'N/A'}</a></td>
                            </tr>
                            <tr>
                                <th>Phone</th>
                                <td>${user.phone || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Customer ID</th>
                                <td><span style="font-family: monospace;">${user.customerId || 'N/A'}</span></td>
                            </tr>
                            <tr>
                                <th>Account Type</th>
                                <td style="text-transform: capitalize;">${user.accountType || 'Personal'}</td>
                            </tr>
                            <tr>
                                <th>Membership Tag</th>
                                <td>${userTag}</td>
                            </tr>
                        </table>

                        <!-- Business & KYC Info -->
                        <div class="section-title">Business & KYC Info</div>
                        <table class="data-table">
                            <tr>
                                <th>KYC Status</th>
                                <td>
                                    ${user.kycVerified
                    ? '<span class="status-verified">VERIFIED</span>'
                    : '<span class="status-pending">PENDING / NOT VERIFIED</span>'}
                                </td>
                            </tr>
                            ${user.kycData?.gstNumber ? `
                            <tr>
                                <th>GST Number</th>
                                <td style="font-family: monospace;">${user.kycData.gstNumber}</td>
                            </tr>` : ''}
                            <tr>
                                <th>Billing Address</th>
                                <td>${billingAddressStr}</td>
                            </tr>
                        </table>
                        ` : ''}
                    </div>

                    <div class="footer">
                        <p>&copy; ${new Date().getFullYear()} DFL Group. Automated System Message.</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Re-fetch user to ensure we have assignedTo populated
        let dbUser = user;
        if (user?._id) {
            try {
                dbUser = await User.findById(user?._id).populate('assignedTo');
            } catch (err) {
                return res.status(500).json({
                    success: false,
                    message: err.message || 'Server error fetching user details for quote request'
                });
            }
        }

        // SAVE QUERY TO DB
        try {
            await QuoteQuery.create({
                user: dbUser?._id || null,
                customerName: dbUser?.name || req.body?.name || 'Guest',
                customerId: dbUser?.customerId || 'GUEST',
                email: dbUser?.email || req.body?.email || 'N/A',
                phone: dbUser?.phone || req.body?.phone || 'N/A',
                queryType: 'Manual Request',
                origin: {
                    city: pickupLocation || 'Pickup Request',
                    country: 'India', // Assumed export
                },
                destination: {
                    country: country,
                    pincode: pinCode
                },
                weightInfo: {
                    chargeableWeight: weight
                },
                boxes: [{ count: numberOfBoxes }],
                assignedTo: dbUser ? dbUser.assignedTo : null,
                status: 'New'
            });
        } catch (dbError) {
            return res.status(500).json({
                success: false,
                message: dbError.message || 'Server error saving quote request'
            });
        }

        let recipients = [process.env.CONTACT_EMAIL || process.env.RECEIVER_EMAIL || 'sales@thedflgroup.com'];
        if (dbUser && dbUser.assignedTo && dbUser.assignedTo.email) {
            recipients.push(dbUser.assignedTo.email);
        }

        await sendEmail({
            email: recipients.join(','),
            subject: `Quote Request: ${weight}kg to ${country} [${dbUser ? dbUser.name : 'Guest'}]`,
            html: message
        });

        res.status(200).json({
            success: true,
            message: 'Quote request submitted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Email could not be sent',
            error: error.message
        });
    }
};

// @desc    Handle oversized package query
// @route   POST /api/quotes/oversize
// @access  Protected
exports.handleOversizePackage = async (req, res) => {
    try {
        const { formData, userId } = req.body;
        let user = req.user; // Populated by protect middleware

        // If no user from middleware, try to find by ID if provided
        if (!user && userId && userId !== 'guest') {
            const User = require('../models/User');
            try {
                user = await User.findById(userId).select('-password');
            } catch (err) {
                console.error(`Failed to fetch user for oversized package query with userId ${userId}:`, err);
            }
        }

        const generatedAt = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'full',
            timeStyle: 'medium'
        });

        // Tag Deciphering Logic
        const TAG_MAP_REVERSE = {
            'e034fb6b66aacc1d48f445ddfb08da98': 'Silver',
            'd95679752134a2d9eb61dbd7b91c4bcc': 'Gold',
            '5c7f383122c4a923d34d3f3511d1377e': 'Platinum'
        };

        let userTag = 'Standard';
        if (user && user.tag && TAG_MAP_REVERSE[user.tag]) {
            userTag = TAG_MAP_REVERSE[user.tag];
        }

        // Format Billing Address
        let billingAddressStr = 'N/A';
        if (user && user.kycData && user.kycData.billingAddress) {
            const { addressLine1, addressLine2, city, state, country, pincode } = user.kycData.billingAddress;
            const parts = [addressLine1, addressLine2, city, state, country, pincode].filter(Boolean);
            if (parts.length > 0) {
                billingAddressStr = parts.join(', ');
            }
        }

        // Format Boxes Table for Email
        const boxesTable = formData.boxes.map((box, index) => `
            <tr>
                <td>Box ${index + 1}</td>
                <td>${box.length || 0} x ${box.width || 0} x ${box.height || 0} cm</td>
                <td>${box.weight || 0} kg</td>
            </tr>
        `).join('');

        const message = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1a1a1a; background-color: #f4f4f4; margin: 0; padding: 0; }
                    .container { max-width: 650px; margin: 30px auto; background-color: #ffffff; border: 1px solid #dcdcdc; border-radius: 4px; overflow: hidden; }
                    .header { background-color: #dc3545; color: #ffffff; padding: 25px; border-bottom: 4px solid #a71d2a; }
                    .header h2 { margin: 0; font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
                    .header p { margin: 5px 0 0; font-size: 13px; opacity: 0.8; font-family: monospace; }
                    .content { padding: 30px; }
                    .section-title { font-size: 16px; font-weight: 700; color: #dc3545; margin-bottom: 15px; text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 8px; }
                    .data-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
                    .data-table th, .data-table td { padding: 12px 15px; border: 1px solid #e0e0e0; text-align: left; }
                    .data-table th { background-color: #f9f9f9; color: #555; font-weight: 600; width: 40%; }
                    .data-table td { color: #333; font-weight: 500; }
                    .alert-box { background-color: #fff3cd; color: #856404; padding: 15px; border-radius: 4px; margin-bottom: 20px; border: 1px solid #ffeeba; }
                    .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; }
                    .status-verified { color: #155724; font-weight: bold; background-color: #d4edda; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
                    .status-pending { color: #856404; font-weight: bold; background-color: #fff3cd; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>Oversized Package Query</h2>
                        <p>ID: ${Date.now()} | ${generatedAt}</p>
                    </div>
                    
                    <div class="content">
                        <div class="alert-box">
                            <strong>Note:</strong> This customer has attempted to fetch a quote for a package exceeding standard dimensions (>118cm).
                        </div>

                        <!-- Shipment Details -->
                        <div class="section-title">Shipment Overview</div>
                        <table class="data-table">
                            <tr>
                                <th>Origin</th>
                                <td>${formData.fromCity}, ${formData.fromCountry} (${formData.fromPostcode})</td>
                            </tr>
                            <tr>
                                <th>Destination</th>
                                <td>${formData.toCity}, ${formData.toCountry} (${formData.toPostcode})</td>
                            </tr>
                        </table>

                        <div class="section-title">Package Dimensions</div>
                        <table class="data-table">
                            <tr>
                                <th>Box No.</th>
                                <th>Dimensions (L x W x H)</th>
                                <th>Weight</th>
                            </tr>
                            ${boxesTable}
                        </table>

                        ${user ? `
                        <!-- Customer Profile -->
                        <div class="section-title">Customer Profile</div>
                        <table class="data-table">
                            <tr>
                                <th>Full Name</th>
                                <td>${user.name || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Email</th>
                                <td><a href="mailto:${user.email}" style="color: #dc3545; text-decoration: none;">${user.email || 'N/A'}</a></td>
                            </tr>
                            <tr>
                                <th>Phone</th>
                                <td>${user.phone || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Customer ID</th>
                                <td style="font-family: monospace;">${user.customerId || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Account Type</th>
                                <td style="text-transform: capitalize;">${user.accountType || 'Personal'}</td>
                            </tr>
                            <tr>
                                <th>Membership Tag</th>
                                <td>${userTag}</td>
                            </tr>
                        </table>

                        <!-- Business & KYC Info -->
                        <div class="section-title">Business & KYC Info</div>
                        <table class="data-table">
                            <tr>
                                <th>KYC Status</th>
                                <td>
                                    ${user.kycVerified
                    ? '<span class="status-verified">VERIFIED</span>'
                    : '<span class="status-pending">PENDING / NOT VERIFIED</span>'}
                                </td>
                            </tr>
                            ${user.kycData?.gstNumber ? `
                            <tr>
                                <th>GST Number</th>
                                <td style="font-family: monospace;">${user.kycData.gstNumber}</td>
                            </tr>` : ''}
                            <tr>
                                <th>Billing Address</th>
                                <td>${billingAddressStr}</td>
                            </tr>
                        </table>
                        ` : ''}
                    </div>

                    <div class="footer">
                        <p>&copy; ${new Date().getFullYear()} DFL Group. Automated System Message.</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        // SAVE QUERY TO DB
        try {
            const boxesData = formData?.boxes?.map(b => ({
                length: b?.length,
                width: b?.width,
                height: b?.height,
                count: 1 // Assuming 1 per entry in this UI
            })) || [];

            // Calculate total actual weight from boxes
            const totalActualWeight = formData?.boxes?.reduce((sum, box) => sum + Number(box?.weight || 0), 0) || 0;

            await QuoteQuery.create({
                user: user?._id || null,
                customerName: user?.name || 'Guest',
                customerId: user?.customerId || 'GUEST',
                email: user?.email || 'N/A',
                phone: user?.phone || 'N/A',
                queryType: 'Oversized',
                origin: {
                    city: formData?.fromCity,
                    country: formData?.fromCountry,
                    pincode: formData?.fromPostcode
                },
                destination: {
                    city: formData?.toCity,
                    country: formData?.toCountry,
                    pincode: formData?.toPostcode
                },
                weightInfo: {
                    actualWeight: totalActualWeight,
                    chargeableWeight: totalActualWeight // Approximate for query
                },
                boxes: boxesData,
                status: 'New'
            });
        } catch (dbError) {
            return res.status(500).json({
                success: false,
                message: dbError.message || 'Server error saving oversized package query'
            });
        }

        await sendEmail({
            email: process.env.CONTACT_EMAIL || 'pricing@dflindia.in',
            subject: `Oversized Package Query: [${user ? user.name : 'Guest'}]`,
            html: message
        });

        res.status(200).json({
            success: true,
            message: 'Oversize package query submitted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Email could not be sent',
            error: error.message
        });
    }
};

// @desc    Get real-time quote price
// @route   POST /api/quotes/calculate
// @access  Public
// @access  Public
exports.getQuotePrice = async (req, res) => {
    try {
        let { weight, country, state, pinCode, destination } = req.body;

        // Handle nested destination object from Frontend
        if (destination) {
            country = destination.country;
            state = destination.state;
            pinCode = destination.pincode || destination.zip;
        }

        // Fetch Surcharge Config
        let surchargeConfig = null;
        try {
            const config = await SystemConfig.findOne({ key: 'surchargeConfig' });
            if (config?.value) surchargeConfig = config.value;
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: err.message || 'Server error fetching surcharge configuration'
            });
        }

        // Default Pincode to 00000 if missing (User Requirement)
        if (!pinCode || pinCode.trim() === '') {
            pinCode = '00000';
        }

        // Resolving Country Code
        let resolvedCountryCode = destination?.countryCode;
        if (!resolvedCountryCode && country) {
            const countryMap = {
                'India': 'IN', 'United States': 'US', 'United Kingdom': 'GB', 'Canada': 'CA', 'Australia': 'AU',
                'Germany': 'DE', 'France': 'FR', 'United Arab Emirates': 'AE', 'New Zealand': 'NZ',
                'Netherlands': 'NL', 'Ireland': 'IE', 'Italy': 'IT', 'Spain': 'ES', 'Austria': 'AT',
                'Finland': 'FI', 'Mexico': 'MX', 'Saudi Arabia': 'SA', 'KSA': 'SA',
                'Romania': 'RO',
                'Sweden': 'SE',
                'Portugal': 'PT',
                'Poland': 'PL',
                'Belgium': 'BE',
                'Bulgaria': 'BG',
                'Croatia': 'HR',
                'Cyprus': 'CY',
                'Czech Republic': 'CZ',
                'Denmark': 'DK',
                'Estonia': 'EE',
                'Greece': 'GR',
                'Hungary': 'HU',
                'Latvia': 'LV',
                'Lithuania': 'LT',
                'Luxembourg': 'LU',
                'Malta': 'MT',
                'Slovenia': 'SI',
                'Slovakia': 'SK',
                'Malaysia': 'MY',
                'Singapore': 'SG'
            };
            const cName = country.trim();
            const mapped = Object.keys(countryMap).find(k => k.toLowerCase() === cName.toLowerCase());
            if (mapped) resolvedCountryCode = countryMap[mapped];
        }

        // --- UK Origin Logic ---
        const source = req.body.source || {};
        const originCountry = source.country ? source.country.trim().toLowerCase() : 'india';
        const isUKOrigin = originCountry === 'united kingdom' || originCountry === 'uk' || originCountry === 'gb';

        if (isUKOrigin) {
            const GBP_TO_INR = 110; // Fixed Conversion Rate
            let finalRateGBP = 0;
            let finalRateINR = 0;
            let handlingChargeGBP = 0;
            let minChargeableWeight = 10;
            let chargeableWeight = 0;
            const actualWeight = parseFloat(weight);
            const destCountryLower = country.trim().toLowerCase();
            const destCode = resolvedCountryCode ? resolvedCountryCode.toUpperCase() : '';

            // 1. UK -> India
            if (destCountryLower === 'india' || destCode === 'IN') {
                const city = destination?.city ? destination.city.toLowerCase().trim() : '';
                const tier1Cities = ['mumbai', 'delhi', 'bengaluru', 'bangalore', 'chennai', 'kolkata', 'hyderabad', 'pune', 'ahmedabad'];
                const isTier1 = tier1Cities.some(t => city.includes(t));

                if (actualWeight >= 1 && actualWeight <= 10) {
                    // Weight 1-10kg: Min charge 10kg
                    const ratePerKg = isTier1 ? 4.99 : 7.99;
                    finalRateGBP = ratePerKg * 10; // Fixed charge for 10kg
                    chargeableWeight = 10; // Force min weight
                } else if (actualWeight > 10) {
                    // Weight >10kg: £4.99/kg + £10 handling
                    // Assumption: Applies to ALL cities for >10kg as per "P1" generic rule description
                    const ratePerKg = 4.99;
                    handlingChargeGBP = 10.00;
                    finalRateGBP = (ratePerKg * actualWeight) + handlingChargeGBP;
                    chargeableWeight = actualWeight;
                } else {
                    // Weight < 1kg? Assume falling into 1-10kg bracket min charge?
                    // Let's assume strict 1-10 meant "Up to 10". If <1, treat as 1kg but charge min 10kg price.
                    const ratePerKg = isTier1 ? 4.99 : 7.99;
                    finalRateGBP = ratePerKg * 10;
                    chargeableWeight = 10;
                }

                finalRateINR = finalRateGBP * GBP_TO_INR;

                return res.json({
                    success: true,
                    data: {
                        rates: [{
                            id: 'UK_IN_P1',
                            serviceName: 'UK to India Express',
                            zone: 'IN',
                            chargableWeight: chargeableWeight,
                            rate: finalRateINR, // Total Rate in INR
                            currency: 'INR',
                            transitTime: '5-7 Working Days',
                            provider: 'DFL UK',
                            isInternal: true,
                            image: '/dfl_express_logo.png',
                            bestValue: true,
                            totalPrice: finalRateINR, // Required for Frontend Display
                            boxDetails: [{ weight: chargeableWeight, rate: finalRateINR }],
                            breakdown: {
                                baseRate: Number((finalRateINR).toFixed(2)),
                                gst: 0, // Export/Import usually 0 GST? Or included? Assuming clear price.
                                markup: 0,
                                handlingCharge: Number((handlingChargeGBP * GBP_TO_INR).toFixed(2)),
                                tag: 'Standard'
                            },
                            paramDetails: {
                                isTier1,
                                appliedRateGBP: finalRateGBP,
                                handlingGBP: handlingChargeGBP
                            }
                        }]
                    }
                });
            }
            // 2. UK -> Dubai (UAE)
            else if (destCountryLower === 'united arab emirates' || destCountryLower === 'uae' || destCountryLower === 'dubai' || destCode === 'AE') {
                if (actualWeight >= 1 && actualWeight <= 10) {
                    // Min charge 10kg, Rate £4.99
                    const ratePerKg = 4.99;
                    finalRateGBP = ratePerKg * 10;
                    chargeableWeight = 10;
                } else {
                    // > 10kg: Assume same as India >10kg logic (£4.99 + £10)
                    const ratePerKg = 4.99;
                    handlingChargeGBP = 10.00;
                    finalRateGBP = (ratePerKg * actualWeight) + handlingChargeGBP;
                    chargeableWeight = actualWeight;
                }

                finalRateINR = finalRateGBP * GBP_TO_INR;

                return res.json({
                    success: true,
                    data: {
                        rates: [{
                            id: 'UK_UAE_P1',
                            serviceName: 'UK to Dubai Express',
                            zone: 'AE',
                            chargableWeight: chargeableWeight,
                            rate: finalRateINR,
                            currency: 'INR',
                            transitTime: '3-5 Working Days',
                            provider: 'DFL UK',
                            isInternal: true,
                            image: '/dfl_express_logo.png',
                            bestValue: true,
                            totalPrice: finalRateINR, // Required for Frontend Display
                            boxDetails: [{ weight: chargeableWeight, rate: finalRateINR }],
                            breakdown: {
                                baseRate: Number((finalRateINR).toFixed(2)),
                                gst: 0,
                                markup: 0,
                                handlingCharge: Number((handlingChargeGBP * GBP_TO_INR).toFixed(2)),
                                tag: 'Standard'
                            }
                        }]
                    }
                });

            }
            // 3. Other Destinations
            else {
                return res.json({
                    success: true,
                    data: {
                        rates: [], // No rates
                        contactSales: true, // Frontend trigger
                        message: "For shipments from UK to this destination, please contact our sales team."
                    }
                });
            }
        }
        // Calculate Volumetric Weight for Internal Rates
        let chargeableWeight = parseFloat(weight);
        if (req.body?.package?.box && Array.isArray(req.body?.package?.box)) {
            let totalVolumetricWeight = 0;
            req.body?.package?.box.forEach(box => {
                const l = parseFloat(box.length) || 0;
                const w = parseFloat(box.width) || 0;
                const h = parseFloat(box.height) || 0;
                const volWeight = (l * w * h) / 5000;
                totalVolumetricWeight += volWeight;
            });

            // Round up to next 0.5kg -- DISABLED for Small Packet Support
            // totalVolumetricWeight = Math.ceil(totalVolumetricWeight * 2) / 2;
            totalVolumetricWeight = parseFloat(totalVolumetricWeight.toFixed(3)); // Keep precision

            // Log for debugging
            // Use the greater of Actual vs Volumetric
            // Use the greater of Actual vs Volumetric
            if (totalVolumetricWeight > chargeableWeight) {
                chargeableWeight = totalVolumetricWeight;
            }
            // Slab logic removed for base weight
        } else {
            // Slab logic removed for base weight
        }

        // --- Weight Limit Check (Single Box) ---
        const { checkWeightLimit } = require('../utils/weightLimitChecker');
        const includeHandlingCharge = req.body?.includeHandlingCharge === true;

        // Ensure we have box details. If not provided (single box assumed from weight?), we might need to construct it.
        // req.body.package.box is usually available.
        // Ensure we have box details.
        let boxesForCheck = [];
        if (req.body?.package?.box?.length > 0) {
            boxesForCheck = req.body.package.box;
        } else {
            // Fallback if no specific box details
            boxesForCheck = [{ weight: weight }];
        }

        // Fix: Pre-calculate Volumetric Weight for Limit Check
        // Limit Check should likely apply to the CHARGEABLE weight of the box
        boxesForCheck = boxesForCheck.map(box => {
            let act = parseFloat(box.weight) || 0;
            let vol = 0;
            if (box.length && box.width && box.height) {
                vol = (parseFloat(box.length) * parseFloat(box.width) * parseFloat(box.height)) / 5000;
            }
            // Temporarily override weight for check, or simpler: just use chargeable
            return { ...box, weight: Math.max(act, vol), originalWeight: act, debugVol: vol, dims: { l: box.length, w: box.width, h: box.height } };
        });

        const skipWeightLimit = req.body?.skipWeightLimit === true;

        const limitCheck = skipWeightLimit
            ? { isExceeded: false }
            : checkWeightLimit(country, boxesForCheck);

        // FORCE DEBUG ERROR TO SEE DATA
        // throw new Error(`DEBUG DATA: Country=${country}, LimitCheck=${JSON.stringify(limitCheck)}, Boxes=${JSON.stringify(boxesForCheck)}`);

        if (limitCheck?.isExceeded) {
            // User Change: Always show rates, just apply surcharge.
            // But for DEBUGGING, I need to see what's happening.
            // I will append debug info to the surcharge message if possible, or just force return for a moment.

            // UNCOMMENTED FOR DEBUGGING
            if (!includeHandlingCharge) {
                return res.json({
                    isError: false,
                    weightLimitExceeded: true,
                    message: limitCheck?.message,
                    limit: limitCheck?.limit,
                    surcharge: limitCheck?.surcharge
                });
            }

            // If proceeding, we will add surcharge to rates later

        }

        // Initialize calculator if not already
        await rateCalculator.loadData();

        // New Logic: Calculate Rate Per Box and Sum Up
        // This ensures multi-box shipments are priced correctly (Sum of individual box rates)
        // rather than one single rate for total weight (which might be extrapolated linear)

        let totalBaseRate = 0;
        let boxDetails = [];
        let aggregatedServices = {}; // { 'Service Name': { rate: 0, count: 0 } }

        // Prepare base params
        const baseParams = {
            country,
            state,
            postcode: pinCode
        };

        // Ensure we have boxes to iterate. If not, treat as 1 box of chargeableWeight
        let calculationBoxes = [];
        if (req.body?.package?.box?.length > 0) {
            // Use actual boxes provided
            calculationBoxes = req.body?.package?.box;
        } else {
            // Fallback
            calculationBoxes = [{ weight: chargeableWeight }];
        }

        const totalBoxesCount = calculationBoxes.length;

        // Loop through all boxes
        for (const box of calculationBoxes) {
            let boxW = parseFloat(box.weight);
            // Calculate Box Volumetric
            let boxVol = 0;
            if (box.length && box.width && box.height) {
                boxVol = (parseFloat(box.length) * parseFloat(box.width) * parseFloat(box.height)) / 5000;
            }
            // Use Higher Weight
            boxW = Math.max(boxW, boxVol);

            // If Limit Exceeded, use Limit Weight for Rate Lookup (Base Price)
            if (limitCheck?.limit && boxW > limitCheck.limit) {
                boxW = limitCheck.limit;
            }

            const rateParams = { ...baseParams, weight: boxW };

            // ... same logic as ratesController ...
            let boxRes = null;
            try {
                boxRes = rateCalculator.getRate(rateParams);
            } catch (err) {
                // console.warn(`Local rate calc missing/failed for box: ${err.message}`);
                // Continue to next box or next step (Speedbox will cover it)
            }

            if (boxRes && boxRes.rates) {
                boxRes.rates.forEach(r => {
                    // TPL SPECIAL LOGIC: If multiple boxes, SKIP TPL here.
                    if (calculationBoxes.length > 1 && r.provider === 'TPL') {
                        return;
                    }

                    // Fix: Use more specific unique key to prevent different services from same provider/zone colliding
                    const uniqueKey = `${r.provider}_${r.serviceCode || r.serviceName}_${r.zone}`;
                    if (!aggregatedServices[uniqueKey]) {
                        aggregatedServices[uniqueKey] = {
                            serviceName: r.serviceName,
                            serviceCode: r.serviceCode, // DFLS code
                            zone: r.zone,
                            provider: r.provider,
                            totalRate: 0,
                            validBoxCount: 0,
                            matchedWeight: r.matchedWeight, // Capture matched weight
                            transitTime: r.transitTime, // Capture transit time
                            boxDetails: []
                        };
                    }
                    aggregatedServices[uniqueKey].totalRate += r.rate;
                    aggregatedServices[uniqueKey].validBoxCount += 1;
                    aggregatedServices[uniqueKey].boxDetails.push({
                        weight: boxW,
                        rate: r.rate,
                        zone: r.zone,
                        matchedWeight: r.matchedWeight // Capture for breakdown if needed
                    });
                });
            }
        }

        // --- TPL Average Weight Logic (Quote Controller) ---
        if (calculationBoxes.length > 1) {
            try {
                // Fix: Calculate Total Chargeable Weight for Average
                const totalChargeableW = calculationBoxes.reduce((sum, b) => {
                    let act = parseFloat(b.weight);
                    let vol = 0;
                    if (b.length && b.width && b.height) {
                        vol = (parseFloat(b.length) * parseFloat(b.width) * parseFloat(b.height)) / 5000;
                    }
                    return sum + Math.max(act, vol);
                }, 0);

                let avgWeight = totalChargeableW / calculationBoxes.length;

                if (limitCheck?.limit && avgWeight > limitCheck.limit) {
                    avgWeight = limitCheck.limit;
                }

                const boxResAvg = rateCalculator.getRate({ ...baseParams, weight: avgWeight });

                if (boxResAvg && boxResAvg.rates) {
                    boxResAvg.rates.forEach(r => {
                        if (r.provider !== 'TPL') return;

                        // Fix: Use more specific unique key for TPL
                        const uniqueKey = `${r.provider}_${r.serviceCode || r.serviceName}_${r.zone}`;
                        if (!aggregatedServices[uniqueKey]) {
                            aggregatedServices[uniqueKey] = {
                                serviceName: r.serviceName,
                                zone: r.zone,
                                provider: r.provider,
                                totalRate: 0,
                                validBoxCount: 0,
                                matchedWeight: r.matchedWeight,
                                transitTime: r.transitTime, // Capture transit time
                                boxDetails: []
                            };
                        }

                        // Total Rate = Avg Rate * Count
                        aggregatedServices[uniqueKey].totalRate = r.rate * calculationBoxes.length;
                        aggregatedServices[uniqueKey].validBoxCount = calculationBoxes.length;
                        aggregatedServices[uniqueKey].matchedWeight = r.matchedWeight; // Use avg matched weight

                        // Details
                        calculationBoxes.forEach(b => {
                            aggregatedServices[uniqueKey].boxDetails.push({
                                weight: parseFloat(b.weight),
                                rate: r.rate,
                                zone: r.zone,
                                note: `Based on Avg Weight ${avgWeight.toFixed(2)}kg`,
                                matchedWeight: r.matchedWeight
                            });
                        });
                    });
                }
            } catch (avgErr) {
                console.error('Failed to calculate average-weight TPL rates for quote:', avgErr);
            }
        }

        // Apply Pricing Logic
        let tierName = req.body.tag;
        let customAdditionalMarkup = 0;
        let userEmail = 'Guest/Unknown';
        const effectiveUserId = req.body.userId || req.user?._id || req.user?.id;

        if (effectiveUserId && effectiveUserId !== 'guest') {
            try {
                const dbUser = await User.findById(effectiveUserId).lean();
                if (dbUser) {
                    userEmail = dbUser.email || userEmail;
                    if (dbUser.markupPercentage !== undefined && dbUser.markupPercentage !== null && Number(dbUser.markupPercentage) > 0) {
                        const val = Number(dbUser.markupPercentage);
                        customAdditionalMarkup = val > 1 ? val / 100 : val;
                    }
                    if (!tierName && dbUser.tag) {
                        const TAG_MAP_REVERSE = {
                            'e034fb6b66aacc1d48f445ddfb08da98': 'Silver',
                            'd95679752134a2d9eb61dbd7b91c4bcc': 'Gold',
                            '5c7f383122c4a923d34d3f3511d1377e': 'Platinum'
                        };
                        tierName = TAG_MAP_REVERSE[dbUser.tag] || dbUser.tag;
                    }
                }
            } catch (err) {
                console.error(`Failed to fetch user tag for quote calculation with userId ${effectiveUserId}:`, err);
            }
        }

        // Default to Silver if still undefined
        tierName = tierName || 'Silver';

        let baseTierMarkup = 0.20; // Default Silver
        if (tierName.toLowerCase() === 'gold') baseTierMarkup = 0.16;
        else if (tierName.toLowerCase() === 'platinum') baseTierMarkup = 0.12;
        else if (tierName.toLowerCase() === 'bronze') baseTierMarkup = 0.25;

        const totalMarkupRatio = baseTierMarkup + customAdditionalMarkup;
        const tierMarkup = totalMarkupRatio; // Alias for Speedbox & UK Economy functions

        const gstRate = 0.18;
        const internalRates = [];

        Object.values(aggregatedServices).forEach(service => {
            // Only populate if service is valid for ALL boxes
            if (service.validBoxCount === totalBoxesCount) {
                const rawBaseRate = service.totalRate;

                // Add Surcharge if applicable
                let handlingCharge = 0;
                if (limitCheck?.isExceeded) {
                    handlingCharge = limitCheck?.surcharge || 0;
                }

                // Country-wise Surcharge Slab Logic: Next Higher Kilogram
                const countrySurchargeRate = getSurchargeRatePerKg(country, service.serviceName, surchargeConfig);
                let surchargeBilledWeight = Math.ceil(chargeableWeight);
                const countrySurcharge = countrySurchargeRate * surchargeBilledWeight;

                // Combined Markup calculation on Base Freight
                const markupAmount = rawBaseRate * totalMarkupRatio;
                const markedUpBaseRate = rawBaseRate + markupAmount;
                const taxableAmount = markedUpBaseRate + handlingCharge + countrySurcharge;
                const gstAmount = taxableAmount * gstRate;
                const totalAmount = taxableAmount + gstAmount;

                internalRates.push({
                    serviceName: service.serviceName,
                    serviceCode: service.serviceCode, // DFLS code
                    zone: service.zone,
                    chargableWeight: chargeableWeight,
                    rate: Number(markedUpBaseRate.toFixed(2)),
                    currency: 'INR',
                    transitTime: service.transitTime ? service.transitTime.replace(" Working Days", "") : (service.serviceName.includes('Economy') ? "7-10" : "5-7"),
                    provider: service.provider || 'TPL',
                    id: service.zone + '_' + service.serviceName.replace(/\s+/g, '_'),
                    isInternal: true,
                    image: '/dfl_express_logo.png',
                    boxDetails: service.boxDetails,
                    // Breakdown for UI
                    baseRate: Number(markedUpBaseRate.toFixed(2)),
                    rawBaseRate: Number(rawBaseRate.toFixed(2)),
                    gst: Number(gstAmount.toFixed(2)),
                    markup: Number(markupAmount.toFixed(2)),
                    markupPercentage: totalMarkupRatio,
                    handlingCharge: Number(handlingCharge.toFixed(2)),
                    countrySurcharge: Number(countrySurcharge.toFixed(2)),
                    totalPrice: Number(totalAmount.toFixed(2)),
                    tag: tierName
                });
            }
        });

        // --- Fetch External Carrier Rates Parallelly (Promise.allSettled) ---
        const fetchSpeedboxRatesAsync = async () => {
            let externalRates = [];
            try {
                const speedboxUrl = process.env.SPEEDBOX_API_URL;
                if (!speedboxUrl) return [];

                const sbPayload = {
                    source: {
                        country: "India",
                        countryCode: "IN",
                        ...req.body.source
                    },
                    destination: {
                        country: destination?.country || country,
                        city: destination?.city,
                        state: destination?.state || state,
                        countryCode: resolvedCountryCode || destination?.countryCode || 'US',
                        pincode: destination?.postalCode || destination?.pincode || destination?.zip || pinCode
                    },
                    shipmentType: req.body.shipmentType || "parcel",
                    weight: parseFloat(weight),
                    document: req.body.document || false,
                    package: req.body?.package ? {
                        ...req.body?.package,
                        box: req.body?.package?.box ? req.body?.package?.box.map(b => ({
                            weight: parseFloat(b.weight),
                            length: parseFloat(b.length),
                            width: parseFloat(b.width),
                            height: parseFloat(b.height)
                        })) : []
                    } : {}
                };

                const cacheKey = `sb_${JSON.stringify(sbPayload)}`;

                const fetchFromApi = async () => {
                    const sbResponse = await fetch(speedboxUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'sb_token': process.env.SPEEDBOX_API_KEY
                        },
                        body: JSON.stringify(sbPayload),
                        signal: AbortSignal.timeout(2500)
                    });
                    if (!sbResponse.ok) {
                        throw new Error(`Speedbox API Error: ${sbResponse.status}`);
                    }
                    const data = await sbResponse.json();
                    const hasData = (data.data && Array.isArray(data.data) && data.data.length > 0);
                    const hasCharges = (data.charges && data.charges.length > 0) ||
                        (data.data && data.data.charges && data.data.charges.length > 0) ||
                        (data.error && data.error.charges && data.error.charges.length > 0);

                    if (data.isError && !hasData && !hasCharges) {
                        return { data: [] };
                    }
                    return data;
                };

                let data = null;

                if (global.speedboxCache && global.speedboxCache.has(cacheKey)) {
                    const cached = global.speedboxCache.get(cacheKey);
                    if (Date.now() < cached.expiry) {
                        data = cached.data;
                    } else {
                        global.speedboxCache.delete(cacheKey);
                    }
                }

                if (!data) {
                    if (!global.speedboxInFlight) global.speedboxInFlight = new Map();

                    if (global.speedboxInFlight.has(cacheKey)) {
                        data = await global.speedboxInFlight.get(cacheKey);
                    } else {
                        const promise = fetchFromApi()
                            .then(resData => {
                                if (!global.speedboxCache) global.speedboxCache = new Map();
                                global.speedboxCache.set(cacheKey, {
                                    data: resData,
                                    expiry: Date.now() + (15 * 60 * 1000)
                                });
                                return resData;
                            })
                            .finally(() => {
                                if (global.speedboxInFlight) global.speedboxInFlight.delete(cacheKey);
                            });

                        global.speedboxInFlight.set(cacheKey, promise);

                        try {
                            data = await promise;
                        } catch (err) {}
                    }
                }

                let services = [];
                if (data) {
                    if (data.data && Array.isArray(data.data)) {
                        services = data.data;
                    } else if (data.data && data.data.charges) {
                        services = data.data.charges;
                    } else if (data.error && data.error.charges) {
                        services = data.error.charges;
                    }
                }

                if (services.length > 0) {
                    const allowedCouriers = ['fedex', 'dhl'];
                    const filteredServices = services.filter(service => {
                        const name = (service.serviceName || service.courierName || '').toLowerCase();
                        if (name.includes('import')) return false;
                        if (name.includes('freight')) return false;
                        return allowedCouriers.some(courier => name.includes(courier));
                    });

                    externalRates = filteredServices.map(service => {
                        const basePrice = service.totalPricing || service.rate;
                        const finalPrice = basePrice * (1 + tierMarkup);

                        return {
                            serviceName: service.serviceName || service.courierName,
                            zone: 'External',
                            country: destination?.country || country,
                            chargableWeight: service.chargeableWeight || parseFloat(weight),
                            rate: finalPrice,
                            currency: 'INR',
                            baseRate: basePrice,
                            gst: basePrice * 0.18,
                            markup: 0,
                            handlingCharge: 0,
                            totalPrice: Number(finalPrice.toFixed(2)),
                            tag: tierName,
                            bestValue: false,
                            isInternal: false,
                            id: service.serviceId || `sb_${Math.random().toString(36).substr(2, 9)}`,
                            image: service.serviceImage || "https://cdn-icons-png.flaticon.com/512/2830/2830305.png",
                            eta: service.transitTime || "3-5 Business Days"
                        };
                    });
                }
            } catch (sbError) {
                console.error('Speedbox Error in getQuotePrice:', sbError.message);
            }
            return externalRates;
        };

        const fetchUKEconomyRatesAsync = async () => {
            let ukEconomyRates = [];
            try {
                if (resolvedCountryCode === 'GB') {
                    let isOversizedForUKEconomy = false;
                    if (req.body?.package?.box) {
                        for (const box of req.body?.package?.box) {
                            const l = parseFloat(box.length) || 0;
                            const w = parseFloat(box.width) || 0;
                            const h = parseFloat(box.height) || 0;
                            if (l > 100 || w > 100 || h > 100) {
                                isOversizedForUKEconomy = true;
                                break;
                            }
                        }
                    }

                    if (!isOversizedForUKEconomy) {
                        const { calculateUKEconomyRate, calculateUKPriorityRate } = require('./ukEconomyController');
                        const totalWeightGrams = chargeableWeight * 1000;
                        const postcode = destination?.zip || destination?.postalCode || destination?.pincode || pinCode || '';

                        const ukRate = await calculateUKEconomyRate({
                            weightGrams: totalWeightGrams,
                            postcode,
                            tierMarkup,
                            handlingCharge: limitCheck?.isExceeded ? limitCheck?.surcharge || 0 : 0
                        });
                        if (ukRate && !ukRate.blocked) {
                            ukEconomyRates.push({
                                ...ukRate,
                                rate: ukRate.breakdown.base,
                                currency: 'INR',
                                baseRate: ukRate.breakdown.base,
                                gst: ukRate.breakdown.gst,
                                markup: ukRate.breakdown.markup,
                                handlingCharge: ukRate.breakdown.handlingCharge || 0,
                                totalPrice: ukRate.totalPricing,
                                tag: tierName,
                                bestValue: false,
                                zone: 'UK-ECONOMY',
                                country: destination?.country || country,
                                chargableWeight: ukRate.chargeableWeight,
                                image: ukRate.serviceImage,
                                eta: ukRate.transitTime
                            });
                        }

                        const ukPriorityRate = await calculateUKPriorityRate({
                            weightGrams: totalWeightGrams,
                            postcode,
                            tierMarkup,
                            handlingCharge: limitCheck?.isExceeded ? limitCheck?.surcharge || 0 : 0
                        });
                        if (ukPriorityRate && !ukPriorityRate.blocked) {
                            ukEconomyRates.push({
                                ...ukPriorityRate,
                                rate: ukPriorityRate.breakdown.base,
                                currency: 'INR',
                                baseRate: ukPriorityRate.breakdown.base,
                                gst: ukPriorityRate.breakdown.gst,
                                markup: ukPriorityRate.breakdown.markup,
                                handlingCharge: ukPriorityRate.breakdown.handlingCharge || 0,
                                totalPrice: ukPriorityRate.totalPricing,
                                tag: tierName,
                                bestValue: false,
                                zone: 'UK-PRIORITY',
                                country: destination?.country || country,
                                chargableWeight: ukPriorityRate.chargeableWeight,
                                image: ukPriorityRate.serviceImage,
                                eta: ukPriorityRate.transitTime
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to calculate UK economy rates:', err);
            }
            return ukEconomyRates;
        };

        const fetchWillowRatesAsync = async () => {
            let willowRates = [];
            try {
                if (resolvedCountryCode === 'US' || (destination?.country || country || '').trim().toLowerCase() === 'united states' || (destination?.country || country || '').trim().toLowerCase() === 'us') {
                    willowRates = await calculateWillowCommerceRates({
                        destination: destination || {},
                        countryCode: resolvedCountryCode || 'US',
                        weight: chargeableWeight || weight || 1,
                        boxes: calculationBoxes || [],
                        tierMarkup: tierMarkup || 0.20,
                        tag: tierName || 'Silver',
                        orderNumber: req.body?.orderNumber || req.body?.order_number || req.body?.referenceId || req.body?.reference_id || null,
                        referenceId: req.body?.referenceId || req.body?.reference_id || req.body?.orderNumber || req.body?.order_number || null
                    });
                }
            } catch (err) {
                console.error('Willow Commerce Rate Error in quoteController:', err.message);
            }
            return willowRates;
        };

        // Execute all external carrier rate fetches in parallel
        const [speedboxRes, ukEconomyRes, willowRes] = await Promise.allSettled([
            fetchSpeedboxRatesAsync(),
            fetchUKEconomyRatesAsync(),
            fetchWillowRatesAsync()
        ]);

        const externalRates = speedboxRes.status === 'fulfilled' ? speedboxRes.value : [];
        const ukEconomyRates = ukEconomyRes.status === 'fulfilled' ? ukEconomyRes.value : [];
        const willowRates = willowRes.status === 'fulfilled' ? willowRes.value : [];

        // --- Merge and Finalize ---
        const HEAVY_WEIGHT_LIMIT = 68;
        let allRates = [...internalRates, ...externalRates, ...ukEconomyRates, ...willowRates];

        // Global Carrier Toggles filtering
        try {
            const ukSvcConfig = await SystemConfig.findOne({ key: 'ukSvcEnabled' });
            let carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
            if (ukSvcConfig) {
                if (typeof ukSvcConfig.value === 'boolean') {
                    if (ukSvcConfig.value === true) {
                        carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
                    }
                } else if (typeof ukSvcConfig.value === 'object') {
                    carrierToggles = { ...carrierToggles, ...ukSvcConfig.value };
                }
            }

            const destCountryLower = (destination?.country || country || '').trim().toLowerCase();
            const destCodeLower = (destination?.countryCode || '').trim().toLowerCase();
            const destCountryUpper = (destination?.country || country || '').trim().toUpperCase();
            const destCodeUpper = (destination?.countryCode || '').trim().toUpperCase();

            const isUKDestination =
                destCountryLower === 'united kingdom' || destCountryUpper === 'UNITED KINGDOM' ||
                destCountryLower === 'uk' || destCountryUpper === 'UK' ||
                destCountryLower === 'gb' || destCountryUpper === 'GB' ||
                destCodeLower === 'gb' || destCodeUpper === 'GB' ||
                destCodeLower === 'uk' || destCodeUpper === 'UK';

            allRates = allRates.filter(r => {
                const prov = r.provider ? r.provider.toUpperCase() : null;
                if (isUKDestination && prov && carrierToggles.hasOwnProperty(prov)) {
                    return carrierToggles[prov] === true;
                }
                return true;
            });
        } catch (err) {
            return res.status(500).json({ message: 'Failed to load carrier configuration. Please try again.' });
        }

        // Global Deduplication by Service Name (Aggressive)
        const globalNameToBestRate = {};
        allRates.forEach(rate => {
            const normName = (rate.serviceName || '').trim().replace(/\s+/g, ' ');
            if (!globalNameToBestRate[normName] || rate.totalPrice < globalNameToBestRate[normName].totalPrice) {
                globalNameToBestRate[normName] = rate;
            }
        });
        allRates = Object.values(globalNameToBestRate);

        // STRICT RULE: If Chargeable Weight > 68kg, DO NOT SHOW RATES.
        if (chargeableWeight > HEAVY_WEIGHT_LIMIT) {
            allRates = [];
        }

        // Recalculate Best Value across ALL rates
        if (allRates.length > 0) {
            // Reset all first
            allRates.forEach(r => r.bestValue = false);
            // Find min price
            const minPrice = Math.min(...allRates.map(r => r.totalPrice));
        }

        if (allRates.length === 0) {
            // Trigger "No Rates" Alert (if not Heavy Weight - as that is handled above, but if heavy weight clears rates, we don't want double email?)
            // Heavy weight block sets allRates = [].
            // If heavy weight already sent email, we might duplicate.
            // Let's check logic: if chargeableWeight > limit, we sent email.
            // Here we check length === 0.
            // We should avoid double sending.
            if (chargeableWeight <= HEAVY_WEIGHT_LIMIT) {
                try {
                    const recipientEmail = process.env.CONTACT_EMAIL || 'sales@dflindia.in';
                    const subject = `ALERT: No Rates Available for query to ${country}`;
                    const html = `
                        <h3>No Rates Found Alert</h3>
                        <p>A user query resulted in zero available rates.</p>
                        <p><strong>Destination:</strong> ${country} (${resolvedCountryCode})</p>
                        <p><strong>Weight:</strong> ${weight} kg</p>
                        <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                        <br>
                        <pre>${JSON.stringify(req.body, null, 2)}</pre>
                    `;
                    let recipients = [recipientEmail];

                    // Try to identify user for No Rates email too
                    try {
                        let userForMail;
                        const User = require('../models/User'); // Ensure Model avail

                        if (req?.user?._id) {
                            userForMail = await User.findById(req.user._id).populate('assignedTo');
                        } else if (req?.body?.userId && req.body.userId !== 'guest') {
                            userForMail = await User.findById(req.body.userId).populate('assignedTo');
                        }

                        if (userForMail?.assignedTo?.email) {
                            recipients.push(userForMail.assignedTo.email);
                        }
                    } catch (err) {
                        console.error('Failed to fetch assigned user for no-rates alert email:', err);
                    }

                    await sendEmail({
                        email: recipients.join(','),
                        subject,
                        html,
                        from: "System Alert <noreply@dflindia.in>"
                    });
                } catch (alertErr) {
                    console.error('Failed to send no-rates alert email:', alertErr);
                }
            }
        }

        // --- SAVE QUERY LOGIC (Heavy Weight / Potential Abandonment) ---
        // We log it if it's "Heavy" (>68kg)

        if (chargeableWeight > HEAVY_WEIGHT_LIMIT) { // Use chargeableWeight validation
            let dbUser = null;
            try {
                // Try to identify user if logged in, but this route is Public
                // We depend on req.user (if middleware applied?) OR req.body.userId
                if (req?.user?._id) {
                    dbUser = req.user;
                    // If req.user is from middleware, it might not have assignedTo populated depending on auth middleware
                    // Safe to re-fetch or assume? Let's re-fetch if needed, or rely on populate strings
                    // Auth middleware typically doesn't populate references deeply due to perf.
                    // Let's ensure dbUser has assignedTo populated
                    if (!dbUser?.assignedTo?.email) {
                        dbUser = await User.findById(req.user._id).populate('assignedTo');
                    }
                } else if (req?.body?.userId && req.body.userId !== 'guest') {
                    dbUser = await User.findById(req.body.userId).populate('assignedTo');
                }

                await QuoteQuery.create({
                    user: dbUser?._id || null,
                    customerName: dbUser?.name || req?.body?.userName || 'Guest User',
                    customerId: dbUser?.customerId || 'GUEST',
                    email: dbUser?.email || req?.body?.userEmail || 'N/A',
                    phone: dbUser?.phone || 'N/A',
                    queryType: 'Heavy Weight',
                    origin: {
                        country: 'India' // Default
                    },
                    destination: {
                        country: country,
                        state: state,
                        pincode: pinCode
                    },
                    weightInfo: {
                        chargeableWeight: parseFloat(weight)
                    },
                    assignedTo: dbUser?.assignedTo || null,
                    status: 'New',
                    quotedPrice: allRates?.length > 0 ? Math.min(...allRates.map(r => r.totalPrice)) : 0
                });
            } catch (queryError) {
                console.error('Failed to save heavy weight quote query:', queryError);
            }

            // Trigger Email for Heavy Weight
            try {
                const recipientEmail = process.env.CONTACT_EMAIL || 'sales@dflindia.in';
                let recipients = [recipientEmail];
                if (dbUser?.assignedTo?.email) {
                    recipients.push(dbUser.assignedTo.email);
                }
                await sendEmail({
                    email: recipients.join(','),
                    subject: `ALERT: Heavy Weight Shipment Detected (${chargeableWeight}kg)`,
                    html: `
                        <h3>Heavy Weight Shipment Alert</h3>
                        <p>A user tried to quote a shipment exceeding the heavy weight limit (68kg).</p>
                        <p><strong>Weight:</strong> ${chargeableWeight} kg</p>
                        <p><strong>Origin:</strong> ${req?.body?.source?.country || 'India'}</p>
                        <p><strong>Destination:</strong> ${country} (${pinCode})</p>
                        <p><strong>User:</strong> ${req?.body?.userEmail || req?.body?.userName || 'Guest'}</p>
                    `
                });
            } catch (emailErr) {
                console.error('Failed to send heavy weight shipment alert email:', emailErr);
            }
        }

        res.status(200).json({
            success: true,
            data: {
                rates: allRates
            }
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};
// @desc    Log Heavy Weight Query (Auto)
// @route   POST /api/quotes/log-heavy
// @access  Public
exports.logHeavyWeightQuery = async (req, res) => {
    try {
        const { weight, country, state, pinCode, boxes } = req.body;

        try {
            let dbUser = null;
            if (req.user) dbUser = req.user;
            else if (req.body.userId && req.body.userId !== 'guest') {
                dbUser = await User.findById(req.body.userId);
            }

            await QuoteQuery.create({
                user: dbUser ? dbUser._id : null,
                customerName: dbUser ? dbUser.name : (req.body.userName || 'Guest User'),
                customerId: dbUser ? dbUser.customerId : 'GUEST',
                email: dbUser ? dbUser.email : (req.body.userEmail || 'N/A'),
                phone: dbUser ? dbUser.phone : 'N/A',
                queryType: 'Heavy Weight',
                origin: {
                    country: 'India' // Default
                },
                destination: {
                    country: country,
                    state: state,
                    pincode: pinCode
                },
                weightInfo: {
                    chargeableWeight: parseFloat(weight)
                },
                boxes: boxes || [],
                assignedTo: dbUser ? dbUser.assignedTo : null,
                status: 'New',
                quotedPrice: 0 // No price calculated
            });

            res.status(200).json({ success: true, message: 'Heavy weight query logged' });
        } catch (queryError) {
            res.status(500).json({ success: false, message: 'Failed to log query' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Report "No Rates Found" incident to Admin/Sales
// @route   POST /api/quotes/report-no-rates
// @access  Public
exports.reportNoRates = async (req, res) => {
    try {
        const { formData, userId } = req?.body || {};
        let user = req.user; // If authenticated via middleware
        // If not authenticated via middleware but userId passed (e.g. from frontend state)
        if (!user && userId && userId !== 'guest') {
            try {
                // Try finding by ID
                const userIdStr = String(userId);
                if (userIdStr.match(/^[0-9a-fA-F]{24}$/)) {
                    const User = require('../models/User'); // Ensure Model is available
                    user = await User.findById(userIdStr).select('-password').populate('assignedTo');
                    if (!user) {
                        console.warn(`No user found for no-rates report with userId ${userIdStr}`);
                    }
                } else {
                    console.warn(`Invalid userId supplied for no-rates report: ${userIdStr}`);
                }
            } catch (err) {
                console.error(`Failed to fetch user details for no-rates report with userId ${userId}:`, err);
            }
        }

        const generatedAt = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'full',
            timeStyle: 'medium'
        });

        // --- Calculate Chargeable Weight & Format Boxes ---
        let boxes = formData.boxes || [{ count: 1 }];
        // Ensure boxes is an array
        if (!Array.isArray(boxes)) boxes = [boxes];

        let totalActualWeight = 0;
        let totalVolumetricWeight = 0;
        let finalBoxes = [];

        boxes.forEach(box => {
            const length = parseFloat(box.length) || 0;
            const width = parseFloat(box.width) || 0;
            const height = parseFloat(box.height) || 0;
            const weight = parseFloat(box.weight) || 0;
            const count = parseInt(box.count) || 1;

            // Calculate Box Volumetric: (L*W*H)/5000
            const volWeight = ((length * width * height) / 5000);

            // Add to totals (multiply by count if necessary, but typically boxes array has individual entries or count property)
            // Assuming simplified structure where each entry is a box type
            totalActualWeight += weight * count;
            totalVolumetricWeight += volWeight * count;

            finalBoxes.push({
                length,
                width,
                height,
                count
            });
        });

        // Chargeable Weight logic: Max of Total Actual vs Total Volumetric
        const chargeableWeight = Math.max(totalActualWeight, totalVolumetricWeight);

        // Fallback if no boxes data but total weight is provided
        const finalChargeableWeight = chargeableWeight > 0 ? chargeableWeight : (parseFloat(formData.weight) || 0);

        // Construct HTML Message for Email
        const message = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1a1a1a; background-color: #f4f4f4; margin: 0; padding: 0; }
                    .container { max-width: 650px; margin: 30px auto; background-color: #ffffff; border: 1px solid #dcdcdc; border-radius: 4px; overflow: hidden; }
                    .header { background-color: #f59e0b; color: #ffffff; padding: 25px; border-bottom: 4px solid #b45309; }
                    .header h2 { margin: 0; font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
                    .header p { margin: 5px 0 0; font-size: 13px; opacity: 0.9; font-family: monospace; }
                    .content { padding: 30px; }
                    .section-title { font-size: 16px; font-weight: 700; color: #b45309; margin-bottom: 15px; text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 8px; }
                    .data-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
                    .data-table th, .data-table td { padding: 12px 15px; border: 1px solid #e0e0e0; text-align: left; }
                    .data-table th { background-color: #f9f9f9; color: #555; font-weight: 600; width: 40%; }
                    .data-table td { color: #333; font-weight: 500; }
                    .alert-box { background-color: #fff7ed; color: #9a3412; padding: 15px; border-radius: 4px; margin-bottom: 20px; border: 1px solid #fdba74; }
                    .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>No Rates Found Alert</h2>
                        <p>ID: ${Date.now()} | ${generatedAt}</p>
                    </div>
                    
                    <div class="content">
                        <div class="alert-box">
                            <strong>Attention:</strong> A user attempted to check rates but none were returned by the system.
                        </div>

                        <div class="section-title">Route & Cargo Details</div>
                        <table class="data-table">
                            <tr>
                                <th>Origin</th>
                                <td>${formData.fromCity || 'N/A'}, ${formData.fromCountry || 'N/A'}</td>
                            </tr>
                            <tr>
                                <th>Destination</th>
                                <td>${formData.toCity || 'N/A'}, ${formData.toCountry || 'IN'} (${formData.toPostcode || 'N/A'})</td>
                            </tr>
                            <tr>
                                <th>Details</th>
                                <td>
                                    <strong>Actual Wt:</strong> ${totalActualWeight.toFixed(2)} kg<br>
                                    <strong>Volumetric Wt:</strong> ${totalVolumetricWeight.toFixed(2)} kg<br>
                                    <strong>Chargeable Wt:</strong> ${finalChargeableWeight.toFixed(2)} kg
                                </td>
                            </tr>
                             <tr>
                                <th>Shipment Type</th>
                                <td>${formData.shipmentType || 'Parcel'}</td>
                            </tr>
                            <tr>
                                <th>Dimensions</th>
                                <td>
                                    ${finalBoxes.map((b, i) => `Box ${i + 1}: ${b.length}x${b.width}x${b.height} cm (Qty: ${b.count})`).join('<br>')}
                                </td>
                            </tr>
                        </table>

                         ${user ? `
                        <div class="section-title">Customer Details</div>
                        <table class="data-table">
                            <tr>
                                <th>Name</th>
                                <td>${user.name}</td>
                            </tr>
                            <tr>
                                <th>Email</th>
                                <td>${user.email}</td>
                            </tr>
                            <tr>
                                <th>Phone</th>
                                <td>${user.phone || 'N/A'}</td>
                            </tr>
                        </table>
                        ` : `
                         <div class="section-title">Customer Details</div>
                        <p>Guest User (No login details)</p>
                        `}
                    </div>

                    <div class="footer">
                        <p>&copy; ${new Date().getFullYear()} DFL Group. Automated System Message.</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Save to DB
        await QuoteQuery.create({
            user: user ? user._id : null,
            customerName: user ? user.name : 'Guest',
            customerId: user ? user.customerId : 'GUEST',
            email: user ? user.email : 'N/A',
            phone: user ? user.phone : 'N/A',
            queryType: 'No Rates Available',
            origin: {
                city: formData.fromCity,
                country: formData.fromCountry,
                pincode: formData.fromPostcode
            },
            destination: {
                city: formData.toCity,
                country: formData.toCountry,
                pincode: formData.toPostcode
            },
            weightInfo: {
                actualWeight: totalActualWeight,
                volumetricWeight: totalVolumetricWeight,
                chargeableWeight: finalChargeableWeight
            },
            boxes: finalBoxes,
            status: 'New',
            notes: [{
                text: 'Auto-generated when "No Rates Found" was displayed to user.',
                addedBy: null // System
            }]
        });

        // Send Email
        let recipients = ['sales@dflindia.in'];
        if (process.env.CONTACT_EMAIL) recipients = [process.env.CONTACT_EMAIL];

        if (user && user.assignedTo && user.assignedTo.email) {
            recipients.push(user.assignedTo.email);
        }

        await sendEmail({
            email: recipients.join(','), // Main sales email + Assigned Admin
            subject: `Alert: No Rates Found for ${finalChargeableWeight.toFixed(1)}kg to ${formData.toCountry}`,
            html: message
        });
        res.status(200).json({ success: true, message: 'Report submitted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
