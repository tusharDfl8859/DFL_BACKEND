const cron = require('node-cron');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const Shipment = require('../models/Shipment');
const Manifest = require('../models/Manifest');
const User = require('../models/User');
const PickupReportSnapshot = require('../models/PickupReportSnapshot');
const ReportRecipient = require('../models/ReportRecipient');
const sendEmail = require('../utils/emailService');
const {
    sendWhatsappTextMessage,
    uploadWhatsappMediaBuffer,
    sendWhatsappDocumentByMediaId,
    sendTemplateMessage
} = require('../services/whatsappService');
const { getWhatsappConfig } = require('../config/whatsappConfig');
const logger = require('../utils/logger');

// Lock to prevent overlapping execution runs
let isRunning = {
    '9:30_AM': false,
    '1:30_PM': false,
    '7:30_PM': false
};

/**
 * Robust helper to extract dimensions and package weight from shipment object
 */
const getBoxDetails = (ship) => {
    let boxSize = 'N/A';
    let weight = 'N/A';

    // 1. Try to read from boxes array
    const box = ship.shipmentDetails?.boxes?.[0];
    if (box) {
        const length = box.length || 10;
        const width = box.width || box.breadth || 10;
        const height = box.height || 10;
        boxSize = `${length}x${width}x${height} cm`;
        
        if (box.weight) {
            weight = `${box.weight} kg`;
        }
    } 
    // 2. Fallback to dimensions
    else if (ship.shipmentDetails?.dimensions) {
        const dim = ship.shipmentDetails.dimensions;
        const length = dim.length || 10;
        const width = dim.breadth || dim.width || 10;
        const height = dim.height || 10;
        boxSize = `${length}x${width}x${height} cm`;
    }

    // 3. Fallback for weight to packageWeight or chargeableWeight
    if (weight === 'N/A') {
        const pkgWeight = ship.shipmentDetails?.packageWeight || ship.serviceDetails?.chargeableWeight;
        if (pkgWeight) {
            weight = `${pkgWeight} kg`;
        }
    }

    return { boxSize, weight };
};

/**
 * Robust helper to extract details from Manifest object
 */
