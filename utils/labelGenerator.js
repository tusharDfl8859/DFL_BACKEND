const axios = require('axios');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { extractTrackingId } = require('./trackingExtractor');
const path = require('path');
const fs = require('fs');

const generateDFLBrandedLabel = async (shipment) => {
    return new Promise(async (resolve, reject) => {
        try {


            // A6 Dimensions: 297.64 x 419.53 points
            const width = 297.64;
            const height = 419.53;
            const margin = 12;
            const contentWidth = width - (margin * 2);

            const doc = new PDFDocument({
                size: [width, height],
                margin: margin,
                autoFirstPage: true
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(buffers);
                resolve(pdfBuffer);
            });

            // --- STYLES ---
            const fontBold = 'Helvetica-Bold';
            const fontRegular = 'Helvetica';

            // --- 1. OUTER BORDER ---
            doc.lineWidth(1.5)
                .rect(margin, margin, contentWidth, height - (margin * 2))
                .stroke();

            // --- 2. HEADER SECTION (Logo & Branding) ---
            const headerHeight = 50; // Reduced from 60 to give more space below
            const logoPath = path.join(__dirname, '../public/assets/dfl_longo.png');

            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, margin + 5, margin + 5, { width: 80 });
            } else {
                doc.fontSize(24).font(fontBold).text('DFL', margin + 5, margin + 10);
            }

            // Destination Country Sort Box (Top Right)
            const rawCountry = (shipment.consigneeDetails.country || 'IN').toUpperCase();
            const countryMap = {
                'USA': 'US', 'UNITED STATES': 'US',
                'UK': 'GB', 'UNITED KINGDOM': 'GB',
                'UAE': 'AE', 'UNITED ARAB EMIRATES': 'AE'
            };
            const destCountry = countryMap[rawCountry] || (rawCountry.length > 2 ? rawCountry.substring(0, 2) : rawCountry);

            const sortBoxWidth = 45;
            const sortBoxHeight = 28;
            const sortBoxX = width - margin - sortBoxWidth - 5;
            const sortBoxY = margin + 5;

            doc.rect(sortBoxX, sortBoxY, sortBoxWidth, sortBoxHeight).fill('black');
            doc.fillColor('white')
                .fontSize(22)
                .font(fontBold)
                .text(destCountry, sortBoxX, sortBoxY + 4, { width: sortBoxWidth, align: 'center' });

            doc.fillColor('black'); // Reset color

            // Add Category Type (e.g. CSB-4 / CSB-5) right below the country box
            const category = shipment.shipmentDetails?.shipmentCategory ? shipment.shipmentDetails.shipmentCategory.toUpperCase() : '';
            if (category) {
                const formattedCategory = category.replace(/CSB(\d)/i, 'CSB-$1');
                doc.fontSize(10).font(fontBold).text(formattedCategory, sortBoxX, sortBoxY + sortBoxHeight + 2, { width: sortBoxWidth, align: 'center' });
            }

            // Horizontal Line below Header
            doc.moveTo(margin, margin + headerHeight).lineTo(width - margin, margin + headerHeight).lineWidth(0.5).stroke();

            // --- 3. ADDRESS SECTION ---
            const addressTop = margin + headerHeight + 5;
            const addressGap = 65;

            // FROM SECTION
            doc.fontSize(7).font(fontBold).text('FROM:', margin + 10, addressTop);
            doc.fontSize(8).font(fontRegular).text(
                `${shipment.shipperDetails.shipperName}\n` +
                `${shipment.shipperDetails.addressLine1}\n` +
                `${shipment.shipperDetails.addressLine2 ? shipment.shipperDetails.addressLine2 + '\n' : ''}` +
                `${shipment.shipperDetails.city}, ${shipment.shipperDetails.pincode}\n` +
                `${shipment.shipperDetails.country}\n` +
                `Tel: ${shipment.shipperDetails.mobileNo}`,
                margin + 10, addressTop + 10, { width: contentWidth - 20, lineGap: 1 }
            );

            // SHIP TO SECTION
            const toY = addressTop + addressGap;
            doc.rect(margin, toY - 5, contentWidth, 15).fill('#f1f5f9');
            doc.fillColor('black').fontSize(8).font(fontBold).text('SHIP TO:', margin + 10, toY);

            doc.fontSize(14).font(fontBold).text((shipment.consigneeDetails.consigneeName || 'Consignee').toUpperCase(), margin + 10, toY + 15);
            doc.fontSize(10).font(fontRegular).text(
                `${shipment.consigneeDetails.addressLine1}\n` +
                `${shipment.consigneeDetails.addressLine2 ? shipment.consigneeDetails.addressLine2 + '\n' : ''}` +
                `${shipment.consigneeDetails.city}, ${shipment.consigneeDetails.state || ''} ${shipment.consigneeDetails.pincode}\n` +
                `${shipment.consigneeDetails.country.toUpperCase()}`,
                margin + 10, toY + 32, { width: contentWidth - 20, lineGap: 2 }
            );

            // Contact Info
            doc.fontSize(8).font(fontBold).text(`TEL: ${shipment.consigneeDetails.mobileNo || 'N/A'}`, margin + 10, toY + 80);

            // Horizontal Line below Address
            doc.moveTo(margin, toY + 95).lineTo(width - margin, toY + 95).stroke();

            // --- 4. DETAILS GRID ---
            const gridTop = toY + 95;
            const gridHeight = 35;
            const colWidth = contentWidth / 3;

            // Vertical Dividers
            doc.moveTo(margin + colWidth, gridTop).lineTo(margin + colWidth, gridTop + gridHeight).stroke();
            doc.moveTo(margin + (colWidth * 2), gridTop).lineTo(margin + (colWidth * 2), gridTop + gridHeight).stroke();

            const drawGridItem = (label, value, x) => {
                doc.fontSize(6).font(fontBold).text(label, x, gridTop + 5, { width: colWidth, align: 'center' });
                doc.fontSize(9).font(fontRegular).text(value, x, gridTop + 18, { width: colWidth, align: 'center' });
            };

            const weight = (shipment.shipmentDetails?.boxes?.reduce((acc, b) => acc + parseFloat(b.weight || 0), 0) || 0).toFixed(2);
            const pieces = shipment.shipmentDetails?.boxes?.length || 1;

            drawGridItem('TOTAL WEIGHT', `${weight} KG`, margin);
            drawGridItem('PIECES', `1 / ${pieces}`, margin + colWidth);
            drawGridItem('DATE', new Date(shipment.createdAt || Date.now()).toLocaleDateString(), margin + (colWidth * 2));

            // Horizontal Line below Details
            doc.moveTo(margin, gridTop + gridHeight).lineTo(width - margin, gridTop + gridHeight).stroke();

            // --- 5. BARCODE SECTION ---
            const dflAwb = shipment.shipmentId;
            const carrierAwb = shipment.trackingId;
            const forwardingNo = shipment.lastMileAWB || carrierAwb;
            const barcodeTop = gridTop + gridHeight + 10;

            // Always Display Shipment ID
            doc.fontSize(8).font(fontBold).text(`Shipment ID: ${dflAwb}`, margin + 20, barcodeTop);

            // Display AWB and Forwarding No if available
            if (carrierAwb) {
                doc.text(`AWB No: ${carrierAwb}`, margin + 20, barcodeTop + 10);
                doc.text(`Forwarding No: ${forwardingNo}`, margin + 20, barcodeTop + 20);
            }

            const barcodeY = carrierAwb ? barcodeTop + 32 : barcodeTop + 12;

            try {
                const png = await new Promise((res, rej) => {
                    bwipjs.toBuffer({
                        bcid: 'code128',
                        text: carrierAwb || dflAwb,
                        scale: 3,
                        height: 15,
                        includetext: true,
                        textxalign: 'center',
                        textsize: 9
                    }, (err, png) => {
                        if (err) rej(err);
                        else res(png);
                    });
                });
                doc.image(png, margin + 20, barcodeY, { width: contentWidth - 40, height: 50 });
            } catch (err) {
                doc.fontSize(10).text('Barcode Generation Failed', margin + 10, barcodeY + 10);
            }

            // --- 6. FOOTER (Destination & Sorting) ---
            const barcodeBottom = barcodeY + 50;

            // Service Footer Box (e.g., UNI)
            const serviceBoxHeight = 32;

            // Ensure service box is below the barcode but above the bottom text
            const maxServiceBoxY = height - margin - serviceBoxHeight - 15;
            const serviceBoxY = Math.max(barcodeBottom + 5, maxServiceBoxY);

            // Fill a light gray background for the service code
            doc.save();
            doc.rect(margin, serviceBoxY, contentWidth, serviceBoxHeight).fill('#e2e8f0');
            doc.restore();

            // Shorten service code (e.g. "DFL EXPRESS - UNI" -> "UNI")
            let displayService = shipment.serviceDetails?.serviceCode || 'UNI';
            if (displayService.includes('-')) {
                displayService = displayService.split('-').pop().trim();
            }
            if (displayService.length > 10) displayService = 'UNI';

            doc.fillColor('black')
                .fontSize(16)
                .font(fontBold)
                .text(displayService, margin, serviceBoxY + 8, { width: contentWidth, align: 'center' });

            doc.fontSize(6).font(fontRegular).text(
                'This is an electronically generated DFL label. Non-Transferable.',
                margin, height - margin - 12, { width: contentWidth, align: 'center', lineBreak: false }
            );

            // --- 7. LAST MILE STICKER (PAGE 2) ---
            const lastMileUrl = shipment.lastMileSticker || shipment.carrierLabelUrl;
            if (lastMileUrl) {
                try {
                    const isPdf = lastMileUrl.toLowerCase().endsWith('.pdf') || lastMileUrl.toLowerCase().includes('label.pdf');
                    const response = await axios.get(lastMileUrl, { responseType: 'arraybuffer' });
                    const stickerBuffer = Buffer.from(response.data);

                    if (!isPdf) {
                        doc.addPage({ size: [width, height], margin: 0 });
                        doc.image(stickerBuffer, 0, 0, { width: width, height: height, fit: [width, height] });
                    } else {
                        console.warn(`Skipping PDF last-mile sticker attachment for shipment ${shipment?.shipmentId}.`);
                    }
                } catch (imgErr) {
                    console.warn(`Failed to attach last-mile sticker to label for shipment ${shipment?.shipmentId}:`, imgErr);
                }
            }

            doc.end();

        } catch (error) {
            reject(error);
        }
    }); // End Promise
};

