/**
 * Standalone WhatsApp Interactive Automation Bot Service
 * Manages Registered User Gate, Menu Navigation, State Machine, and Draft Booking Requests.
 * Zero-impact on existing web applications and carrier APIs.
 */

const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const DraftShipment = require('../models/DraftShipment');
const Ticket = require('../models/Ticket');
const Dispute = require('../models/Dispute');
const Transaction = require('../models/Transaction');
const WhatsappBotSession = require('../models/WhatsappBotSession');
const { sendWhatsappTextMessage } = require('./whatsappService');
const { generateDFLBrandedLabel } = require('../utils/labelGenerator');
const cacheService = require('../utils/cacheService');
const {
    getShipmentContext,
    getUserRecentShipmentsContext,
    calculateShippingRate,
    createSupportTicket
} = require('./chatbot/chatbotService');

/**
 * Format & normalize WhatsApp phone number for database lookup
 */
const normalizePhone = (rawPhone) => {
    if (!rawPhone) return '';
    const digits = String(rawPhone).replace(/[^\d]/g, '');
    if (!digits) return '';

    // Extract 10-digit national number if 91 prefix exists
    if (digits.length === 12 && digits.startsWith('91')) {
        return digits.slice(2);
    }
    return digits;
};

/**
 * Main Interactive WhatsApp Menu Template
 */
const buildMainMenuText = (userName) => {
    return `👋 *Welcome to DFL Group Logistics, ${userName}!*\n\n` +
        `How can I assist you today? Please reply with a number:\n\n` +
        `1️⃣ *Book Shipment* (Create Request)\n` +
        `2️⃣ *Track Shipment Status*\n` +
        `3️⃣ *Check Wallet Balance*\n` +
        `4️⃣ *Calculate Shipping Rate*\n` +
        `5️⃣ *Recharge DFL Wallet*\n` +
        `6️⃣ *Raise Dispute / Support*\n\n` +
        `_Reply with any number (1-6) or type "Menu" anytime!_`;
};

/**
 * Unregistered User Authentication Gate Response
 */
const buildUnregisteredUserResponse = (phone) => {
    const baseUrl = (process.env.FRONTEND_URL || 'https://express.thedflgroup.com').replace(/\/+$/, '');
    return `👋 *Welcome to DFL Group Logistics!*\n\n` +
        `⚠️ Your phone number (\`+${phone}\`) is not registered with DFL Group.\n\n` +
        `To book shipments, check wallet balance, or track orders, please register or login to your account:\n\n` +
        `🔗 *Register Account:*\n${baseUrl}/signup\n\n` +
        `🔑 *Login Portal:*\n${baseUrl}/login\n\n` +
        `_Once registered, reply "Hi" here to access your DFL Assistant!_`;
};

/**
 * Helper: Build Rich Shipment Tracking Details Response for WhatsApp
 */
const formatTrackingResponse = (d) => {
    let statusBadge = '📦 In Progress';
    const sLower = String(d.status || '').toLowerCase();
    if (sLower === 'pending') statusBadge = '⏳ Pending Verification / Pickup';
    else if (sLower === 'processing') statusBadge = '⚙️ Processing at Origin Hub';
    else if (sLower.includes('received at our hub') || sLower.includes('our hub')) statusBadge = '🏬 Arrived at DFL Origin Hub';
    else if (sLower.includes('dispatched') || sLower.includes('transit')) statusBadge = '✈️ In Transit (International Cargo)';
    else if (sLower.includes('destination hub') || sLower.includes('destination')) statusBadge = '🛬 Arrived at Destination Hub';
    else if (sLower.includes('out for delivery')) statusBadge = '🚚 Out for Delivery';
    else if (sLower === 'delivered' || sLower.includes('deliver')) statusBadge = '✅ Successfully Delivered';
    else if (sLower.includes('hold')) statusBadge = '⚠️ On Hold';
    else if (sLower.includes('cancel')) statusBadge = '❌ Cancelled';
    else if (sLower.includes('rto')) statusBadge = '↩️ Returned to Origin';

    let historyText = '';
    if (d.latestCheckpoint && d.latestCheckpoint.status) {
        const cpTime = d.latestCheckpoint.timestamp ? ` (${new Date(d.latestCheckpoint.timestamp).toLocaleDateString('en-IN')})` : '';
        const cpLoc = d.latestCheckpoint.location ? ` - ${d.latestCheckpoint.location}` : '';
        historyText = `\n\n📍 *Latest Milestone:* ${d.latestCheckpoint.status}${cpLoc}${cpTime}`;
        if (d.latestCheckpoint.description) {
            historyText += `\n   _${d.latestCheckpoint.description}_`;
        }
    }

    let holdText = '';
    if (d.holdReason) {
        holdText = `\n\n⚠️ *Reason for Hold:* ${d.holdReason}\n_(Our ops team is addressing this. Reply "6" to raise a priority dispute.)_`;
    }

    const carrierText = d.carrier ? `\n- *Carrier Service:* ${d.carrier}` : '';
    const consigneeText = d.consigneeName ? `\n- *Receiver:* ${d.consigneeName}` : '';
    const bookingDateText = d.bookingDate && d.bookingDate !== 'N/A' ? `\n- *Booked On:* ${d.bookingDate}` : '';

    return `📦 *Shipment Tracking Details*\n\n` +
        `🔖 *Shipment ID:* \`#${d.shipmentId}\`\n` +
        `🏷️ *AWB Number:* \`${d.awbNumber || d.shipmentId}\`\n` +
        `📊 *Status:* *${statusBadge}*` +
        holdText +
        historyText +
        `\n\n` +
        `- *Route:* ${d.origin} ➔ ${d.destination}` +
        carrierText +
        `\n- *Chargeable Weight:* ${d.weight}` +
        `\n- *Est. Transit:* ${d.transitTime}` +
        consigneeText +
        bookingDateText +
        `\n\n🔗 *Online Live Tracking:*\nhttps://express.thedflgroup.com/track?id=${d.shipmentId}\n\n` +
        `_Need help? Reply "6" to Raise Dispute / Support, or "Menu" for options._`;
};

/**
 * Helper: Parse Consignee Details from Natural WhatsApp Text Input
 */