const getManifestDetails = (man) => {
    const manifestId = man.manifestId || 'N/A';
    const supplier = man.user?.companyName || man.user?.name || 'N/A';
    const address = man.pickupAddress || 'N/A';
    const phone = String(man.user?.mobile || man.user?.phone || man.user?.mobileNo || 'N/A').replace(/\D/g, '').slice(-10) || 'N/A';
    const packetCount = man.packetCount || man.shipments?.length || 0;
    const boxSize = `${packetCount} Pkts`;

    // Calculate sum of weights from shipments if populated
    let totalWeightKg = 0;
    if (man.shipments && Array.isArray(man.shipments)) {
        man.shipments.forEach(s => {
            const w = parseFloat(s.shipmentDetails?.packageWeight || s.serviceDetails?.chargeableWeight || s.shipmentDetails?.boxes?.[0]?.weight || 0);
            if (!isNaN(w) && w > 0) totalWeightKg += w;
        });
    }
    const weight = totalWeightKg > 0 ? `${totalWeightKg.toFixed(1)} kg` : 'N/A';
    const dateStr = man.date
        ? new Date(man.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
        : 'N/A';

    return {
        manifestId,
        supplier,
        address,
        phone,
        packetCount,
        boxSize,
        weight,
        dateStr
    };
};

/**
 * Returns date ranges adjusted to Asia/Kolkata (IST)
 * Uses deterministic UTC epoch math (+5:30 IST) to work accurately on AWS (UTC), Docker, or local environments.
 */
const getIndiaDateBounds = (referenceDate = new Date()) => {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30 in ms (19,800,000)
    const istTime = new Date(referenceDate.getTime() + IST_OFFSET_MS);

    const year = istTime.getUTCFullYear();
    const month = istTime.getUTCMonth();
    const date = istTime.getUTCDate();

    // Start of Today in IST (00:00:00.000 IST) converted to UTC
    const todayStart = new Date(Date.UTC(year, month, date, 0, 0, 0, 0) - IST_OFFSET_MS);
    // End of Today in IST (23:59:59.999 IST) converted to UTC
    const todayEnd = new Date(Date.UTC(year, month, date, 23, 59, 59, 999) - IST_OFFSET_MS);

    // Tomorrow bounds in IST converted to UTC
    const tomorrowStart = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    const tomorrowEnd = new Date(Date.UTC(year, month, date + 1, 23, 59, 59, 999) - IST_OFFSET_MS);

    // 9:30 AM IST today converted to UTC (04:00:00.000Z)
    const nineThirtyAMToday = new Date(Date.UTC(year, month, date, 9, 30, 0, 0) - IST_OFFSET_MS);
    // 1:30 PM IST today converted to UTC (08:00:00.000Z)
    const oneThirtyPMToday = new Date(Date.UTC(year, month, date, 13, 30, 0, 0) - IST_OFFSET_MS);

    return {
        todayStart,
        todayEnd,
        tomorrowStart,
        tomorrowEnd,
        nineThirtyAMToday,
        oneThirtyPMToday,
        nowUTC: referenceDate
    };
};

/**
 * Classifies a shipment into a region: DELHI_NCR, JAIPUR, or OTHERS
 */
const getShipmentRegion = (ship) => {
    const rawCity = String(ship.shipperDetails?.city || '').toLowerCase();
    const rawState = String(ship.shipperDetails?.state || '').toLowerCase();
    const rawLocation = String(ship.shipperDetails?.location || '').toLowerCase();
    const rawAddress = `${ship.shipperDetails?.addressLine1 || ''} ${ship.shipperDetails?.addressLine2 || ''}`.toLowerCase();
    const combined = `${rawCity} ${rawState} ${rawLocation} ${rawAddress}`;

    // Delhi NCR coverage: Delhi, New Delhi, Noida, Greater Noida, Gurgaon, Gurugram, Ghaziabad, Faridabad, Sahibabad
    if (/\b(delhi|new delhi|noida|greater noida|gurgaon|gurugram|ghaziabad|faridabad|sahibabad)\b/i.test(combined)) {
        return 'DELHI_NCR';
    }

    // Jaipur coverage
    if (/\b(jaipur)\b/i.test(combined)) {
        return 'JAIPUR';
    }

    return 'OTHERS';
};

/**
 * Groups an array of shipments into Delhi NCR, Jaipur, and Others (maintaining priority order)
 */
const groupShipmentsByRegion = (shipments = []) => {
    const delhiNcr = [];
    const jaipur = [];
    const others = [];

    shipments.forEach((ship) => {
        const region = getShipmentRegion(ship);
        if (region === 'DELHI_NCR') {
            delhiNcr.push(ship);
        } else if (region === 'JAIPUR') {
            jaipur.push(ship);
        } else {
            others.push(ship);
        }
    });

    return {
        delhiNcr,
        jaipur,
        others,
        total: shipments.length
    };
};

/**
 * Classifies a manifest into a region: DELHI_NCR, JAIPUR, or OTHERS
 */
const getManifestRegion = (man) => {
    const rawAddress = String(man.pickupAddress || '').toLowerCase();
    if (/\b(delhi|new delhi|noida|greater noida|gurgaon|gurugram|ghaziabad|faridabad|sahibabad)\b/i.test(rawAddress)) {
        return 'DELHI_NCR';
    }
    if (/\b(jaipur)\b/i.test(rawAddress)) {
        return 'JAIPUR';
    }
    return 'OTHERS';
};

/**
 * Groups an array of manifests into Delhi NCR, Jaipur, and Others
 */
const groupManifestsByRegion = (manifests = []) => {
    const delhiNcr = [];
    const jaipur = [];
    const others = [];

    manifests.forEach((man) => {
        const region = getManifestRegion(man);
        if (region === 'DELHI_NCR') {
            delhiNcr.push(man);
        } else if (region === 'JAIPUR') {
            jaipur.push(man);
        } else {
            others.push(man);
        }
    });

    return {
        delhiNcr,
        jaipur,
        others,
        total: manifests.length
    };
};

/**
 * Maps numbers to emojis for Hindi WhatsApp format
 */
const getNumberEmoji = (num) => {
    const map = {
        1: '1️⃣', 2: '2️⃣', 3: '3️⃣', 4: '4️⃣', 5: '5️⃣', 6: '6️⃣', 7: '7️⃣', 8: '8️⃣', 9: '9️⃣', 10: '🔟'
    };
    return map[num] || `*${num}.*`;
};

const regularHindiFont = path.join(__dirname, '../fonts/Mukta-Regular.ttf');
const boldHindiFont = path.join(__dirname, '../fonts/Mukta-Bold.ttf');

/**
 * Draws a table for a regional sub-section inside the PDFkit document
 */
const drawSectionTable = (doc, title, shipments, startY, isHindi = false, headerBg = '#0F172A') => {
    if (!shipments || shipments.length === 0) return startY;

    let y = startY;
    const hasHindiFont = isHindi && fs.existsSync(regularHindiFont) && fs.existsSync(boldHindiFont);
    const fontBold = hasHindiFont ? 'Hindi-Bold' : 'Helvetica-Bold';
    const fontReg = hasHindiFont ? 'Hindi-Regular' : 'Helvetica';

    // If starting too close to bottom (cannot fit title + table header + at least 1 row = ~60pt), start on fresh page
    if (y > 720) {
        doc.addPage();
        y = 40;
    }

    // Draw Section / Sub-region Header (Clean text without emojis)
    doc.font(fontBold).fontSize(9.5).fillColor('#1E293B').text(title, 40, y);
    y += 16;

    // Header Background
    doc.rect(40, y, 515, 18).fill(headerBg);
    doc.fillColor('#FFFFFF').font(fontBold).fontSize(7.5);

    // Write Header Columns
    if (isHindi) {
        doc.text('#', 45, y + 5, { width: 15 });
        doc.text('DFL ID', 60, y + 5, { width: 65 });
        doc.text('सप्लायर का नाम', 125, y + 5, { width: 85 });
        doc.text('पिकअप का पता', 210, y + 5, { width: 160 });
        doc.text('फ़ोन नंबर', 375, y + 5, { width: 60 });
        doc.text('बॉक्स साइज', 435, y + 5, { width: 50 });
        doc.text('वजन', 485, y + 5, { width: 30 });
        doc.text('तारीख', 515, y + 5, { width: 40 });
    } else {
        doc.text('#', 45, y + 5, { width: 15 });
        doc.text('DFL ID', 60, y + 5, { width: 65 });
        doc.text('Supplier Name', 125, y + 5, { width: 85 });
        doc.text('Pickup Address', 210, y + 5, { width: 160 });
        doc.text('Phone No.', 375, y + 5, { width: 60 });
        doc.text('Box Size', 435, y + 5, { width: 50 });
        doc.text('Weight', 485, y + 5, { width: 30 });
        doc.text('Date', 515, y + 5, { width: 40 });
    }

    y += 18;
    doc.font(fontReg).fontSize(7.5).fillColor('#334155');

    shipments.forEach((ship, idx) => {
        const dflId = ship.shipmentId || 'N/A';
        const supplier = ship.shipperDetails?.companyName || ship.shipperDetails?.shipperName || 'N/A';
        const address = [
            ship.shipperDetails?.addressLine1,
            ship.shipperDetails?.addressLine2,
            ship.shipperDetails?.city,
            ship.shipperDetails?.state,
            ship.shipperDetails?.pincode
        ].filter(Boolean).join(', ') || 'N/A';
        const phone = ship.shipperDetails?.mobileNo || 'N/A';
        const { boxSize, weight } = getBoxDetails(ship);
        const dateStr = ship.shipperDetails?.date
            ? new Date(ship.shipperDetails.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
            : 'N/A';

        // Calculate heights dynamically for address wrap
        const addressHeight = doc.heightOfString(address, { width: 160 });
        const rowHeight = Math.max(18, addressHeight + 6);

        // Auto-page wrap if bottom limit is reached before drawing this row
        if (y + rowHeight > 780) {
            doc.addPage();
            y = 40;
            doc.rect(40, y, 515, 18).fill(headerBg);
            doc.fillColor('#FFFFFF').font(fontBold).fontSize(7.5);
            if (isHindi) {
                doc.text('#', 45, y + 5, { width: 15 });
                doc.text('DFL ID', 60, y + 5, { width: 65 });
                doc.text('सप्लायर का नाम', 125, y + 5, { width: 85 });
                doc.text('पिकअप का पता', 210, y + 5, { width: 160 });
                doc.text('फ़ोन नंबर', 375, y + 5, { width: 60 });
                doc.text('बॉक्स साइज', 435, y + 5, { width: 50 });
                doc.text('वजन', 485, y + 5, { width: 30 });
                doc.text('तारीख', 515, y + 5, { width: 40 });
            } else {
                doc.text('#', 45, y + 5, { width: 15 });
                doc.text('DFL ID', 60, y + 5, { width: 65 });
                doc.text('Supplier Name', 125, y + 5, { width: 85 });
                doc.text('Pickup Address', 210, y + 5, { width: 160 });
                doc.text('Phone No.', 375, y + 5, { width: 60 });
                doc.text('Box Size', 435, y + 5, { width: 50 });
                doc.text('Weight', 485, y + 5, { width: 30 });
                doc.text('Date', 515, y + 5, { width: 40 });
            }
            y += 18;
            doc.font(fontReg).fontSize(7.5).fillColor('#334155');
        }

        // Draw Row borders
        doc.rect(40, y, 515, rowHeight).stroke('#E2E8F0');

        // Populate cells
        doc.text(String(idx + 1), 45, y + 4, { width: 15 });
        doc.text(dflId, 60, y + 4, { width: 65 });
        doc.text(supplier, 125, y + 4, { width: 85, height: rowHeight - 6, ellipsis: true });
        doc.text(address, 210, y + 4, { width: 160 });
        doc.text(phone, 375, y + 4, { width: 60 });
        doc.text(boxSize, 435, y + 4, { width: 50 });
        doc.text(weight, 485, y + 4, { width: 30 });
        doc.text(dateStr, 515, y + 4, { width: 40 });

        y += rowHeight;
    });

    return y + 14;
};

/**
 * Draws a major category section with regional sub-tables (Delhi NCR > Jaipur > Others)
 */
const drawCategorySection = (doc, mainTitle, shipments, startY, isHindi = false, categoryColor = '#0F172A') => {
    if (!shipments || shipments.length === 0) return startY;

    let y = startY;
    const hasHindiFont = isHindi && fs.existsSync(regularHindiFont) && fs.existsSync(boldHindiFont);
    const fontBold = hasHindiFont ? 'Hindi-Bold' : 'Helvetica-Bold';

    // Check if category header fits
    if (y > 700) {
        doc.addPage();
        y = 40;
    }

    // Main Category Title Banner
    doc.font(fontBold).fontSize(11).fillColor(categoryColor).text(mainTitle, 40, y);
    y += 16;
    doc.rect(40, y, 515, 1.2).fill(categoryColor);
    y += 10;

    const { delhiNcr, jaipur, others } = groupShipmentsByRegion(shipments);

    // 1. Delhi NCR Sub-section (First Priority)
    if (delhiNcr.length > 0) {
        const title = isHindi
            ? `• दिल्ली एनसीआर — Delhi NCR (${delhiNcr.length})`
            : `• Delhi NCR (${delhiNcr.length})`;
        y = drawSectionTable(doc, title, delhiNcr, y, isHindi, '#1E293B');
    }

    // 2. Jaipur Sub-section (Second Priority)
    if (jaipur.length > 0) {
        const title = isHindi
            ? `• जयपुर — Jaipur (${jaipur.length})`
            : `• Jaipur (${jaipur.length})`;
        y = drawSectionTable(doc, title, jaipur, y, isHindi, '#334155');
    }

    // 3. Other Locations Sub-section (Third Priority)
    if (others.length > 0) {
        const title = isHindi
            ? `• अन्य क्षेत्र — Other Locations (${others.length})`
            : `• Other Locations (${others.length})`;
        y = drawSectionTable(doc, title, others, y, isHindi, '#475569');
    }

    return y + 8;
};

/**
 * Draws a table for Manifests regional sub-section inside the PDFkit document
 */
const drawManifestSectionTable = (doc, title, manifests, startY, isHindi = false, headerBg = '#0F172A') => {
    if (!manifests || manifests.length === 0) return startY;

    let y = startY;
    const hasHindiFont = isHindi && fs.existsSync(regularHindiFont) && fs.existsSync(boldHindiFont);
    const fontBold = hasHindiFont ? 'Hindi-Bold' : 'Helvetica-Bold';
    const fontReg = hasHindiFont ? 'Hindi-Regular' : 'Helvetica';

    if (y > 720) {
        doc.addPage();
        y = 40;
    }

    doc.font(fontBold).fontSize(9.5).fillColor('#1E293B').text(title, 40, y);
    y += 16;

    // Header Background
    doc.rect(40, y, 515, 18).fill(headerBg);
    doc.fillColor('#FFFFFF').font(fontBold).fontSize(7.5);

    if (isHindi) {
        doc.text('#', 45, y + 5, { width: 15 });
        doc.text('मेनिफेस्ट ID', 60, y + 5, { width: 75 });
        doc.text('सप्लायर का नाम', 135, y + 5, { width: 85 });
        doc.text('पिकअप का पता', 220, y + 5, { width: 155 });
        doc.text('फ़ोन नंबर', 375, y + 5, { width: 60 });
        doc.text('पैकेट्स', 435, y + 5, { width: 45 });
        doc.text('वजन', 480, y + 5, { width: 35 });
        doc.text('तारीख', 515, y + 5, { width: 40 });
    } else {
        doc.text('#', 45, y + 5, { width: 15 });
        doc.text('Manifest ID', 60, y + 5, { width: 75 });
        doc.text('Supplier Name', 135, y + 5, { width: 85 });
        doc.text('Pickup Address', 220, y + 5, { width: 155 });
        doc.text('Phone No.', 375, y + 5, { width: 60 });
        doc.text('Packets', 435, y + 5, { width: 45 });
        doc.text('Weight', 480, y + 5, { width: 35 });
        doc.text('Date', 515, y + 5, { width: 40 });
    }

    y += 18;
    doc.font(fontReg).fontSize(7.5).fillColor('#334155');

    manifests.forEach((man, idx) => {
        const { manifestId, supplier, address, phone, boxSize, weight, dateStr } = getManifestDetails(man);

        const addressHeight = doc.heightOfString(address, { width: 155 });
        const rowHeight = Math.max(18, addressHeight + 6);

        if (y + rowHeight > 780) {
            doc.addPage();
            y = 40;
            doc.rect(40, y, 515, 18).fill(headerBg);
            doc.fillColor('#FFFFFF').font(fontBold).fontSize(7.5);
            if (isHindi) {
                doc.text('#', 45, y + 5, { width: 15 });
                doc.text('मेनिफेस्ट ID', 60, y + 5, { width: 75 });
                doc.text('सप्लायर का नाम', 135, y + 5, { width: 85 });
                doc.text('पिकअप का पता', 220, y + 5, { width: 155 });
                doc.text('फ़ोन नंबर', 375, y + 5, { width: 60 });
                doc.text('पैकेट्स', 435, y + 5, { width: 45 });
                doc.text('वजन', 480, y + 5, { width: 35 });
                doc.text('तारीख', 515, y + 5, { width: 40 });
            } else {
                doc.text('#', 45, y + 5, { width: 15 });
                doc.text('Manifest ID', 60, y + 5, { width: 75 });
                doc.text('Supplier Name', 135, y + 5, { width: 85 });
                doc.text('Pickup Address', 220, y + 5, { width: 155 });
                doc.text('Phone No.', 375, y + 5, { width: 60 });
                doc.text('Packets', 435, y + 5, { width: 45 });
                doc.text('Weight', 480, y + 5, { width: 35 });
                doc.text('Date', 515, y + 5, { width: 40 });
            }
            y += 18;
            doc.font(fontReg).fontSize(7.5).fillColor('#334155');
        }

        doc.rect(40, y, 515, rowHeight).stroke('#E2E8F0');

        doc.text(String(idx + 1), 45, y + 4, { width: 15 });
        doc.text(manifestId, 60, y + 4, { width: 75 });
        doc.text(supplier, 135, y + 4, { width: 85, height: rowHeight - 6, ellipsis: true });
        doc.text(address, 220, y + 4, { width: 155 });
        doc.text(phone, 375, y + 4, { width: 60 });
        doc.text(boxSize, 435, y + 4, { width: 45 });
        doc.text(weight, 480, y + 4, { width: 35 });
        doc.text(dateStr, 515, y + 4, { width: 40 });

        y += rowHeight;
    });

    return y + 14;
};

/**
 * Draws a major category section for Manifests (Delhi NCR > Jaipur > Others)
 */
const drawManifestCategorySection = (doc, mainTitle, manifests, startY, isHindi = false, categoryColor = '#0F172A') => {
    if (!manifests || manifests.length === 0) return startY;

    let y = startY;
    const hasHindiFont = isHindi && fs.existsSync(regularHindiFont) && fs.existsSync(boldHindiFont);
    const fontBold = hasHindiFont ? 'Hindi-Bold' : 'Helvetica-Bold';

    if (y > 700) {
        doc.addPage();
        y = 40;
    }

    doc.font(fontBold).fontSize(11).fillColor(categoryColor).text(mainTitle, 40, y);
    y += 16;
    doc.rect(40, y, 515, 1.2).fill(categoryColor);
    y += 10;

    const { delhiNcr, jaipur, others } = groupManifestsByRegion(manifests);

    if (delhiNcr.length > 0) {
        const title = isHindi
            ? `• दिल्ली एनसीआर मेनिफेस्ट — Delhi NCR (${delhiNcr.length})`
            : `• Delhi NCR Manifests (${delhiNcr.length})`;
        y = drawManifestSectionTable(doc, title, delhiNcr, y, isHindi, '#1E293B');
    }

    if (jaipur.length > 0) {
        const title = isHindi
            ? `• जयपुर मेनिफेस्ट — Jaipur (${jaipur.length})`
            : `• Jaipur Manifests (${jaipur.length})`;
        y = drawManifestSectionTable(doc, title, jaipur, y, isHindi, '#334155');
    }

    if (others.length > 0) {
        const title = isHindi
            ? `• अन्य क्षेत्र मेनिफेस्ट — Other Locations (${others.length})`
            : `• Other Locations Manifests (${others.length})`;
        y = drawManifestSectionTable(doc, title, others, y, isHindi, '#475569');
    }

    return y + 8;
};

/**
 * Builds in-memory PDF buffer with support for English and Hindi rendering
 */
const generatePickupPdfBuffer = async ({
    isHindi = false,
    reportTitle,
    totalPendingCount,
    urgentShipments = [],
    newShipments = [],
    tomorrowShipments = [],
    futureShipments = [],
    urgentManifests = [],
    newManifests = [],
    tomorrowManifests = [],
    futureManifests = []
}) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const hasHindiFont = isHindi && fs.existsSync(regularHindiFont) && fs.existsSync(boldHindiFont);
        if (hasHindiFont) {
            doc.registerFont('Hindi-Regular', regularHindiFont);
            doc.registerFont('Hindi-Bold', boldHindiFont);
        }

        const fontBold = hasHindiFont ? 'Hindi-Bold' : 'Helvetica-Bold';
        const fontReg = hasHindiFont ? 'Hindi-Regular' : 'Helvetica';

        // Add Header Branding
        try {
            const logoPath = path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png');
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 40, 40, { width: 110 });
            } else {
                doc.font(fontBold).fontSize(16).fillColor('#0F172A').text('DFL GROUP', 40, 40);
            }
        } catch (err) {
            logger.warn(`[PickupReportWorker] Failed to load logo for PDF rendering: ${err.message}`);
            doc.font(fontBold).fontSize(16).fillColor('#0F172A').text('DFL GROUP', 40, 40);
        }

        const totalShipmentsCount = urgentShipments.length + newShipments.length + tomorrowShipments.length + futureShipments.length;
        const totalManifestsCount = urgentManifests.length + newManifests.length + tomorrowManifests.length + futureManifests.length;

        const titleText = isHindi ? 'दैनिक पिकअप रिपोर्ट' : 'PICKUP REPORT';
        const pendingLabel = isHindi 
            ? `कुल पेंडिंग: ${totalPendingCount} (${totalShipmentsCount} शिपमेंट्स + ${totalManifestsCount} मेनिफेस्ट)`
            : `Total Pending: ${totalPendingCount} (${totalShipmentsCount} Shipments + ${totalManifestsCount} Manifests)`;

        doc.font(fontBold).fontSize(13).fillColor('#0F172A').text(titleText, 260, 40, { align: 'right' });
        doc.font(fontReg).fontSize(8.5).fillColor('#475569').text(reportTitle, 260, 58, { align: 'right' });
        doc.font(fontBold).fontSize(8).fillColor('#DC2626').text(pendingLabel, 260, 72, { align: 'right' });

        doc.moveDown(2);
        doc.rect(40, doc.y, 515, 1.5).fill('#CBD5E1');
        doc.moveDown(1.2);

        let currentY = doc.y;

        const urgentTitle = isHindi ? 'अर्जेंट — लंबित पिकअप (URGENT Shipments)' : 'URGENT — Pending Shipments';
        const newTitle = isHindi ? 'नई बुकिंग्स (NEW Shipments)' : 'NEW Bookings';
        const tomorrowTitle = isHindi ? 'कल के पिकअप (TOMORROW Shipments)' : 'TOMORROW Shipments';
        const futureTitle = isHindi ? 'आगे के पिकअप (FUTURE Shipments)' : 'FUTURE Shipments';

        const urgentManifestTitle = isHindi ? 'लंबित मेनिफेस्ट पिकअप (URGENT Manifests)' : 'URGENT — Pending Manifests';
        const newManifestTitle = isHindi ? 'नई मेनिफेस्ट बुकिंग्स (NEW Manifests)' : 'NEW Manifest Bookings';
        const tomorrowManifestTitle = isHindi ? 'कल के मेनिफेस्ट पिकअप (TOMORROW Manifests)' : 'TOMORROW Manifests';
        const futureManifestTitle = isHindi ? 'आगे के मेनिफेस्ट पिकअप (FUTURE Manifests)' : 'FUTURE Manifests';

        // 1. Render Shipments
        if (urgentShipments.length > 0) {
            currentY = drawCategorySection(doc, urgentTitle, urgentShipments, currentY, isHindi, '#DC2626');
        }
        if (newShipments.length > 0) {
            currentY = drawCategorySection(doc, newTitle, newShipments, currentY, isHindi, '#2563EB');
        }
        if (tomorrowShipments.length > 0) {
            currentY = drawCategorySection(doc, tomorrowTitle, tomorrowShipments, currentY, isHindi, '#4F46E5');
        }
        if (futureShipments.length > 0) {
            currentY = drawCategorySection(doc, futureTitle, futureShipments, currentY, isHindi, '#0891B2');
        }

        // 2. Render Manifests
        if (urgentManifests.length > 0) {
            currentY = drawManifestCategorySection(doc, urgentManifestTitle, urgentManifests, currentY, isHindi, '#DC2626');
        }
        if (newManifests.length > 0) {
            currentY = drawManifestCategorySection(doc, newManifestTitle, newManifests, currentY, isHindi, '#2563EB');
        }
        if (tomorrowManifests.length > 0) {
            currentY = drawManifestCategorySection(doc, tomorrowManifestTitle, tomorrowManifests, currentY, isHindi, '#4F46E5');
        }
        if (futureManifests.length > 0) {
            currentY = drawManifestCategorySection(doc, futureManifestTitle, futureManifests, currentY, isHindi, '#0891B2');
        }

        // Page Numbers Footer
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.page.margins.bottom = 0; // Prevent PDFKit from auto-spawning empty pages
            const footerText = isHindi
                ? `Page ${i + 1} of ${range.count} • DFL दैनिक ऑपरेशन्स पिकअप रिपोर्ट`
                : `Page ${i + 1} of ${range.count} • DFL Logistics Management Operational Report`;
            doc.font(fontReg).fontSize(7.5).fillColor('#94A3B8').text(
                footerText,
                40, 810, { align: 'right', width: 515, lineBreak: false }
            );
        }

        doc.end();
    });
};