const generate3rdPartyWillowLabel = async (shipment) => {
    return new Promise(async (resolve, reject) => {
        try {
            const width = 297.64;
            const height = 419.53;
            const margin = 12;
            const contentWidth = width - (margin * 2);

            const doc = new PDFDocument({
                size: [width, height],
                margin: margin,
                autoFirstPage: true
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });

            const fontBold = 'Helvetica-Bold';
            const fontRegular = 'Helvetica';

            const serviceName = shipment.serviceDetails?.serviceName || 'DFL Commerce Ground';
            const isUniUni = String(serviceName).toLowerCase().includes('uni');
            const carrierHeader = isUniUni ? 'UNIUNI STANDARD - 3RD PARTY' : 'USPS PARCEL SELECT - 3RD PARTY';
            const carrierId = shipment.serviceDetails?.carrierId || shipment.serviceDetails?.accountId || (isUniUni ? '3601062e-a63e-4d41-b54f-bae840639d94' : '90c45589-76ee-408d-b583-28805c824be2');

            // 1. Border
            doc.lineWidth(1.5).rect(margin, margin, contentWidth, height - (margin * 2)).stroke();

            // 2. Header
            doc.rect(margin, margin, contentWidth, 35).fill('black');
            doc.fillColor('white').fontSize(12).font(fontBold).text(carrierHeader, margin, margin + 10, { width: contentWidth, align: 'center' });
            doc.fillColor('black');

            // 3. Addresses
            const addressTop = margin + 42;

            // SHIP FROM (US WAREHOUSE HUB - WILLOW OFFICE ADDRESS)
            doc.fontSize(7).font(fontBold).text('SHIP FROM (US WAREHOUSE HUB):', margin + 10, addressTop);
            doc.fontSize(8).font(fontRegular).text(
                'DFL Lyndhurst Warehouse (Willow Commerce Hub)\n' +
                '1050 Wall Street West, Suite 660\n' +
                'Lyndhurst, NJ 07071, US\n' +
                `Carrier ID: ${carrierId}`,
                margin + 10, addressTop + 10, { width: contentWidth - 20, lineGap: 1 }
            );

            // SHIP TO (CONSIGNEE)
            const toY = addressTop + 55;
            doc.moveTo(margin, toY - 5).lineTo(width - margin, toY - 5).lineWidth(0.5).stroke();

            const consignee = shipment.consigneeDetails || {};
            doc.fontSize(7).font(fontBold).text('SHIP TO (FINAL MILE DESTINATION):', margin + 10, toY);
            doc.fontSize(10).font(fontBold).text(`${consignee.consigneeName || 'Consignee'}`, margin + 10, toY + 10);
            doc.fontSize(8).font(fontRegular).text(
                `${consignee.addressLine1 || consignee.street || ''}\n` +
                `${consignee.addressLine2 ? consignee.addressLine2 + '\n' : ''}` +
                `${consignee.city || ''}, ${consignee.state || ''} ${consignee.pincode || consignee.postalCode || ''}\n` +
                'UNITED STATES (US)\n' +
                `Tel: ${consignee.mobileNo || consignee.phone || '1234567890'}`,
                margin + 10, toY + 24, { width: contentWidth - 20, lineGap: 1 }
            );

            // 4. Barcode & Tracking Number
            const barcodeY = toY + 95;
            doc.moveTo(margin, barcodeY - 5).lineTo(width - margin, barcodeY - 5).lineWidth(0.5).stroke();

            let trackingNo = shipment.lastMileAWB || shipment.awbNo || shipment.trackingId;
            const rawIdDigits = String(shipment.shipmentId || Date.now()).replace(/\D/g, '');
            if (!trackingNo || trackingNo.startsWith('DFL')) {
                trackingNo = isUniUni
                    ? `UNI${rawIdDigits.padEnd(9, '0').slice(-9)}US`
                    : `92055901649173${rawIdDigits.padEnd(8, '0').slice(-8)}`;
            }

            const trackingLabel = isUniUni ? `UNIUNI TRACKING #: ${trackingNo}` : `USPS TRACKING #: ${trackingNo}`;
            doc.fontSize(8).font(fontBold).text(trackingLabel, margin, barcodeY + 2, { width: contentWidth, align: 'center' });

            try {
                const png = await bwipjs.toBuffer({
                    bcid: 'code128',
                    text: trackingNo,
                    scale: 2,
                    height: 12,
                    includetext: true,
                    textxalign: 'center'
                });
                doc.image(png, margin + 15, barcodeY + 14, { width: contentWidth - 30, height: 45 });
            } catch (bcErr) {
                doc.fontSize(11).font(fontBold).text(trackingNo, margin, barcodeY + 20, { width: contentWidth, align: 'center' });
            }

            // 5. Footer
            const footerY = height - margin - 35;
            doc.moveTo(margin, footerY).lineTo(width - margin, footerY).lineWidth(0.5).stroke();
            doc.fontSize(11).font(fontBold).text(`SERVICE: ${serviceName.toUpperCase()}`, margin, footerY + 8, { width: contentWidth, align: 'center' });
            doc.fontSize(7).font(fontRegular).text('Willow Commerce 3rd-Party Carrier Shipping Label', margin, footerY + 23, { width: contentWidth, align: 'center' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};

const generateShippingLabel = generateDFLBrandedLabel; // Alias for backward compatibility
module.exports = { generateShippingLabel, generateDFLBrandedLabel, generate3rdPartyWillowLabel };