const parseConsigneeInput = (text) => {
    const lines = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    const lower = text.toLowerCase();

    let country = 'United States';
    if (lower.includes('uk') || lower.includes('united kingdom') || lower.includes('london')) country = 'United Kingdom';
    else if (lower.includes('canada') || lower.includes('toronto')) country = 'Canada';
    else if (lower.includes('uae') || lower.includes('dubai') || lower.includes('emirates')) country = 'UAE';
    else if (lower.includes('australia') || lower.includes('sydney')) country = 'Australia';
    else if (lower.includes('germany') || lower.includes('berlin')) country = 'Germany';

    const phoneMatch = text.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\d{10}/);
    const phone = phoneMatch ? phoneMatch[0] : '';
    const name = lines[0] ? lines[0].replace(/name\s*:\s*/i, '') : 'Consignee Receiver';
    const address = lines.length > 1 ? lines.slice(1).join(', ') : text;

    return {
        consigneeName: name,
        mobileNo: phone || '+1 555-0199',
        addressLine1: address.slice(0, 100) || '120 Main Street',
        city: 'Destination City',
        state: 'Destination State',
        country: country,
        pincode: '10001'
    };
};

/**
 * Helper: Parse Package Specs from Natural WhatsApp Text Input
 */
const parsePackageInput = (text) => {
    const dimMatch = text.match(/(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)/i) ||
                     text.match(/(\d+(\.\d+)?)\s*\*\s*(\d+(\.\d+)?)\s*\*\s*(\d+(\.\d+)?)/i);

    let length = 20, width = 20, height = 15;
    let textWithoutDims = text;
    if (dimMatch) {
        length = parseFloat(dimMatch[1]);
        width = parseFloat(dimMatch[3]);
        height = parseFloat(dimMatch[5]);
        textWithoutDims = text.replace(dimMatch[0], '');
    }

    const weightMatch = textWithoutDims.match(/(\d+(\.\d+)?)\s*(kg|kilos|kilo)/i) || textWithoutDims.match(/(\d+(\.\d+)?)/);
    let weight = 1.0;
    if (weightMatch && parseFloat(weightMatch[1]) > 0) {
        weight = parseFloat(weightMatch[1]);
    }

    const lower = text.toLowerCase();
    let itemDesc = 'General Commercial Items / Garments';
    if (lower.includes('shirt') || lower.includes('cloth') || lower.includes('garment')) itemDesc = 'Cotton Apparel / Garments';
    else if (lower.includes('spice') || lower.includes('food')) itemDesc = 'Food Spices / Packaged Items';
    else if (lower.includes('document') || lower.includes('paper')) itemDesc = 'Personal Documents';

    return { length, width, height, weight, itemDesc };
};

/**
 * Process Incoming WhatsApp Text Message or Interactive Button Input
 */