/**
 * Builds HTML table block for a regional list of shipments
 */
const buildHtmlTableBlock = (title, shipments, headerColor) => {
    if (!shipments || shipments.length === 0) return '';

    let html = `
        <div style="margin-top: 14px; margin-bottom: 16px;">
            <div style="font-weight: bold; font-size: 12px; color: ${headerColor}; margin-bottom: 6px; font-family: Helvetica, Arial, sans-serif;">
                ${title}
            </div>
            <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Helvetica, Arial, sans-serif; font-size: 11px; border: 1px solid #CBD5E1; color: #334155;">
                <tr style="background-color: ${headerColor}; color: white; text-align: left; font-weight: bold;">
                    <th style="width: 5%">#</th>
                    <th style="width: 15%">DFL ID</th>
                    <th style="width: 20%">Supplier Name</th>
                    <th style="width: 30%">Pickup Address</th>
                    <th style="width: 12%">Phone No.</th>
                    <th style="width: 10%">Box Size</th>
                    <th style="width: 8%">Weight</th>
                    <th style="width: 10%">Date</th>
                </tr>
    `;

    shipments.forEach((ship, idx) => {
        const dflId = ship.shipmentId || 'N/A';
        const supplier = ship.shipperDetails?.companyName || ship.shipperDetails?.shipperName || 'N/A';
        const address = [
            ship.shipperDetails?.addressLine1,
            ship.shipperDetails?.addressLine2,
            ship.shipperDetails?.city,
            ship.shipperDetails?.state,
            ship.shipperDetails?.pincode
        ].filter(Boolean).join(', ') || 'N/A';
        const phone = ship.shipperDetails?.mobileNo || 'N/A';
        const { boxSize, weight } = getBoxDetails(ship);
        const dateStr = ship.shipperDetails?.date
            ? new Date(ship.shipperDetails.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
            : 'N/A';

        html += `
            <tr style="background-color: ${idx % 2 === 0 ? '#F8FAFC' : '#FFFFFF'};">
                <td>${idx + 1}</td>
                <td style="font-weight: bold; color: #0F172A;">${dflId}</td>
                <td>${supplier}</td>
                <td>${address}</td>
                <td>${phone}</td>
                <td>${boxSize}</td>
                <td>${weight}</td>
                <td>${dateStr}</td>
            </tr>
        `;
    });

    html += `</table></div>`;
    return html;
};

/**
 * Builds HTML block for a major category of Shipments, subdivided by regions
 */
const buildHtmlCategoryBlock = (categoryTitle, shipments, headerColor) => {
    if (!shipments || shipments.length === 0) return '';

    const { delhiNcr, jaipur, others } = groupShipmentsByRegion(shipments);

    let html = `
        <div style="margin-top: 22px; padding-bottom: 12px; border-bottom: 2px solid #E2E8F0;">
            <h3 style="color: ${headerColor}; font-family: Helvetica, Arial, sans-serif; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">
                ${categoryTitle} (${shipments.length})
            </h3>
    `;

    if (delhiNcr.length > 0) {
        html += buildHtmlTableBlock(`📍 Delhi NCR (${delhiNcr.length})`, delhiNcr, '#1E293B');
    }
    if (jaipur.length > 0) {
        html += buildHtmlTableBlock(`📍 Jaipur (${jaipur.length})`, jaipur, '#334155');
    }
    if (others.length > 0) {
        html += buildHtmlTableBlock(`📍 Other Locations (${others.length})`, others, '#475569');
    }

    html += `</div>`;
    return html;
};

/**
 * Builds HTML table block for a regional list of Manifests
 */
const buildHtmlManifestTableBlock = (title, manifests, headerColor) => {
    if (!manifests || manifests.length === 0) return '';

    let html = `
        <div style="margin-top: 14px; margin-bottom: 16px;">
            <div style="font-weight: bold; font-size: 12px; color: ${headerColor}; margin-bottom: 6px; font-family: Helvetica, Arial, sans-serif;">
                ${title}
            </div>
            <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Helvetica, Arial, sans-serif; font-size: 11px; border: 1px solid #CBD5E1; color: #334155;">
                <tr style="background-color: ${headerColor}; color: white; text-align: left; font-weight: bold;">
                    <th style="width: 5%">#</th>
                    <th style="width: 18%">Manifest ID</th>
                    <th style="width: 20%">Customer Name</th>
                    <th style="width: 30%">Pickup Address</th>
                    <th style="width: 12%">Phone No.</th>
                    <th style="width: 10%">Packets</th>
                    <th style="width: 8%">Weight</th>
                    <th style="width: 10%">Date</th>
                </tr>
    `;

    manifests.forEach((man, idx) => {
        const { manifestId, supplier, address, phone, boxSize, weight, dateStr } = getManifestDetails(man);

        html += `
            <tr style="background-color: ${idx % 2 === 0 ? '#F8FAFC' : '#FFFFFF'};">
                <td>${idx + 1}</td>
                <td style="font-weight: bold; color: #0F172A;">${manifestId}</td>
                <td>${supplier}</td>
                <td>${address}</td>
                <td>${phone}</td>
                <td>${boxSize}</td>
                <td>${weight}</td>
                <td>${dateStr}</td>
            </tr>
        `;
    });

    html += `</table></div>`;
    return html;
};

/**
 * Builds HTML block for a major category of Manifests, subdivided by regions
 */
const buildHtmlManifestCategoryBlock = (categoryTitle, manifests, headerColor) => {
    if (!manifests || manifests.length === 0) return '';

    const { delhiNcr, jaipur, others } = groupManifestsByRegion(manifests);

    let html = `
        <div style="margin-top: 22px; padding-bottom: 12px; border-bottom: 2px solid #E2E8F0;">
            <h3 style="color: ${headerColor}; font-family: Helvetica, Arial, sans-serif; margin: 0 0 10px 0; font-size: 14px; font-weight: bold;">
                ${categoryTitle} (${manifests.length})
            </h3>
    `;

    if (delhiNcr.length > 0) {
        html += buildHtmlManifestTableBlock(`📍 Delhi NCR (${delhiNcr.length})`, delhiNcr, '#1E293B');
    }
    if (jaipur.length > 0) {
        html += buildHtmlManifestTableBlock(`📍 Jaipur (${jaipur.length})`, jaipur, '#334155');
    }
    if (others.length > 0) {
        html += buildHtmlManifestTableBlock(`📍 Other Locations (${others.length})`, others, '#475569');
    }

    html += `</div>`;
    return html;
};

/**
 * Builds concise Hindi WhatsApp document caption summary (strictly under 1024 chars for Meta API)
 */
const buildHindiWhatsappCaption = (reportTitle, totalPendingCount, categorizedShipments = {}, categorizedManifests = {}) => {
    const totalShipments = (categorizedShipments.urgent?.length || 0) + (categorizedShipments.new?.length || 0) + (categorizedShipments.tomorrow?.length || 0) + (categorizedShipments.future?.length || 0);
    const totalManifests = (categorizedManifests.urgent?.length || 0) + (categorizedManifests.new?.length || 0) + (categorizedManifests.tomorrow?.length || 0) + (categorizedManifests.future?.length || 0);

    let caption = `📦 *DFL ग्रुप — दैनिक पिकअप रिपोर्ट*\n`;
    caption += `🕐 *${reportTitle}*\n`;
    caption += `📌 *कुल पेंडिंग पिकअप:* ${totalPendingCount} (${totalShipments} शिपमेंट्स + ${totalManifests} मेनिफेस्ट)\n\n`;

    const formatCategoryLine = (label, list = [], manList = []) => {
        const sCount = list.length;
        const mCount = manList.length;
        if (sCount === 0 && mCount === 0) return `${label}: 0\n`;
        
        let line = `${label}: `;
        const parts = [];
        if (sCount > 0) parts.push(`${sCount} Shipments`);
        if (mCount > 0) parts.push(`${mCount} Manifests`);
        line += parts.join(' + ') + '\n';
        return line;
    };

    caption += `📊 *कैटेगरी अनुसार विवरण:*\n`;
    caption += formatCategoryLine(`🚨 *अर्जेंट (URGENT)*`, categorizedShipments.urgent, categorizedManifests.urgent);
    caption += formatCategoryLine(`📋 *नई बुकिंग्स (NEW)*`, categorizedShipments.new, categorizedManifests.new);
    caption += formatCategoryLine(`📅 *कल के पिकअप (TOMORROW)*`, categorizedShipments.tomorrow, categorizedManifests.tomorrow);
    caption += formatCategoryLine(`📦 *आगे के पिकअप (FUTURE)*`, categorizedShipments.future, categorizedManifests.future);

    caption += `\n📎 *विस्तृत जानकारी के लिए ऊपर दी गई PDF फाइल देखें।*\n`;
    caption += `(Delhi NCR ➡️ Jaipur ➡️ Other Locations क्रम में व्यवस्थित)`;

    return caption.trim();
};

/**
 * Main function to generate and dispatch reports for a specific cron trigger
 */
const runPickupReportJob = async (cronName) => {
    if (isRunning[cronName]) {
        logger.warn(`[PickupReportWorker] Job ${cronName} is already running. Skipping overlapping execution.`);
        return;
    }

    isRunning[cronName] = true;
    logger.info(`[PickupReportWorker] Starting pickup report job: ${cronName}`);

    try {
        const bounds = getIndiaDateBounds();
        const dateString = bounds.nowUTC.toLocaleString('en-IN', {
            day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata'
        });
        const dateSlug = bounds.nowUTC.toLocaleDateString('en-IN', {
            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata'
        }).replace(/\//g, '-');

        // 1. Fetch active dynamic recipients from MongoDB (with graceful fallback to .env)
        let recipientEmails = [];
        let recipientPhones = [];

        try {
            const activeEmailDocs = await ReportRecipient.find({ type: 'email', isActive: true }).lean();
            const activeWhatsappDocs = await ReportRecipient.find({ type: 'whatsapp', isActive: true }).lean();

            recipientEmails = activeEmailDocs.map(d => d.value.trim()).filter(Boolean);
            recipientPhones = activeWhatsappDocs.map(d => d.value.trim()).filter(Boolean);
        } catch (dbErr) {
            logger.error(`[PickupReportWorker] Error querying ReportRecipient collection: ${dbErr.message}`);
        }

        // Fallback to .env if DB query returned zero recipients (ensures zero disruption during rollout)
        if (recipientEmails.length === 0 && process.env.PICKUP_REPORT_EMAILS) {
            recipientEmails = process.env.PICKUP_REPORT_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
        }
        if (recipientPhones.length === 0 && process.env.PICKUP_REPORT_WHATSAPP_NUMBERS) {
            recipientPhones = process.env.PICKUP_REPORT_WHATSAPP_NUMBERS.split(',').map(p => p.trim()).filter(Boolean);
        }

        let urgentShipments = [];
        let newShipments = [];
        let tomorrowShipments = [];
        let futureShipments = [];

        let urgentManifests = [];
        let newManifests = [];
        let tomorrowManifests = [];
        let futureManifests = [];
        let reportTitle = '';

        const pendingStatus = { $in: ['Pending', 'pending', 'Processing', 'processing', 'PENDING', 'PROCESSING'] };
        const pickupTypeMatch = { $in: ['Pickup', 'pickup', 'PICKUP'] };

        const pendingManifestQuery = {
            pickupType: { $nin: ['Self-Drop', 'self-drop', 'Self Drop', 'self drop'] },
            pickupStatus: { $ne: 'Completed' },
            status: { $nin: ['Cancelled', 'cancelled', 'Completed', 'completed'] }
        };

        const manifestPopulate = [
            { path: 'user', select: 'name email companyName phone mobile mobileNo' },
            { path: 'shipments', select: 'shipmentId shipmentDetails serviceDetails' }
        ];

        if (cronName === '9:30_AM') {
            reportTitle = `9:30 AM Report | ${dateString}`;
            
            // 1. URGENT Shipments: Retrieve all pending/processing pickups up to today (including past overdue bookings)
            urgentShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $lte: bounds.todayEnd },
                createdAt: { $lt: bounds.todayStart }
            }).sort({ 'shipperDetails.date': 1 });

            // 2. NEW Shipments: Booked today before 9:30 AM and pending/processing
            newShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $lte: bounds.todayEnd },
                createdAt: { $gte: bounds.todayStart, $lte: bounds.nineThirtyAMToday }
            }).sort({ 'shipperDetails.date': 1 });

            // 3. URGENT Manifests
            urgentManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $lte: bounds.todayEnd },
                createdAt: { $lt: bounds.todayStart }
            }).populate(manifestPopulate).sort({ date: 1 });

            // 4. NEW Manifests
            newManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $lte: bounds.todayEnd },
                createdAt: { $gte: bounds.todayStart, $lte: bounds.nineThirtyAMToday }
            }).populate(manifestPopulate).sort({ date: 1 });

        } else if (cronName === '1:30_PM') {
            reportTitle = `1:30 PM Report | ${dateString}`;

            // 1. URGENT Shipments: All pending/processing pickups up to today (including past backlog)
            urgentShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $lte: bounds.todayEnd },
                createdAt: { $lt: bounds.todayStart }
            }).sort({ 'shipperDetails.date': 1 });

            // 2. NEW Shipments: Booked today between 9:30 AM and 1:30 PM
            newShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $lte: bounds.todayEnd },
                createdAt: { $gte: bounds.nineThirtyAMToday, $lte: bounds.oneThirtyPMToday }
            }).sort({ 'shipperDetails.date': 1 });

            // 3. URGENT Manifests
            urgentManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $lte: bounds.todayEnd },
                createdAt: { $lt: bounds.todayStart }
            }).populate(manifestPopulate).sort({ date: 1 });

            // 4. NEW Manifests
            newManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $lte: bounds.todayEnd },
                createdAt: { $gte: bounds.nineThirtyAMToday, $lte: bounds.oneThirtyPMToday }
            }).populate(manifestPopulate).sort({ date: 1 });

        } else if (cronName === '7:30_PM') {
            reportTitle = `7:30 PM Report | ${dateString}`;

            // 1. URGENT Shipments: All pending/processing pickups up to today (including past backlog)
            urgentShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $lte: bounds.todayEnd }
            }).sort({ 'shipperDetails.date': 1 });

            // 2. TOMORROW Shipments: Tomorrow's pending/processing bookings
            tomorrowShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $gte: bounds.tomorrowStart, $lte: bounds.tomorrowEnd }
            }).sort({ 'shipperDetails.date': 1 });

            // 3. FUTURE Shipments: After tomorrow's pending/processing bookings
            futureShipments = await Shipment.find({
                status: pendingStatus,
                'shipperDetails.pickupType': pickupTypeMatch,
                'shipperDetails.date': { $gt: bounds.tomorrowEnd }
            }).sort({ 'shipperDetails.date': 1 });

            // 4. URGENT Manifests
            urgentManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $lte: bounds.todayEnd }
            }).populate(manifestPopulate).sort({ date: 1 });

            // 5. TOMORROW Manifests
            tomorrowManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $gte: bounds.tomorrowStart, $lte: bounds.tomorrowEnd }
            }).populate(manifestPopulate).sort({ date: 1 });

            // 6. FUTURE Manifests
            futureManifests = await Manifest.find({
                ...pendingManifestQuery,
                date: { $gt: bounds.tomorrowEnd }
            }).populate(manifestPopulate).sort({ date: 1 });
        }

        const totalShipmentsCount = urgentShipments.length + newShipments.length + tomorrowShipments.length + futureShipments.length;
        const totalManifestsCount = urgentManifests.length + newManifests.length + tomorrowManifests.length + futureManifests.length;
        const totalPendingCount = totalShipmentsCount + totalManifestsCount;

        // Gracefully skip reporting if all sections are empty
        if (totalPendingCount === 0) {
            logger.info(`[PickupReportWorker] No pending shipments or manifests found for report: ${cronName}. Skipping notification delivery.`);
            
            // Save empty snapshot to maintain interval sequence chain
            const snapshot = await PickupReportSnapshot.create({
                cronName,
                shipmentIds: [],
                sentAt: new Date()
            });
            
            isRunning[cronName] = false;
            return {
                success: true,
                cronName,
                totalPendingCount: 0,
                shipmentsCount: 0,
                manifestsCount: 0,
                snapshotId: snapshot._id,
                message: 'No pending shipments or manifests found for this time slot.'
            };
        }

        // Keep track of all shipments in snapshot for next jobs
        const allShipmentIds = [
            ...urgentShipments.map(s => s._id),
            ...newShipments.map(s => s._id),
            ...tomorrowShipments.map(s => s._id),
            ...futureShipments.map(s => s._id)
        ];

        // 1. Build English PDF report buffer (For Email Dispatch)
        const englishPdfBuffer = await generatePickupPdfBuffer({
            isHindi: false,
            reportTitle,
            totalPendingCount,
            urgentShipments,
            newShipments,
            tomorrowShipments,
            futureShipments,
            urgentManifests,
            newManifests,
            tomorrowManifests,
            futureManifests
        });

        // 2. Build Hindi PDF report buffer (For WhatsApp Dispatch)
        const hindiPdfBuffer = await generatePickupPdfBuffer({
            isHindi: true,
            reportTitle: `${cronName.replace('_', ' ')} रिपोर्ट | ${dateString}`,
            totalPendingCount,
            urgentShipments,
            newShipments,
            tomorrowShipments,
            futureShipments,
            urgentManifests,
            newManifests,
            tomorrowManifests,
            futureManifests
        });

        // 3. Build English Email HTML layout
        let emailHtml = `
            <div style="font-family: Helvetica, Arial, sans-serif; max-width: 680px; margin: auto; padding: 25px; border: 1px solid #E2E8F0; border-radius: 12px; background-color: #F8FAFC; color: #334155;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #0F172A; margin: 0; font-size: 20px; font-weight: bold; border-bottom: 2px solid #E2E8F0; padding-bottom: 12px;">📦 DFL GROUP — Pickup Report</h2>
                </div>
                <div style="background-color: #FFFFFF; padding: 20px; border-radius: 8px; border: 1px solid #E2E8F0; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <p style="font-size: 14px; margin-top: 0; line-height: 1.5; color: #1E293B; font-weight: 600;">Dear Operations Team,</p>
                    <p style="font-size: 13.5px; line-height: 1.6; color: #475569;">
                        Attached is the scheduled pickup report. Please find the summarized status of pending shipments and consolidated manifests below for immediate operational action.
                    </p>
                    <div style="background-color: #F1F5F9; padding: 12px 16px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #0F172A;">
                        <span style="font-size: 13px; font-weight: bold; color: #1E293B;">🕒 Window: ${reportTitle}</span><br/>
                        <span style="font-size: 13px; font-weight: bold; color: #DC2626;">📌 Total Pending Pickups: ${totalPendingCount} (${totalShipmentsCount} Shipments + ${totalManifestsCount} Manifests)</span>
                    </div>

                    ${buildHtmlCategoryBlock('🚨 URGENT — Pending Shipments', urgentShipments, '#DC2626')}
                    ${buildHtmlCategoryBlock('📋 NEW Bookings', newShipments, '#2563EB')}
                    ${buildHtmlCategoryBlock('📅 TOMORROW Shipments', tomorrowShipments, '#4F46E5')}
                    ${buildHtmlCategoryBlock('📦 FUTURE Shipments', futureShipments, '#0891B2')}

                    ${buildHtmlManifestCategoryBlock('📦 URGENT — Pending Manifests', urgentManifests, '#DC2626')}
                    ${buildHtmlManifestCategoryBlock('📦 NEW Manifest Bookings', newManifests, '#2563EB')}
                    ${buildHtmlManifestCategoryBlock('📦 TOMORROW Manifests', tomorrowManifests, '#4F46E5')}
                    ${buildHtmlManifestCategoryBlock('📦 FUTURE Manifests', futureManifests, '#0891B2')}
                </div>
                <div style="margin-top: 25px; font-size: 11px; color: #94A3B8; text-align: center;">
                    This is an automated operational report generated by DFL Group logistics management backend.
                </div>
            </div>
        `;

        // 4. Compile concise Hindi WhatsApp notification caption with regional breakdown
        const whatsappText = buildHindiWhatsappCaption(
            reportTitle,
            totalPendingCount,
            {
                urgent: urgentShipments,
                new: newShipments,
                tomorrow: tomorrowShipments,
                future: futureShipments
            },
            {
                urgent: urgentManifests,
                new: newManifests,
                tomorrow: tomorrowManifests,
                future: futureManifests
            }
        );

        // 5. Dispatch Email Reports (English Email + English PDF)
        if (recipientEmails.length > 0) {
            try {
                await sendEmail({
                    email: recipientEmails,
                    subject: `[DFL Report] Pickup Automation: ${reportTitle}`,
                    html: emailHtml,
                    attachments: [{
                        filename: `DFL_Pickup_Report_${cronName}_${dateSlug}.pdf`,
                        content: englishPdfBuffer,
                        contentType: 'application/pdf'
                    }]
                });
                logger.info(`[PickupReportWorker] Email dispatched successfully to: ${recipientEmails.join(', ')}`);
            } catch (err) {
                logger.error(`[PickupReportWorker] Email dispatch failed:`, err.message);
            }
        } else {
            logger.warn(`[PickupReportWorker] Skipping email dispatch: PICKUP_REPORT_EMAILS variable is not defined.`);
        }

        // 6. Dispatch WhatsApp Notifications (Native In-Memory Hindi PDF Document with Text Fallback)
        if (recipientPhones.length > 0) {
            const hindiReportFilename = `DFL_Hindi_Pickup_Report_${cronName}_${dateSlug}.pdf`;
            const config = getWhatsappConfig();
            const templateName = config.pickupReportTemplate || 'daily_pickup_report';
            const templateLanguage = config.pickupReportTemplateLanguage || 'hi';
            
            // Upload in-memory Hindi PDF buffer once to Meta Media API to reuse mediaId across all recipients
            const mediaUploadResult = await uploadWhatsappMediaBuffer({
                pdfBuffer: hindiPdfBuffer,
                filename: hindiReportFilename
            });

            if (mediaUploadResult.success && mediaUploadResult.mediaId) {
                logger.info(`[PickupReportWorker] PDF buffer uploaded to Meta. Media ID: ${mediaUploadResult.mediaId}. Dispatching approved Template PDF messages using template '${templateName}' (${templateLanguage})...`);

                for (const phone of recipientPhones) {
                    try {
                        const templateResult = await sendTemplateMessage({
                            phone,
                            templateName,
                            languageCode: templateLanguage,
                            headerDocument: {
                                id: mediaUploadResult.mediaId,
                                filename: hindiReportFilename
                            },
                            headerMediaId: mediaUploadResult.mediaId,
                            headerFilename: hindiReportFilename,
                            eventType: 'DAILY_PICKUP_REPORT',
                            bodyParameters: [
                                dateString,
                                cronName.replace('_', ' '),
                                String(totalPendingCount)
                            ]
                        });

                        if (templateResult.success) {
                            logger.info(`[PickupReportWorker] Template WhatsApp PDF report sent successfully to: ${phone}`);
                        } else {
                            logger.warn(`[PickupReportWorker] Template dispatch failed for ${phone} (${templateResult.reason || templateResult.error || templateResult.providerMessage || 'Unknown error'}). Trying direct document dispatch...`);

                            const docResult = await sendWhatsappDocumentByMediaId({
                                phone,
                                mediaId: mediaUploadResult.mediaId,
                                filename: hindiReportFilename,
                                caption: whatsappText
                            });
                            if (docResult.success) {
                                logger.info(`[PickupReportWorker] Direct WhatsApp PDF + summary message sent to: ${phone}`);
                            } else {
                                logger.warn(`[PickupReportWorker] Direct WhatsApp PDF dispatch failed for ${phone}:`, docResult.error || docResult.reason);
                                const textResult = await sendWhatsappTextMessage({ phone, text: whatsappText });
                                if (textResult.success) {
                                    logger.info(`[PickupReportWorker] Fallback text message sent to ${phone}`);
                                } else {
                                    logger.error(`[PickupReportWorker] Fallback text message failed for ${phone}:`, textResult.error || textResult.reason);
                                }
                            }
                        }
                    } catch (err) {
                        logger.error(`[PickupReportWorker] WhatsApp report dispatch exception for ${phone}:`, err.message);
                    }
                }
            } else {
                logger.warn(`[PickupReportWorker] Meta media upload failed (${mediaUploadResult.error}). Falling back to plain text WhatsApp dispatch.`);
                for (const phone of recipientPhones) {
                    try {
                        const result = await sendWhatsappTextMessage({ phone, text: whatsappText });
                        if (result.success) {
                            logger.info(`[PickupReportWorker] Fallback WhatsApp text notification sent to: ${phone}`);
                        } else {
                            logger.warn(`[PickupReportWorker] Fallback WhatsApp text notification failed for ${phone}:`, result.error || result.reason);
                        }
                    } catch (err) {
                        logger.error(`[PickupReportWorker] Fallback WhatsApp text exception for ${phone}:`, err.message);
                    }
                }
            }
        } else {
            logger.warn(`[PickupReportWorker] Skipping WhatsApp dispatch: No active WhatsApp recipients configured.`);
        }

        // 7. Save snapshot in database
        const snapshot = await PickupReportSnapshot.create({
            cronName,
            shipmentIds: allShipmentIds,
            sentAt: new Date()
        });
        logger.info(`[PickupReportWorker] Saved snapshot for ${cronName} containing ${allShipmentIds.length} shipments and ${totalManifestsCount} manifests.`);

        return {
            success: true,
            cronName,
            totalPendingCount,
            shipmentsCount: totalShipmentsCount,
            manifestsCount: totalManifestsCount,
            snapshotId: snapshot._id
        };

    } catch (error) {
        logger.error(`[PickupReportWorker] Error executing report job ${cronName}:`, error.message);
        return {
            success: false,
            cronName,
            error: error.message
        };
    } finally {
        isRunning[cronName] = false;
    }
};

/**
 * Auto-seeds recipients from .env if ReportRecipient collection is currently empty
 */
const autoSeedRecipientsFromEnv = async () => {
    try {
        const count = await ReportRecipient.countDocuments();
        if (count === 0) {
            const envEmails = (process.env.PICKUP_REPORT_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
            const envPhones = (process.env.PICKUP_REPORT_WHATSAPP_NUMBERS || '').split(',').map(p => p.trim()).filter(Boolean);

            const initialRecipients = [];
            envEmails.forEach((email) => {
                const namePart = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                initialRecipients.push({
                    name: namePart || 'Operations Email',
                    type: 'email',
                    value: email.toLowerCase(),
                    isActive: true
                });
            });

            envPhones.forEach((phone) => {
                const cleanPhone = phone.replace(/\D/g, '').slice(-10);
                if (cleanPhone.length === 10) {
                    initialRecipients.push({
                        name: `Operations (${cleanPhone.slice(-4)})`,
                        type: 'whatsapp',
                        value: cleanPhone,
                        isActive: true
                    });
                }
            });

            if (initialRecipients.length > 0) {
                await ReportRecipient.insertMany(initialRecipients, { ordered: false });
                logger.info(`[PickupReportWorker] Auto-seeded ${initialRecipients.length} report recipients from .env into DB.`);
            }
        }
    } catch (seedErr) {
        logger.warn(`[PickupReportWorker] Auto-seed recipients notice: ${seedErr.message}`);
    }
};

/**
 * Initializes the background schedules for the 3 daily times in Asia/Kolkata zone
 */
const setupPickupReportCron = () => {
    // Perform initial auto-seed check asynchronously on startup
    autoSeedRecipientsFromEnv();

    // 1. 9:30 AM IST
    cron.schedule('30 9 * * *', () => runPickupReportJob('9:30_AM'), {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // 2. 1:30 PM IST
    cron.schedule('30 13 * * *', () => runPickupReportJob('1:30_PM'), {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // 3. 7:30 PM IST
    cron.schedule('30 19 * * *', () => runPickupReportJob('7:30_PM'), {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    logger.info('[PickupReportWorker] Scheduled 3 daily pickup reports (9:30 AM, 1:30 PM, 7:30 PM) in Asia/Kolkata timezone.');
};

module.exports = {
    setupPickupReportCron,
    runPickupReportJob,
    autoSeedRecipientsFromEnv,
    getIndiaDateBounds,
    getShipmentRegion,
    groupShipmentsByRegion
};