const handleIncomingWhatsAppMessage = async (arg1, arg2) => {
    let fromPhone = '';
    let textMessage = '';
    let buttonPayload = null;

    if (typeof arg1 === 'object' && arg1 !== null) {
        fromPhone = arg1.fromPhone;
        textMessage = arg1.textMessage || '';
        buttonPayload = arg1.buttonPayload || null;
    } else {
        fromPhone = arg1;
        textMessage = arg2 || '';
    }

    if (!fromPhone) return;

    try {
        const rawDigits = String(fromPhone).replace(/[^\d]/g, '');
        const nationalPhone = normalizePhone(fromPhone);
        const incomingText = String(textMessage || buttonPayload || '').trim();
        const lowerText = incomingText.toLowerCase();

        // 1. Registered User Gate: Lookup User by Phone Number
        const user = await User.findOne({
            $or: [
                { phone: rawDigits },
                { phone: `+${rawDigits}` },
                { phone: nationalPhone },
                { phone: new RegExp(nationalPhone + '$') }
            ]
        }).select('name email phone customerId accountType walletBalance address kycVerified');

        // UNREGISTERED USER GATE: Block account operations & send registration links
        if (!user) {
            const gateMessage = buildUnregisteredUserResponse(rawDigits);
            await sendWhatsappTextMessage({ phone: fromPhone, text: gateMessage });
            return;
        }

        // 2. Load or Create Session State for Registered User
        let session = await WhatsappBotSession.findOne({ phone: rawDigits });
        if (!session) {
            session = await WhatsappBotSession.create({
                phone: rawDigits,
                user: user._id,
                state: 'IDLE',
                draftData: {}
            });
        }

        // Always reset to menu if user types "menu", "hi", "hello", "start", or "0"
        const isResetTrigger = ['menu', 'hi', 'hello', 'hey', 'start', '0', 'namaste', 'help'].includes(lowerText);
        if (isResetTrigger) {
            session.state = 'IDLE';
            session.draftData = {};
            await session.save();

            const menuText = buildMainMenuText(user.name);
            await sendWhatsappTextMessage({ phone: fromPhone, text: menuText });
            return;
        }

        // 3. Process State Machine & Menu Commands
        let replyText = '';

        if (session.state === 'IDLE') {
            if (incomingText === '1' || lowerText.includes('book')) {
                session.state = 'AWAITING_CONSIGNEE';
                session.draftData = {
                    shipper: {
                        shipperName: user.name,
                        mobileNo: user.phone || fromPhone,
                        email: user.email,
                        city: user.address?.city || 'Noida',
                        country: user.address?.country || 'India'
                    }
                };
                await session.save();

                replyText = `📦 *Step 1: Consignee (Receiver) Details*\n\n` +
                    `Your profile details have been set as the *Shipper (Sender)*.\n\n` +
                    `Please reply with the *Receiver's Info*:\n` +
                    `1. Receiver Name & Mobile Number\n` +
                    `2. Delivery Address & Pincode\n` +
                    `3. Destination Country (e.g. USA, UK, Canada, UAE)`;
            } else if (
                incomingText === '2' ||
                lowerText.includes('track') ||
                lowerText.includes('kahan hai') ||
                lowerText.includes('where is') ||
                /^#?DFL[A-Za-z0-9-]+$/i.test(incomingText.trim()) ||
                /^\d{8,22}$/.test(incomingText.trim())
            ) {
                const explicitAwbMatch = incomingText.match(/\b(DFL[A-Za-z0-9-]+|[0-9]{8,22})\b/i);

                if (explicitAwbMatch && !['2'].includes(incomingText.trim())) {
                    const targetId = explicitAwbMatch[0].replace(/^#/, '');
                    const trackingResult = await getShipmentContext(targetId, user._id);
                    if (trackingResult.success) {
                        session.state = 'IDLE';
                        session.draftData = {};
                        await session.save();
                        replyText = formatTrackingResponse(trackingResult.data);
                    } else {
                        session.state = 'AWAITING_TRACKING_AWB';
                        session.draftData = {};
                        await session.save();
                        replyText = `⚠️ *Shipment Not Found*\n\n` +
                            `We couldn't find any shipment matching \`${targetId}\`.\n\n` +
                            `Please check:\n` +
                            `• Ensure the AWB or Shipment ID is correct (e.g. \`DFL123456\`).\n` +
                            `• If booked recently, it may take 1-2 minutes to register.\n\n` +
                            `👉 Reply with your correct AWB number, or type *"Menu"* to view options.`;
                    }
                } else {
                    const recentBookings = await Shipment.find({ user: user._id })
                        .sort({ createdAt: -1 })
                        .limit(3)
                        .lean();

                    if (recentBookings && recentBookings.length > 0) {
                        session.state = 'AWAITING_TRACKING_AWB';
                        session.draftData = {
                            recentTrackingShipments: recentBookings.map((s, idx) => ({
                                index: idx + 1,
                                shipmentId: s.shipmentId,
                                awbNumber: s.awbNumber || s.trackingId || null
                            }))
                        };
                        await session.save();

                        const listText = recentBookings.map((s, idx) => {
                            const awbStr = (s.awbNumber || s.trackingId) ? ` (AWB: \`${s.awbNumber || s.trackingId}\`)` : '';
                            const receiver = s.consigneeDetails?.country || 'Destination';
                            const status = s.status || 'Pending';
                            return `${idx + 1}️⃣ *#${s.shipmentId}*${awbStr}\n   To: ${receiver} | Status: \`${status}\``;
                        }).join('\n\n');

                        replyText = `🔍 *Track Shipment*\n\n` +
                            `Here are your recent shipments:\n\n` +
                            `${listText}\n\n` +
                            `👉 *Reply with the number (e.g. 1, 2) or enter any AWB / Shipment ID to track.*\n` +
                            `_(Type "Menu" anytime to return)_`;
                    } else {
                        session.state = 'AWAITING_TRACKING_AWB';
                        session.draftData = {};
                        await session.save();

                        replyText = `🔍 *Track Shipment*\n\n` +
                            `Please reply with your *AWB Number* or *DFL Shipment ID* (e.g. \`DFL123456\`).\n\n` +
                            `_(Type "Menu" to return to options)_`;
                    }
                }
            } else if (incomingText === '3' || lowerText.includes('balance') || lowerText.includes('wallet')) {
                const formattedBalance = Number(user.walletBalance || 0).toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });

                let lastTxnText = '';
                try {
                    const latestTxn = await Transaction.findOne({ user: user._id })
                        .sort({ createdAt: -1 })
                        .lean();

                    if (latestTxn) {
                        const txnType = latestTxn.type === 'credit' ? '🟢 Credit (+)' : '🔴 Debit (-)';
                        const txnAmt = Math.abs(latestTxn.amount || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                        });
                        const txnDate = latestTxn.createdAt
                            ? new Date(latestTxn.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                            : 'Recent';

                        lastTxnText = `\n\n🕒 *Latest Transaction:*\n` +
                            `- *Type:* ${txnType} *₹${txnAmt}*\n` +
                            `- *Note:* ${latestTxn.description || 'Wallet Update'}\n` +
                            `- *Date:* ${txnDate}`;
                    }
                } catch (txnErr) {
                    // Non-blocking fallback
                }

                replyText = `💳 *Your DFL Wallet Details:*\n\n` +
                    `- *Account Holder:* ${user.name}\n` +
                    `- *Customer ID:* \`${user.customerId || 'N/A'}\`\n` +
                    `- *Current Balance:* *₹${formattedBalance} INR*` +
                    lastTxnText +
                    `\n\n👉 Reply *5* to *Recharge Wallet*\n` +
                    `👉 Or type *"Menu"* to view all options.`;
            } else if (incomingText === '4' || lowerText.includes('rate') || lowerText.includes('price')) {
                session.state = 'AWAITING_RATE_INFO';
                await session.save();

                replyText = `⚡ *Rate Calculator*\n\nPlease reply with package weight & destination country (e.g. \`2.5 kg USA\` or \`5 kg UK\`).`;
            } else if (incomingText === '5' || lowerText.includes('recharge') || lowerText.includes('topup')) {
                replyText = `💵 *DFL Wallet Top-Up Portal:*\n\n` +
                    `You can recharge your wallet securely via UPI / NetBanking / Cards here:\n\n` +
                    `🔗 https://express.thedflgroup.com/recharge\n\n` +
                    `_After payment, your wallet balance will update automatically in 1-2 minutes!_`;
            } else if (incomingText === '6' || lowerText.includes('ticket') || lowerText.includes('support') || lowerText.includes('dispute') || lowerText.includes('claim')) {
                // Check if user has any existing bookings
                const recentBookings = await Shipment.find({ user: user._id })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .lean();

                if (!recentBookings || recentBookings.length === 0) {
                    session.state = 'IDLE';
                    session.draftData = {};
                    await session.save();

                    replyText = `⚠️ *No Existing Bookings Found*\n\n` +
                        `Hello ${user.name}, you do not have any bookings in your DFL account yet.\n` +
                        `A dispute can only be raised against an existing shipment.\n\n` +
                        `Would you like to book a shipment?\n` +
                        `• Reply *1* to *Book Shipment*\n` +
                        `• Or type *"Menu"* to view all options.`;
                } else {
                    session.state = 'AWAITING_DISPUTE_SHIPMENT';
                    session.draftData = {
                        recentShipments: recentBookings.map((s, idx) => ({
                            index: idx + 1,
                            shipmentDbId: s._id.toString(),
                            shipmentId: s.shipmentId,
                            awbNumber: s.awbNumber || s.trackingId || null,
                            receiver: s.consigneeDetails?.name || 'Receiver',
                            country: s.consigneeDetails?.country || 'Destination',
                            status: s.status || 'Pending'
                        }))
                    };
                    await session.save();

                    const listText = recentBookings.map((s, idx) => {
                        const awbStr = (s.awbNumber || s.trackingId) ? ` (AWB: \`${s.awbNumber || s.trackingId}\`)` : '';
                        const receiver = s.consigneeDetails?.name || 'Receiver';
                        const country = s.consigneeDetails?.country || 'Destination';
                        const status = s.status || 'Pending';
                        return `${idx + 1}️⃣ *#${s.shipmentId}*${awbStr}\n   To: ${receiver} (${country}) | Status: \`${status}\``;
                    }).join('\n\n');

                    replyText = `⚖️ *Raise Shipment Dispute*\n\n` +
                        `Please select which booking you want to raise a dispute for:\n\n` +
                        `${listText}\n\n` +
                        `👉 *Reply with the number (e.g. 1, 2) or type your Shipment ID / AWB.*\n` +
                        `_(Type "Menu" anytime to cancel)_`;
                }
            } else {
                replyText = `I didn't quite catch that. Please reply with a number (1-6) or type *"Menu"* to view options!`;
            }
        }

        // STATE: AWAITING_CONSIGNEE (Draft Booking Collector Step 1)
        else if (session.state === 'AWAITING_CONSIGNEE') {
            const consignee = parseConsigneeInput(incomingText);
            session.draftData.consignee = consignee;
            session.state = 'AWAITING_PACKAGE';
            session.markModified('draftData');
            await session.save();

            replyText = `📌 *Receiver Details Recorded!*\n\n` +
                `- *Receiver:* ${consignee.consigneeName}\n` +
                `- *Phone:* ${consignee.mobileNo}\n` +
                `- *Destination:* ${consignee.country}\n\n` +
                `📦 *Step 2: Box & Item Specs*\n` +
                `Please reply with parcel details:\n` +
                `• Weight in kg (e.g. \`2 kg\`)\n` +
                `• Box Dimensions LxWxH cm (e.g. \`20x20x15 cm\`)\n` +
                `• Product Description (e.g. \`Garments / Apparel\`)`;
        }

        // STATE: AWAITING_PACKAGE (Step 2: Collect Box Specs -> Calculate Live Rates)
        else if (session.state === 'AWAITING_PACKAGE') {
            const pkg = parsePackageInput(incomingText);
            session.draftData.package = pkg;

            const destCountry = session.draftData?.consignee?.country || 'United States';
            const calcWeight = pkg.weight || 1;

            try {
                const rateResult = await calculateShippingRate(calcWeight, destCountry, user._id);
                const options = rateResult.options || [];

                if (options.length > 0) {
                    session.draftData.rateOptions = options;
                    session.state = 'AWAITING_BOOKING_SERVICE';
                    session.markModified('draftData');
                    await session.save();

                    const emojiIcons = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
                    const serviceList = options.map((opt, idx) => {
                        const icon = emojiIcons[idx] || `•`;
                        return `${icon} *${opt.serviceName}*\n   💵 Rate: *${opt.totalPriceFormatted}* (Base: ${opt.basePriceFormatted} + 18% GST)\n   ⏱️ Est. Transit: ${opt.transitDays}`;
                    }).join('\n\n');

                    replyText = `📦 *Box Specs Recorded!*\n` +
                        `- *Weight:* ${pkg.weight} kg (Volumetric: ${Math.max(pkg.weight, (pkg.length * pkg.width * pkg.height) / 5000).toFixed(2)} kg)\n` +
                        `- *Dimensions:* ${pkg.length}x${pkg.width}x${pkg.height} cm\n` +
                        `- *Items:* ${pkg.itemDesc}\n\n` +
                        `💰 *Select Shipping Service for ${destCountry}:*\n\n` +
                        `${serviceList}\n\n` +
                        `👉 *Reply with the number (e.g. 1, 2) to select your service & finalize booking!*\n` +
                        `_(Type "Menu" anytime to cancel)_`;
                } else {
                    throw new Error('No carrier options returned');
                }
            } catch (rateErr) {
                // Fallback service quote if external carriers return empty
                const fallbackBase = Math.round(calcWeight * 1850);
                const fallbackCost = Math.round(calcWeight * 1550);
                const fallbackMarkup = fallbackBase - fallbackCost;
                const fallbackGst = Math.round(fallbackBase * 0.18);
                const fallbackTotal = fallbackBase + fallbackGst;

                session.draftData.rateOptions = [
                    {
                        serviceName: 'DFL EXPRESS - Standard',
                        serviceCode: 'DFL-STD',
                        carrierName: 'DFL Express',
                        provider: 'DFL Express',
                        basePrice: fallbackBase,
                        cost: fallbackCost,
                        markup: fallbackMarkup,
                        gstAmount: fallbackGst,
                        totalPrice: fallbackTotal,
                        totalPriceFormatted: `₹${fallbackTotal.toLocaleString('en-IN')}`,
                        basePriceFormatted: `₹${fallbackBase.toLocaleString('en-IN')}`,
                        transitDays: '4 - 7 Business Days',
                        breakdown: { base: fallbackCost, markup: fallbackMarkup, gst: fallbackGst }
                    }
                ];
                session.state = 'AWAITING_BOOKING_SERVICE';
                session.markModified('draftData');
                await session.save();

                replyText = `📦 *Box Specs Recorded (${pkg.weight} kg to ${destCountry})!*\n\n` +
                    `1️⃣ *DFL EXPRESS - Standard*\n` +
                    `   💵 Rate: *₹${(Math.round(calcWeight * 1850 * 1.18)).toLocaleString('en-IN')}* (Base: ₹${(Math.round(calcWeight * 1850)).toLocaleString('en-IN')} + 18% GST)\n` +
                    `   ⏱️ Est. Transit: 4 - 7 Business Days\n\n` +
                    `👉 *Reply "1" to select service & confirm booking, or type "Menu" to cancel.*`;
            }
        }

        // STATE: AWAITING_BOOKING_SERVICE (Step 3: User Selects Service & Finalizes Draft Booking)
        else if (session.state === 'AWAITING_BOOKING_SERVICE') {
            const draft = session.draftData;
            const rateOptions = draft.rateOptions || [];
            const pkg = draft.package || { length: 20, width: 20, height: 15, weight: 1, itemDesc: 'Garments' };
            const consignee = draft.consignee || { consigneeName: 'Receiver', country: 'United States', addressLine1: '' };
            const volumetricWeight = Math.max(pkg.weight, (pkg.length * pkg.width * pkg.height) / 5000);

            let selectedService = null;
            const selectedNum = parseInt(incomingText.trim(), 10);

            if (!isNaN(selectedNum) && selectedNum >= 1 && selectedNum <= rateOptions.length) {
                selectedService = rateOptions[selectedNum - 1];
            } else {
                // Check if user replied with service name keyword
                selectedService = rateOptions.find(o => o.serviceName.toLowerCase().includes(incomingText.trim().toLowerCase()));
            }

            if (!selectedService) {
                replyText = `⚠️ Please reply with a valid service number (e.g. *1* to *${rateOptions.length}*) from the list above, or type *"Menu"* to cancel.`;
            } else {
                // Generate unique WhatsApp Draft Shipment ID
                const generatedShipmentId = `DFL-WA-${Date.now().toString().slice(-6)}`;

                try {
                    // 1. Create official DraftShipment record (visible in Admin Concierge Drafts & User Saved Drafts)
                    const newDraft = await DraftShipment.create({
                        user: user._id,
                        isConcierge: true,
                        bookingSource: 'WHATSAPP',
                        shipmentRefId: generatedShipmentId,
                        shipperDetails: {
                            shipperName: draft.shipper?.shipperName || user.name || 'Shipper',
                            companyName: draft.shipper?.companyName || user.companyName || 'Personal',
                            mobileNo: draft.shipper?.mobileNo || user.phone || fromPhone,
                            email: draft.shipper?.email || user.email || '',
                            city: draft.shipper?.city || user.address?.city || 'Noida',
                            state: user.address?.state || 'UP',
                            country: 'India',
                            countryCode: 'IN',
                            addressLine1: user.address?.street || 'Noida Warehouse',
                            pincode: user.address?.pincode || '201301',
                            date: new Date().toISOString().split('T')[0]
                        },
                        consigneeDetails: {
                            consigneeName: consignee.consigneeName || 'Consignee',
                            mobileNo: consignee.mobileNo || '',
                            addressLine1: consignee.addressLine1 || '',
                            city: consignee.city || 'Destination City',
                            state: consignee.state || '',
                            country: consignee.country || 'United States',
                            countryCode: consignee.countryCode || 'US',
                            pincode: consignee.pincode || '10001'
                        },
                        shipmentDetails: {
                            shipmentType: 'Parcel',
                            shipmentCategory: 'personal',
                            invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
                            invoiceDate: new Date(),
                            currency: consignee.country?.toLowerCase()?.includes('india') ? 'INR' : 'USD',
                            noOfBoxes: '1',
                            boxes: [
                                {
                                    length: String(pkg.length),
                                    width: String(pkg.width),
                                    height: String(pkg.height),
                                    weight: String(pkg.weight),
                                    actualWeight: String(pkg.weight),
                                    chargeableWeight: String(volumetricWeight.toFixed(2)),
                                    items: [
                                        {
                                            productName: pkg.itemDesc || 'Garments',
                                            quantity: '1',
                                            unitPrice: '1000'
                                        }
                                    ]
                                }
                            ]
                        },
                        savedRate: {
                            serviceName: selectedService.serviceName,
                            serviceCode: selectedService.serviceCode || selectedService.serviceName,
                            carrierCode: selectedService.carrierCode || 'DFL',
                            provider: selectedService.provider || (selectedService.serviceName.includes('Willow') ? 'Willow Commerce' : (selectedService.serviceName.includes('USPS') ? 'USPS' : 'DFL Express')),
                            price: selectedService.totalPrice,
                            basePrice: selectedService.basePrice,
                            cost: selectedService.cost,
                            markup: selectedService.markup,
                            gstAmount: selectedService.gstAmount,
                            eta: selectedService.transitDays || '4 - 7 Business Days',
                            chargeableWeight: volumetricWeight,
                            breakdown: selectedService.breakdown || {}
                        }
                    });

                    // Calculate accurate financial breakdown
                    const finalTotalPrice = parseFloat(selectedService.totalPrice) || 0;
                    const finalSubtotal = parseFloat(selectedService.basePrice) || (finalTotalPrice > 0 ? Math.round((finalTotalPrice / 1.18) * 100) / 100 : 0);
                    const finalGstAmount = parseFloat(selectedService.gstAmount) || Math.round((finalTotalPrice - finalSubtotal) * 100) / 100;
                    const finalCarrierCost = (selectedService.cost !== undefined && selectedService.cost !== null && !isNaN(parseFloat(selectedService.cost)))
                        ? parseFloat(selectedService.cost)
                        : Math.round(finalSubtotal * 0.85 * 100) / 100;
                    const finalMarkup = (selectedService.markup !== undefined && selectedService.markup !== null && !isNaN(parseFloat(selectedService.markup)))
                        ? parseFloat(selectedService.markup)
                        : Math.max(0, Math.round((finalSubtotal - finalCarrierCost) * 100) / 100);

                    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;

                    // 2. Create pending Shipment record so it can be monitored, tracked and booked by Admin
                    const newShipment = await Shipment.create({
                        shipmentId: generatedShipmentId,
                        user: user._id,
                        bookingSource: 'WHATSAPP',
                        status: 'Pending',
                        carrierBookingStatus: 'PENDING',
                        paymentMode: 'Wallet',
                        customerType: 'Regular',
                        bookedByType: 'User',
                        bookedById: user._id,
                        billingOwnerType: 'User',
                        billingOwnerId: user._id,
                        shipperDetails: {
                            shipperName: draft.shipper?.shipperName || user.name,
                            companyName: draft.shipper?.companyName || user.companyName || 'Personal',
                            mobileNo: draft.shipper?.mobileNo || user.phone || fromPhone,
                            email: draft.shipper?.email || user.email,
                            city: draft.shipper?.city || user.address?.city || 'Noida',
                            state: user.address?.state || 'UP',
                            country: 'India',
                            countryCode: 'IN',
                            addressLine1: user.address?.street || 'Noida Warehouse',
                            pincode: user.address?.pincode || '201301'
                        },
                        consigneeDetails: {
                            consigneeName: consignee.consigneeName || 'Consignee',
                            mobileNo: consignee.mobileNo || '',
                            addressLine1: consignee.addressLine1 || '',
                            city: consignee.city || 'Destination City',
                            state: consignee.state || '',
                            country: consignee.country || 'United States',
                            countryCode: consignee.countryCode || 'US',
                            pincode: consignee.pincode || '10001'
                        },
                        shipmentDetails: {
                            shipmentType: 'Parcel',
                            shipmentCategory: 'personal',
                            invoiceNumber: invoiceNumber,
                            invoiceDate: new Date(),
                            currency: consignee.country?.toLowerCase()?.includes('india') ? 'INR' : 'USD',
                            totalWeight: String(pkg.weight),
                            contentDescription: pkg.itemDesc || 'General Goods',
                            boxes: [
                                {
                                    length: String(pkg.length),
                                    width: String(pkg.width),
                                    height: String(pkg.height),
                                    actualWeight: String(pkg.weight),
                                    chargeableWeight: String(volumetricWeight.toFixed(2))
                                }
                            ]
                        },
                        serviceDetails: {
                            carrierName: selectedService.carrierName || (selectedService.serviceName.includes('Commerce') ? 'Willow Commerce' : (selectedService.serviceName.includes('USPS') ? 'USPS' : 'DFL Express')),
                            serviceName: selectedService.serviceName,
                            serviceCode: selectedService.serviceCode || selectedService.serviceName,
                            provider: selectedService.provider || (selectedService.serviceName.includes('Willow') ? 'Willow Commerce' : 'DFL Express'),
                            price: selectedService.totalPriceFormatted || `₹${finalTotalPrice}`,
                            cost: finalCarrierCost,
                            markup: finalMarkup,
                            handling: parseFloat(selectedService.handling) || 0,
                            countrySurcharge: parseFloat(selectedService.countrySurcharge) || 0,
                            fuelSurcharge: parseFloat(selectedService.fuelSurcharge) || 0,
                            dflCost: parseFloat(selectedService.dflCost) || finalCarrierCost,
                            igstTaxPercentage: '18',
                            chargeableWeight: String(volumetricWeight.toFixed(2)),
                            eta: selectedService.transitDays || '4 - 7 Business Days'
                        },
                        invoice: {
                            invoiceId: invoiceNumber,
                            invoiceDate: new Date(),
                            currency: consignee.country?.toLowerCase()?.includes('india') ? 'INR' : 'USD',
                            billedTo: {
                                name: draft.shipper?.shipperName || user.name || 'Customer',
                                companyName: draft.shipper?.companyName || user.companyName || 'Personal',
                                phone: draft.shipper?.mobileNo || user.phone || fromPhone,
                                email: draft.shipper?.email || user.email || ''
                            },
                            lineItems: [
                                {
                                    description: `Freight Charges - ${selectedService.serviceName}`,
                                    amount: finalSubtotal
                                }
                            ],
                            tax: {
                                type: 'IGST',
                                rate: 18,
                                amount: finalGstAmount
                            },
                            subtotal: finalSubtotal,
                            totalAmount: finalTotalPrice,
                            status: 'Draft'
                        },
                        trackingHistory: [
                            {
                                status: 'Pending',
                                location: 'Noida Hub',
                                timestamp: new Date(),
                                description: `Booking draft created via WhatsApp for ${selectedService.serviceName}`
                            }
                        ]
                    });

                    // 3. Generate DFL Shipping Label PDF and save to public/labels
                    let labelUrl = '';
                    try {
                        const pdfBuffer = await generateDFLBrandedLabel(newShipment.toObject ? newShipment.toObject() : newShipment);
                        if (pdfBuffer && pdfBuffer.length > 0) {
                            const labelsDir = path.join(__dirname, '../public/labels');
                            if (!fs.existsSync(labelsDir)) fs.mkdirSync(labelsDir, { recursive: true });
                            const fileName = `DFL_Label_${newShipment.shipmentId}.pdf`;
                            fs.writeFileSync(path.join(labelsDir, fileName), pdfBuffer);

                            const backendUrl = (process.env.BACKEND_URL || process.env.BASE_URL || 'https://api.thedflgroup.com').replace(/\/+$/, '');
                            labelUrl = `${backendUrl}/labels/${fileName}`;

                            newShipment.firstMileSticker = `/labels/${fileName}`;
                            newShipment.carrierLabelUrl = labelUrl;
                            newShipment.labelStatus = 'LABEL_READY';
                            await newShipment.save();
                        }
                    } catch (labelErr) {
                        console.warn('[WhatsAppBot] Label generation notice:', labelErr.message);
                    }

                    session.state = 'IDLE';
                    session.draftData = {};
                    await session.save();

                    replyText = `🎉 *Booking Request Confirmed & Saved in Drafts!*\n\n` +
                        `🔖 *Shipment ID:* \`#${newShipment.shipmentId}\`\n` +
                        `📑 *Draft Ref:* \`#${newDraft._id.toString().slice(-8).toUpperCase()}\`\n` +
                        `🚚 *Service Selected:* *${selectedService.serviceName}*\n` +
                        `💵 *Estimated Total:* *${selectedService.totalPriceFormatted}* (incl. 18% GST)\n` +
                        `👤 *Receiver:* ${newShipment.consigneeDetails.consigneeName} (${newShipment.consigneeDetails.city}, ${newShipment.consigneeDetails.country})\n` +
                        `⚖️ *Weight:* ${pkg.weight} kg (Chargeable: ${volumetricWeight.toFixed(2)} kg)\n` +
                        `📦 *Contents:* ${pkg.itemDesc || 'Garments'}\n` +
                        `📊 *Status:* *Draft / Pending Review*\n\n` +
                        (labelUrl ? `🏷️ *View/Download Shipping Label:*\n${labelUrl}\n\n` : '') +
                        `✅ *Next Steps:*\n` +
                        `1. Your shipment is saved under *Saved Drafts* & *Admin Concierge Drafts*.\n` +
                        `2. Admin can review and dispatch your booking directly from the panel.\n\n` +
                        `👉 Type *"Menu"* anytime for main options.`;
                } catch (saveErr) {
                    console.error('[WhatsAppBot] Error saving draft shipment:', saveErr.message);
                    session.state = 'IDLE';
                    session.draftData = {};
                    await session.save();
                    replyText = `Sorry, there was an issue saving your booking request. Please try again or type "Menu".`;
                }
            }
        }

        // STATE: AWAITING_TRACKING_AWB
        else if (session.state === 'AWAITING_TRACKING_AWB') {
            try {
                let targetId = null;
                const recentList = session.draftData?.recentTrackingShipments || [];

                // 1. Numeric selection (e.g. '1', '2', '3') from recent shipments list
                const selectedNum = parseInt(incomingText.trim(), 10);
                if (!isNaN(selectedNum) && selectedNum >= 1 && selectedNum <= recentList.length) {
                    targetId = recentList[selectedNum - 1].shipmentId;
                }

                // 2. Natural language query (e.g. "where is my parcel", "mera order", "status", "latest order", "kahan hai")
                if (!targetId) {
                    const isNaturalQuery = lowerText.includes('mera') ||
                        lowerText.includes('where') ||
                        lowerText.includes('latest') ||
                        lowerText.includes('recent') ||
                        lowerText.includes('status') ||
                        lowerText.includes('order') ||
                        lowerText.includes('parcel') ||
                        lowerText.includes('kahan') ||
                        lowerText.includes('last');

                    if (isNaturalQuery) {
                        const latestShipment = await Shipment.findOne({ user: user._id })
                            .sort({ createdAt: -1 })
                            .lean();

                        if (latestShipment) {
                            targetId = latestShipment.shipmentId;
                        } else {
                            session.state = 'IDLE';
                            session.draftData = {};
                            await session.save();

                            replyText = `⚠️ *No Shipments Found*\n\n` +
                                `Hello ${user.name}, you do not have any active shipments booked in your DFL account yet.\n\n` +
                                `• Reply *1* to *Book Shipment*\n` +
                                `• Or type *"Menu"* to view all options.`;
                        }
                    }
                }

                // 3. Direct AWB or Shipment ID input (e.g. "DFL40163000", "9234690373896507466746", "#DFL123")
                if (!targetId && !replyText) {
                    const cleaned = incomingText.trim().replace(/^#+/, '').replace(/\s+/g, '');
                    targetId = cleaned;
                }

                if (targetId && !replyText) {
                    const trackingResult = await getShipmentContext(targetId, user._id);

                    if (trackingResult.success) {
                        session.state = 'IDLE';
                        session.draftData = {};
                        await session.save();

                        replyText = formatTrackingResponse(trackingResult.data);
                    } else {
                        // Keep session in AWAITING_TRACKING_AWB so the user can re-try without typing 2 again
                        replyText = `⚠️ *Shipment Not Found*\n\n` +
                            `We couldn't find any shipment matching \`${targetId}\`.\n\n` +
                            `Please check:\n` +
                            `• Ensure the AWB or Shipment ID is correct (e.g. \`DFL123456\`).\n` +
                            `• If this booking was made recently, it may take 1-2 minutes to register.\n\n` +
                            `👉 Reply with your correct AWB number, or type *"Menu"* to return to main options.`;
                    }
                }
            } catch (trackErr) {
                session.state = 'IDLE';
                session.draftData = {};
                await session.save();
                replyText = `⚠️ Unable to fetch tracking status right now. Please try again or type "Menu".`;
            }
        }

        // STATE: AWAITING_RATE_INFO
        else if (session.state === 'AWAITING_RATE_INFO') {
            try {
                const weightMatch = incomingText.match(/(\d+(\.\d+)?)/);
                const weight = weightMatch ? weightMatch[1] : '1';
                const rateResult = await calculateShippingRate(weight, incomingText, user._id);

                session.state = 'IDLE';
                await session.save();

                replyText = `💰 *Live Shipping Rates for ${rateResult.destination} (${rateResult.weight}):*\n\n` +
                    `${rateResult.summaryText}\n\n` +
                    `_Rates include your account tier markup. Final charges depend on actual volumetric weight at pickup._\n\n` +
                    `👉 Reply *1* to *Book Shipment* or *"Menu"* for options.`;
            } catch (rateErr) {
                session.state = 'IDLE';
                await session.save();
                replyText = `⚠️ Unable to calculate shipping rate right now. Please try again or type "Menu".`;
            }
        }

        // STATE: AWAITING_TICKET_DESC
        else if (session.state === 'AWAITING_TICKET_DESC') {
            try {
                const ticketResult = await createSupportTicket('WhatsApp Support Escalation', incomingText, user._id);

                session.state = 'IDLE';
                await session.save();

                replyText = `🎫 *Support Ticket Created Successfully!*\n\n` +
                    `- *Ticket Number:* \`#${ticketResult.ticketNumber}\`\n` +
                    `Our DFL Ops team has been notified and will reach out to you shortly!`;
            } catch (ticketErr) {
                session.state = 'IDLE';
                await session.save();
                replyText = `🎫 Support query logged! Our team will contact you shortly. Type "Menu" for options.`;
            }
        }

        // STATE: AWAITING_DISPUTE_SHIPMENT (Dispute Step 1: Select Booking)
        else if (session.state === 'AWAITING_DISPUTE_SHIPMENT') {
            const recentShipments = session.draftData?.recentShipments || [];
            let matchedShipment = null;

            // 1. Check numeric selection (e.g. '1', '2', '3')
            const selectedNum = parseInt(incomingText, 10);
            if (!isNaN(selectedNum) && selectedNum >= 1 && selectedNum <= recentShipments.length) {
                matchedShipment = recentShipments[selectedNum - 1];
            } else {
                // 2. Check direct Shipment ID or AWB in list
                const cleanedInput = incomingText.replace(/^[#\s]+/, '').trim().toLowerCase();
                matchedShipment = recentShipments.find(s =>
                    s.shipmentId?.toLowerCase() === cleanedInput ||
                    (s.awbNumber && s.awbNumber.toLowerCase() === cleanedInput)
                );

                // 3. Fallback: Search MongoDB for older bookings beyond the top 5
                if (!matchedShipment) {
                    const exactDbShipment = await Shipment.findOne({
                        user: user._id,
                        $or: [
                            { shipmentId: new RegExp(`^${cleanedInput}$`, 'i') },
                            { awbNumber: new RegExp(`^${cleanedInput}$`, 'i') },
                            { trackingId: new RegExp(`^${cleanedInput}$`, 'i') }
                        ]
                    }).lean();

                    if (exactDbShipment) {
                        matchedShipment = {
                            shipmentDbId: exactDbShipment._id.toString(),
                            shipmentId: exactDbShipment.shipmentId,
                            awbNumber: exactDbShipment.awbNumber || exactDbShipment.trackingId || null,
                            receiver: exactDbShipment.consigneeDetails?.name || 'Receiver',
                            country: exactDbShipment.consigneeDetails?.country || 'Destination',
                            status: exactDbShipment.status || 'Pending'
                        };
                    }
                }
            }

            if (!matchedShipment) {
                replyText = `⚠️ Could not find a booking matching "${incomingText}".\n\n` +
                    `Please reply with a valid number from the list (e.g. *1*, *2*) or enter your exact *Shipment ID* (e.g. \`DFL123456\`).\n\n` +
                    `_Type "Menu" to return to options._`;
            } else {
                session.state = 'AWAITING_DISPUTE_REASON';
                session.draftData = {
                    ...session.draftData,
                    selectedShipment: matchedShipment
                };
                await session.save();

                const awbPart = matchedShipment.awbNumber ? `\n- *AWB:* \`${matchedShipment.awbNumber}\`` : '';
                replyText = `📌 *Booking Selected:*\n` +
                    `- *Shipment ID:* \`#${matchedShipment.shipmentId}\`${awbPart}\n` +
                    `- *Receiver:* ${matchedShipment.receiver} (${matchedShipment.country})\n` +
                    `- *Status:* \`${matchedShipment.status}\`\n\n` +
                    `📝 *Please describe your dispute / issue in detail:*\n` +
                    `• What is the issue? (e.g. Weight difference, Damaged package, Delay, Wrong billing)\n` +
                    `• Please provide as much detail as possible.\n\n` +
                    `👉 *Reply with your dispute explanation:*`;
            }
        }

        // STATE: AWAITING_DISPUTE_REASON (Dispute Step 2: Create Linked Dispute & Ticket in DB)
        else if (session.state === 'AWAITING_DISPUTE_REASON') {
            const selectedShipment = session.draftData?.selectedShipment;
            const shipmentId = selectedShipment?.shipmentId || 'GENERAL-QUERY';
            const shipmentDbId = selectedShipment?.shipmentDbId;

            try {
                // 1. Resolve Target Shipment in DB
                let targetShipment = null;
                if (shipmentDbId) {
                    targetShipment = await Shipment.findById(shipmentDbId);
                }
                if (!targetShipment && shipmentId !== 'GENERAL-QUERY') {
                    targetShipment = await Shipment.findOne({
                        $or: [
                            { shipmentId: shipmentId },
                            { trackingId: shipmentId },
                            { 'shipmentDetails.awbNumber': shipmentId }
                        ]
                    });
                }

                // 2. Classify Dispute Type based on user text input
                const textLower = incomingText.toLowerCase();
                let disputeType = 'Other Charges';
                if (textLower.includes('weight') || textLower.includes('dimension') || textLower.includes('heavy') || textLower.includes('volumetric') || textLower.includes('kg')) {
                    disputeType = 'Weight Difference';
                } else if (textLower.includes('rate') || textLower.includes('price') || textLower.includes('billing') || textLower.includes('cost') || textLower.includes('overcharge') || textLower.includes('charge')) {
                    disputeType = 'Rate Difference';
                }

                let createdDisputeId = null;

                // 3. Create Official Dispute Record in Dispute collection (if linked to shipment)
                if (targetShipment) {
                    const disputeData = {
                        shipment: targetShipment._id,
                        user: user._id,
                        raisedBy: user._id,
                        disputeType: disputeType,
                        amount: 0,
                        reason: incomingText,
                        remarks: `[WhatsApp Dispute] Raised by customer ${user.name} via WhatsApp (+${fromPhone})`,
                        status: 'Pending'
                    };

                    const newDispute = await Dispute.create(disputeData);
                    createdDisputeId = newDispute._id;

                    // 4. Update Shipment Status to 'Dispute Raised' & Append Tracking History
                    targetShipment.status = 'Dispute Raised';
                    if (!Array.isArray(targetShipment.trackingHistory)) {
                        targetShipment.trackingHistory = [];
                    }
                    targetShipment.trackingHistory.push({
                        status: 'Dispute Raised',
                        location: 'Customer Support',
                        timestamp: new Date(),
                        description: `Dispute raised via WhatsApp (${disputeType}): ${incomingText.slice(0, 150)}`
                    });
                    await targetShipment.save();

                    // Refresh Dashboard Stats Cache
                    cacheService.delPattern('dashboard_stats');
                }

                // 5. Create Linked Support Ticket in Ticket collection
                const newTicket = await Ticket.create({
                    user: user._id,
                    shipmentId: shipmentId,
                    issueType: 'Dispute',
                    priority: 'High',
                    description: incomingText,
                    status: 'Pending',
                    remarks: [
                        {
                            text: `[WhatsApp Dispute] Raised by customer ${user.name} via WhatsApp (+${fromPhone}) for booking #${shipmentId}. Dispute Type: ${disputeType}.`,
                            addedBy: user._id,
                            addedByName: `${user.name} (WhatsApp)`,
                            role: 'User',
                            type: 'status_update'
                        }
                    ]
                });

                session.state = 'IDLE';
                session.draftData = {};
                await session.save();

                replyText = `⚖️ *Dispute Registered Successfully!*\n\n` +
                    `- *Case / Ticket ID:* \`#${newTicket.ticketId}\`\n` +
                    (createdDisputeId ? `- *Dispute Ref:* \`#${createdDisputeId.toString().slice(-8).toUpperCase()}\`\n` : '') +
                    `- *Customer ID:* \`${user.customerId || 'N/A'}\`\n` +
                    `- *Booking ID:* \`#${shipmentId}\`\n` +
                    `- *Dispute Category:* *${disputeType}*\n` +
                    `- *Priority:* *High*\n` +
                    `- *Status:* *Dispute Raised (Pending Review)*\n\n` +
                    `✅ Your dispute is now active in your *Customer Dashboard* and *Admin Dispute Panel*.\n` +
                    `Our Operations & Dispute Resolution team will investigate and reach out to you on this WhatsApp number shortly!\n\n` +
                    `_Type "Menu" anytime for options._`;
            } catch (disputeErr) {
                console.error('[WhatsAppBot] Error registering dispute:', disputeErr.message);
                session.state = 'IDLE';
                session.draftData = {};
                await session.save();

                const fallback = await createSupportTicket(`Dispute for ${shipmentId}`, incomingText, user._id);
                replyText = `⚖️ *Dispute Logged!*\n\n` +
                    `- *Ticket ID:* \`#${fallback.ticketNumber}\`\n` +
                    `- *Booking ID:* \`#${shipmentId}\`\n\n` +
                    `Our team has been notified and will contact you shortly! Type "Menu" for options.`;
            }
        }

        // Send final reply back to WhatsApp User
        if (replyText) {
            console.log(`[WhatsAppBot] Outgoing to ${fromPhone}:\n${replyText}\n`);
            await sendWhatsappTextMessage({ phone: fromPhone, text: replyText });
        }
    } catch (globalBotErr) {
        try {
            await sendWhatsappTextMessage({
                phone: fromPhone,
                text: `⚠️ Sorry, something went wrong processing your message. Please type "Menu" to return to options.`
            });
        } catch (fallbackErr) {
            // Logged silently
        }
    }
};

module.exports = {
    handleIncomingWhatsAppMessage,
    handleIncomingWhatsappMessage: handleIncomingWhatsAppMessage,
    normalizePhone
};
