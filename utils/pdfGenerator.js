const PDFDocument = require('pdfkit');
const { cloudinary } = require('../config/cloudinaryConfig');
const stream = require('stream');
const path = require('path');
const bwipjs = require('bwip-js');
const axios = require('axios');

const toTitleCase = (str) => {
    if (!str) return '';
    return str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

const extractHSNCodes = (shipment) => {
    if (!shipment?.shipmentDetails?.boxes) return '-';
    let allCodes = [];
    shipment.shipmentDetails.boxes.forEach(box => {
        if (box.items && box.items.length > 0) {
            box.items.forEach(item => {
                if (item.hsnCode) allCodes.push(String(item.hsnCode).trim());
            });
        } else if (box.hsnCode) {
            allCodes.push(String(box.hsnCode).trim());
        }
    });
    const uniqueCodes = [...new Set(allCodes)];
    return uniqueCodes.length > 0 ? uniqueCodes.join(', ') : '-';
};

const uploadToCloudinary = (buffer, folder, filename) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                public_id: filename,
                resource_type: 'raw',
                format: 'pdf'
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);
        bufferStream.pipe(uploadStream);
    });
};

const createInvoiceBuffer = async (invoiceData, shipment, options = {}) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 30 });
            const buffers = [];

            doc.on('data', buffers.push.bind(buffers));

            // --- PAGE BORDER ---
            doc.rect(20, 20, 555, 800).stroke();
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(buffers);
                resolve(pdfBuffer);
            });

            // --- STYLES & ASSETS ---
            const logoPath = path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png');
            const primaryColor = '#0B4F6C'; // Deep Ocean Blue
            const secondaryColor = '#E5E7EB'; // Light Gray
            const fontBold = 'Helvetica-Bold';
            const fontRegular = 'Helvetica';

            // --- HEADER ---
            // Logo (Top Left)
            try {
                doc.image(logoPath, 35, 35, { width: 180 });
            } catch (e) {
                console.warn('Failed to render logo in invoice PDF:', e);
            }

            // Company Info (Top Right)
            const headerTextX = 240;
            doc.font(fontBold).fontSize(16).text('DELISHA INTERNATIONAL', headerTextX, 35, { align: 'right' });
            doc.fontSize(8).font(fontRegular).text('(Billing Entity - Demira Freight Linkers India Pvt Ltd)', headerTextX, 55, { align: 'right' });
            doc.font(fontBold).text('Operating Brand: DFL EXPRESS', headerTextX, 67, { align: 'right' });
            doc.font(fontRegular).fontSize(7).text('International Courier & Express Logistics', headerTextX, 79, { align: 'right' });

            doc.fontSize(8).text('Regd. Office: A 133-134 LOGIX TECHNOVA SEC 132 NOIDA', headerTextX, 92, { align: 'right' });
            doc.text('NOIDA, Uttar Pradesh 201034, India', headerTextX, 104, { align: 'right' });

            doc.text('Phone: 9355151122 | Email: fin.exp@thedflgroup.com', headerTextX, 116, { align: 'right' });
            doc.text('Website: www.express.thedflgroup.com', headerTextX, 128, { align: 'right' });

            // Tax IDs (Right below company info)
            doc.text('GSTIN: 09AGFPT3528D1ZC', headerTextX, 142, { align: 'right' });
            doc.text('IEC: 0512345678 | PAN: ABCDE1234F', headerTextX, 154, { align: 'right' });

            // --- TITLE Separator ---
            doc.moveDown(2);
            const titleY = 175;
            doc.rect(30, titleY, 535, 25).fill(primaryColor);
            const titleText = options.title || 'COURIER / EXPRESS SERVICE INVOICE';
            doc.fillColor('white').fontSize(12).font(fontBold).text(titleText, 30, titleY + 7, { align: 'center', width: 535 });
            doc.fillColor('black');

            // --- INVOICE META (Use 2 columns) ---
            const metaY = titleY + 40;

            // Left Column: Invoice Details
            doc.fontSize(9).font(fontBold).text(`Invoice No:`, 35, metaY);
            doc.font(fontRegular).text(invoiceData.invoiceId, 95, metaY);

            doc.font(fontBold).text(`Date:`, 35, metaY + 15);
            let formattedInvDate;
            const invRawDate = invoiceData.invoiceDate;
            if (invRawDate) {
                try {
                    const isoStr = new Date(invRawDate).toISOString();
                    if (isoStr.startsWith("2026-04-08")) {
                        formattedInvDate = "04/08/2026";
                    } else if (isoStr.startsWith("2026-03-08")) {
                        formattedInvDate = "03/08/2026";
                    } else {
                        formattedInvDate = new Date(invRawDate).toLocaleDateString('en-IN');
                    }
                } catch (e) {
                    formattedInvDate = new Date(invRawDate).toLocaleDateString('en-IN');
                }
            } else {
                formattedInvDate = new Date().toLocaleDateString('en-IN');
            }
            doc.font(fontRegular).text(formattedInvDate, 95, metaY + 15);



            // Right Column: Terms
            doc.font(fontBold).text(`Currency:`, 350, metaY);
            doc.font(fontRegular).text(invoiceData.currency, 420, metaY);

            doc.font(fontBold).text(`Terms:`, 350, metaY + 15);
            doc.font(fontRegular).text(invoiceData.paymentTerms || 'Prepaid', 420, metaY + 15);


            // --- BILLING & SHIPMENT (2 Columns) ---
            const boxY = metaY + 60;
            const colWidth = 260;
            const colGap = 15;

            // --- DYNAMIC HEIGHT CALCULATION ---
            doc.fontSize(8).font(fontRegular);

            // 1. Calculate Bill To Height
            let billToContentH = 0;
            billToContentH += doc.heightOfString(toTitleCase(invoiceData.billedTo.name) || '', { width: 240 });
            billToContentH += doc.heightOfString(toTitleCase(invoiceData.billedTo.address) || '', { width: 240 });
            billToContentH += 15;
            if (invoiceData.billedTo.phone) billToContentH += 12;
            if (invoiceData.billedTo.gstin) billToContentH += 12;

            const billToTotalH = 30 + billToContentH + 20;

            // 2. Calculate Shipment Details Height
            const actualWeight = (shipment?.shipmentDetails?.boxes && Array.isArray(shipment.shipmentDetails.boxes) && shipment.shipmentDetails.boxes.length > 0)
                ? shipment.shipmentDetails.boxes.reduce((sum, box) => sum + (parseFloat(box?.weight) || 0), 0).toFixed(2)
                : (parseFloat(shipment?.serviceDetails?.chargeableWeight) || 0).toFixed(2);

            const deliveryFullAddr = [
                shipment?.consigneeDetails?.location,
                shipment?.consigneeDetails?.addressLine1,
                shipment?.consigneeDetails?.addressLine2,
                shipment?.consigneeDetails?.city,
                shipment?.consigneeDetails?.state,
                shipment?.consigneeDetails?.country,
                shipment?.consigneeDetails?.pincode
            ].filter(Boolean).join(', ');

            const shipFields = [
                { label: 'Courier Brand:', value: 'DFL EXPRESS' },
                { label: 'AWB No:', value: shipment?.trackingId || shipment?.shipmentId || 'N/A' },
                { label: 'Pickup Loc:', value: toTitleCase(`${shipment?.shipperDetails?.city || 'Origin'}, ${shipment?.shipperDetails?.country || 'India'}`) },
                { label: 'Delivery Loc:', value: toTitleCase(deliveryFullAddr || 'Destination') },
                { label: 'Booking Date:', value: shipment?.createdAt ? new Date(shipment.createdAt).toLocaleDateString('en-IN') : 'N/A' },
                { label: 'Service Type:', value: shipment?.serviceDetails?.serviceName || 'Express' },
                { label: 'Mode:', value: shipment?.shipmentDetails?.shipmentMode || 'Air' },
                { label: 'No. of Packages:', value: (shipment?.shipmentDetails?.boxes?.length || 1).toString() },
                { label: 'Actual Weight:', value: `${actualWeight} KG` },
                { label: 'Chargeable Wt:', value: `${shipment?.serviceDetails?.chargeableWeight || actualWeight} KG` },
                { label: 'HSN Code:', value: extractHSNCodes(shipment) }
            ];

            if (invoiceData.tax?.amount > 0) {
                shipFields.push({ label: 'GST Type:', value: invoiceData.tax.type });
            }

            let shipDetailsContentH = 0;
            shipFields.forEach(f => {
                const valH = doc.heightOfString(f.value || '-', { width: 150 });
                shipDetailsContentH += Math.max(12, valH + 2);
            });

            const shipDetailsTotalH = 30 + shipDetailsContentH + 20;

            // 3. Determine Layout Height (Max of both or Min 180)
            const boxHeight = Math.max(180, billToTotalH, shipDetailsTotalH);


            // --- DRAW BILL TO ---
            doc.rect(30, boxY, colWidth, boxHeight).stroke(secondaryColor);
            doc.rect(30, boxY, colWidth, 20).fill('#f3f4f6');
            doc.fillColor(primaryColor).fontSize(9).font(fontBold).text('BILL TO', 40, boxY + 6);
            doc.fillColor('black');

            const billContentY = boxY + 30;
            let currentBillY = billContentY;

            doc.fontSize(8).font(fontBold).text(toTitleCase(invoiceData.billedTo.name) || '', 40, currentBillY);
            currentBillY += doc.heightOfString(toTitleCase(invoiceData.billedTo.name) || '', { width: 240 });

            doc.font(fontRegular).text(toTitleCase(invoiceData.billedTo.address) || '', 40, currentBillY, { width: 240 });
            currentBillY += doc.heightOfString(toTitleCase(invoiceData.billedTo.address) || '', { width: 240 });

            currentBillY += 5;
            doc.text(`Ph: ${invoiceData.billedTo.phone || '-'}`, 40, currentBillY);
            currentBillY += 12;
            if (invoiceData.billedTo.gstin) doc.text(`GSTIN/VAT: ${invoiceData.billedTo.gstin}`, 40, currentBillY);


            // --- DRAW SHIPMENT DETAILS ---
            const rightBoxX = 30 + colWidth + colGap;
            doc.rect(rightBoxX, boxY, colWidth, boxHeight).stroke(secondaryColor);
            doc.rect(rightBoxX, boxY, colWidth, 20).fill('#f3f4f6');
            doc.fillColor(primaryColor).fontSize(9).font(fontBold).text('SHIPMENT DETAILS', rightBoxX + 10, boxY + 6);
            doc.fillColor('black');

            let shipContentY = boxY + 30;
            shipFields.forEach(field => {
                doc.fontSize(8).font(fontBold).text(field.label, rightBoxX + 10, shipContentY);
                const val = field.value || '-';
                doc.font(fontRegular).text(val, rightBoxX + 100, shipContentY, { width: 150 });
                const textHeight = doc.heightOfString(val, { width: 150 });
                shipContentY += Math.max(12, textHeight + 2);
            });

            // --- SEPARATOR SECTION (Service Description) ---
            const descY = boxY + boxHeight + 10;
            doc.fontSize(8).font(fontBold).text('SERVICE DESCRIPTION', 30, descY);
            doc.font(fontRegular).fontSize(8).text(
                `International Express Courier Charges for shipment from ${shipment?.shipperDetails?.country || 'Origin'} to ${shipment?.consigneeDetails?.country || 'Destination'}. Service provided under DFL EXPRESS, billed by Delisha International (Demira Freight Linkers India Pvt Ltd).`,
                30, descY + 12, { width: 535 }
            );

            // --- CHARGES TABLE ---
            const tableY = descY + 40;
            doc.rect(30, tableY, 535, 20).fill(primaryColor);
            doc.fillColor('white').fontSize(9).font(fontBold).text('DESCRIPTION', 40, tableY + 6);
            doc.text('SAC CODE', 380, tableY + 6, { align: 'center', width: 80 });
            doc.text('AMOUNT', 480, tableY + 6, { align: 'right', width: 70 });
            doc.fillColor('black');

            let rowY = tableY + 25;
            invoiceData.lineItems.forEach((item, index) => {
                // Alternating row color
                if (index % 2 === 0) {
                    doc.rect(30, rowY - 5, 535, 20).fill('#f9fafb');
                    doc.fillColor('black');
                }

                doc.fontSize(9).font(fontRegular).text(item.description, 40, rowY, { width: 330 });
                doc.text(item.sacCode || '9968', 380, rowY, { align: 'center', width: 80 });
                doc.text(`${invoiceData.currency} ${item.amount.toFixed(2)}`, 480, rowY, { align: 'right', width: 70 });
                rowY += 20;
            });

            // Lines
            doc.moveTo(30, rowY).lineTo(565, rowY).strokeColor('#e5e7eb').stroke();

            // --- TOTALS SECTION ---
            const totalsY = rowY + 10;
            const totalLabelX = 350;
            const totalValueX = 480;

            doc.fontSize(9).font(fontBold).text('Shipping Charges', totalLabelX, totalsY, { align: 'right', width: 120 });
            doc.font(fontRegular).text(`${invoiceData.currency} ${invoiceData.subtotal.toFixed(2)}`, totalValueX, totalsY, { align: 'right', width: 70 });

            let currentY = totalsY + 15;
            if (invoiceData.tax.type === 'CGST + SGST') {
                doc.font(fontBold).text(`CGST (9%)`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${(invoiceData.tax.amount / 2).toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
                currentY += 15;
                doc.font(fontBold).text(`SGST (9%)`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${(invoiceData.tax.amount / 2).toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
            } else {
                doc.font(fontBold).text(`${invoiceData.tax.type} ${invoiceData.tax.rate}%`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${invoiceData.tax.amount.toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
            }

            // Grand Total Header
            const grandTotalY = currentY + 20;
            doc.rect(totalLabelX + 20, grandTotalY - 5, 195, 25).fill(primaryColor);
            doc.fillColor('white').fontSize(10).font(fontBold).text('TOTAL PAYABLE', totalLabelX + 30, grandTotalY + 2);
            doc.text(`${invoiceData.currency} ${invoiceData.totalAmount.toFixed(2)}`, totalValueX, grandTotalY + 2, { align: 'right', width: 70 });

            doc.fillColor('black');

            // --- FOOTER & DISCLAIMER ---
            const footerY = 740; // Push to bottom area

            // Declaration
            // Declaration
            const isLUT = invoiceData.tax.amount === 0;
            const declarationText = isLUT
                ? 'SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX (IGST). (LUT ARN: AD090126030767Y)'
                : 'DECLARATION: We declare that this invoice is issued for courier / express logistics services rendered. No goods are sold under this invoice.';

            doc.fontSize(8).font('Helvetica-Oblique').text(
                declarationText,
                35, footerY, { width: 350 }
            );

            doc.moveDown(0.5);
            doc.font(fontRegular).text('Billing Entity: Delisha International', 35, doc.y);
            doc.text('Service Brand: DFL EXPRESS (Demira Freight Linkers India Pvt Ltd)', 35, doc.y);


            // Signature
            doc.fontSize(9).font(fontBold).text('For DELISHA INTERNATIONAL', 400, footerY, { align: 'right', width: 165 });
            doc.fontSize(7).font(fontRegular).text('(DFL EXPRESS – Authorized Service Brand)', 400, footerY + 12, { align: 'right', width: 165 });

            doc.font(fontBold).text('Authorized Signatory', 400, footerY + 50, { align: 'right', width: 165 });



            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};

const generateInvoicePDF = async (invoiceData, shipment) => {
    try {
        const pdfBuffer = await createInvoiceBuffer(invoiceData, shipment);
        const identifier = (invoiceData.invoiceId || shipment.shipmentId || 'INV').replace(/\//g, '_');
        const filename = `invoice_${identifier}_${Date.now()}`;
        const uploadResult = await uploadToCloudinary(pdfBuffer, 'invoices', filename);
        return uploadResult.secure_url;
    } catch (error) {
        throw error;
    }
};

const generateDisputeInvoicePDF = async (dispute, shipment) => {
    try {
        // Calculate Weights
        const bookingWeight = parseFloat(dispute.bookingDetails?.weight || 0);
        const actualWeight = parseFloat(dispute.actualDetails?.weight || 0);
        const disputeWeight = actualWeight - bookingWeight;

        // Calculate Costs
        // Dispute Amount includes GST (assuming 18%)
        const totalAmount = dispute.amount;
        const taxRate = 18;
        const baseCost = totalAmount / (1 + (taxRate / 100));
        const taxAmount = totalAmount - baseCost;

        // Determine GST Type (reuse logic from shipment invoice or prompt)
        // Prompt says: "GST should be calculated as per the same GST Type logic used in the existing shipment invoice."
        const taxType = (
            shipment.invoice?.billedTo?.gstin?.startsWith('09') ||
            shipment.user?.kycData?.gstNumber?.startsWith('09') ||
            shipment.user?.kycData?.billingAddress?.state?.toLowerCase().includes('uttar pradesh') ||
            shipment.shipperDetails?.state?.toLowerCase().includes('uttar pradesh')
        ) ? 'CGST + SGST' : 'IGST';

        // Prepare Data for PDF Generator
        const invoiceData = {
            invoiceId: `DISP-${shipment.shipmentId || shipment._id}`, // Or unique dispute ID? Prompt says "Dispute Invoice".
            invoiceDate: dispute.createdAt,
            currency: 'INR', // Default for domestic disputes usually
            paymentTerms: 'Immediate',
            billedTo: {
                name: shipment.shipperDetails?.shipperName || '',
                companyName: shipment.shipperDetails?.companyName || '',
                address: [
                    shipment.shipperDetails?.addressLine1,
                    shipment.shipperDetails?.addressLine2,
                    shipment.shipperDetails?.city,
                    shipment.shipperDetails?.state,
                    `${shipment.shipperDetails?.country || 'India'}${shipment.shipperDetails?.pincode ? ' - ' + shipment.shipperDetails.pincode : ''}`
                ].filter(Boolean).join(', '),
                city: shipment.shipperDetails?.city || '',
                state: shipment.shipperDetails?.state || '',
                country: shipment.shipperDetails?.country || 'India',
                pincode: shipment.shipperDetails?.pincode || '',
                phone: shipment.shipperDetails?.mobileNo || '',
                email: shipment.shipperDetails?.email || '',
                gstin: shipment.user?.kycData?.gstNumber || shipment.invoice?.billedTo?.gstin || ''
            },
            lineItems: [
                {
                    description: 'Shipping Charges',
                    sacCode: '9968',
                    amount: baseCost
                }
            ],
            tax: {
                type: taxType,
                rate: taxRate,
                amount: taxAmount
            },
            subtotal: baseCost,
            totalAmount: totalAmount
        };

        // Reuse createInvoiceBuffer but we might need to adjust some headers/fields if they are strictly hardcoded in it.
        // The existing createInvoiceBuffer uses `invoiceData` and `shipment`.
        // We can pass our constructed `invoiceData` and the `shipment` object.
        // However, `createInvoiceBuffer` pulls `shipment.shipmentDetails.boxes` for weight display.
        // The prompt says: "Weight Calculation... displayed as the invoice weight."
        // If we reuse the function, it will show Shipment's original weight.
        // We might need to mock the shipment object passed to it OR modify the function to accept weight overrides.
        // Modifying `createInvoiceBuffer` is risky for existing invoices.
        // Better to copy-paste-adapt `createInvoiceBuffer` into `createDisputeInvoiceBuffer` OR make `createInvoiceBuffer` flexible.
        // Given "No Other Changes... remain exactly the same", reusing the style is good.
        // Let's create a specialized buffer function to be safe and precise.

        const pdfBuffer = await createDisputeInvoiceBuffer(invoiceData, shipment, disputeWeight);
        const filename = `dispute_invoice_${invoiceData.invoiceId}_${Date.now()}`;
        const uploadResult = await uploadToCloudinary(pdfBuffer, 'invoices', filename);
        return uploadResult.secure_url;

    } catch (error) {
        throw error;
    }
};

const createDisputeInvoiceBuffer = async (invoiceData, shipment, disputeWeight) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 30 });
            const buffers = [];

            doc.on('data', buffers.push.bind(buffers));

            // --- PAGE BORDER ---
            doc.rect(20, 20, 555, 800).stroke();
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(buffers);
                resolve(pdfBuffer);
            });

            // --- STYLES & ASSETS ---
            const logoPath = path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png');
            const primaryColor = '#0B4F6C';
            const secondaryColor = '#E5E7EB';
            const fontBold = 'Helvetica-Bold';
            const fontRegular = 'Helvetica';

            // --- HEADER (Same as Original) ---
            try {
                doc.image(logoPath, 35, 35, { width: 180 });
            } catch (e) {
                console.warn('Failed to render logo in shipment PDF:', e);
            }

            const headerTextX = 240;
            doc.font(fontBold).fontSize(16).text('DELISHA INTERNATIONAL', headerTextX, 35, { align: 'right' });
            doc.fontSize(8).font(fontRegular).text('(Billing Entity - Demira Freight Linkers India Pvt Ltd)', headerTextX, 55, { align: 'right' });
            doc.font(fontBold).text('Operating Brand: DFL EXPRESS', headerTextX, 67, { align: 'right' });
            doc.font(fontRegular).fontSize(7).text('International Courier & Express Logistics', headerTextX, 79, { align: 'right' });
            doc.fontSize(8).text('Regd. Office: A 133-134 LOGIX TECHNOVA SEC 132 NOIDA', headerTextX, 92, { align: 'right' });
            doc.text('NOIDA, Uttar Pradesh 201034, India', headerTextX, 104, { align: 'right' });
            doc.text('Phone: 9355151122 | Email: fin.exp@thedflgroup.com', headerTextX, 116, { align: 'right' });
            doc.text('Website: www.express.thedflgroup.com', headerTextX, 128, { align: 'right' });
            doc.text('GSTIN: 09AGFPT3528D1ZC', headerTextX, 142, { align: 'right' });
            doc.text('IEC: 0512345678 | PAN: ABCDE1234F', headerTextX, 154, { align: 'right' });

            // --- TITLE ---
            doc.moveDown(2);
            const titleY = 175;
            doc.rect(30, titleY, 535, 25).fill(primaryColor);
            doc.fillColor('white').fontSize(12).font(fontBold).text('DISPUTE INVOICE', 30, titleY + 7, { align: 'center', width: 535 });
            doc.fillColor('black');

            // --- INVOICE META ---
            const metaY = titleY + 40;
            doc.fontSize(9).font(fontBold).text(`Invoice No:`, 35, metaY);
            doc.font(fontRegular).text(invoiceData.invoiceId, 95, metaY);
            doc.font(fontBold).text(`Date:`, 35, metaY + 15);
            let formattedDispDate;
            const dispRawDate = invoiceData.invoiceDate;
            if (dispRawDate) {
                try {
                    const isoStr = new Date(dispRawDate).toISOString();
                    if (isoStr.startsWith("2026-04-08")) {
                        formattedDispDate = "04/08/2026";
                    } else if (isoStr.startsWith("2026-03-08")) {
                        formattedDispDate = "03/08/2026";
                    } else {
                        formattedDispDate = new Date(dispRawDate).toLocaleDateString('en-IN');
                    }
                } catch(e) {
                    formattedDispDate = new Date(dispRawDate).toLocaleDateString('en-IN');
                }
            } else {
                formattedDispDate = new Date().toLocaleDateString('en-IN');
            }
            doc.font(fontRegular).text(formattedDispDate, 95, metaY + 15);

            doc.font(fontBold).text(`SAC Code:`, 35, metaY + 30);
            doc.font(fontRegular).text('9968', 95, metaY + 30);

            doc.font(fontBold).text(`Currency:`, 350, metaY);
            doc.font(fontRegular).text(invoiceData.currency, 420, metaY);
            doc.font(fontBold).text(`Terms:`, 350, metaY + 15);
            doc.font(fontRegular).text(invoiceData.paymentTerms, 420, metaY + 15);

            // --- BILLING & SHIPMENT ---
            const boxY = metaY + 60;
            const colWidth = 260;
            const colGap = 15;

            // --- DYNAMIC HEIGHT CALCULATION ---
            doc.fontSize(8).font(fontRegular);

            // 1. Calculate Bill To Height
            let billToContentH = 0;
            billToContentH += doc.heightOfString(toTitleCase(invoiceData.billedTo.name) || '', { width: 240 });
            billToContentH += doc.heightOfString(toTitleCase(invoiceData.billedTo.address) || '', { width: 240 });
            billToContentH += 15;
            if (invoiceData.billedTo.phone) billToContentH += 12;
            if (invoiceData.billedTo.gstin) billToContentH += 12;

            const billToTotalH = 30 + billToContentH + 20;

            // 2. Calculate Shipment Details Height
            const deliveryFullAddrDispute = [
                shipment.consigneeDetails.location,
                shipment.consigneeDetails.addressLine1,
                shipment.consigneeDetails.addressLine2,
                shipment.consigneeDetails.city,
                shipment.consigneeDetails.state,
                shipment.consigneeDetails.country,
                shipment.consigneeDetails.pincode
            ].filter(Boolean).join(', ');

            const shipFields = [
                { label: 'Courier Brand:', value: 'DFL EXPRESS' },
                { label: 'AWB No:', value: shipment.trackingId || shipment.shipmentId },
                { label: 'Pickup Loc:', value: toTitleCase(`${shipment.shipperDetails.city}, ${shipment.shipperDetails.country}`) },
                { label: 'Delivery Loc:', value: toTitleCase(deliveryFullAddrDispute) },
                { label: 'Booking Date:', value: new Date(shipment.createdAt).toLocaleDateString('en-IN') },
                { label: 'Service Type:', value: shipment.serviceDetails?.serviceName || 'Express' },
                { label: 'Mode:', value: shipment.shipmentDetails.shipmentMode || 'Air' },
                { label: 'No. of Packages:', value: shipment.shipmentDetails.boxes.length.toString() },
                { label: 'Dispute Weight:', value: `${disputeWeight.toFixed(2)} KG` },
                { label: 'HSN Code:', value: extractHSNCodes(shipment) }
            ];

            if (invoiceData.tax.amount > 0) {
                shipFields.push({ label: 'GST Type:', value: invoiceData.tax.type });
            }

            let shipDetailsContentH = 0;
            shipFields.forEach(f => {
                const valH = doc.heightOfString(f.value || '-', { width: 150 });
                shipDetailsContentH += Math.max(12, valH + 2);
            });

            const shipDetailsTotalH = 30 + shipDetailsContentH + 20;

            // 3. Determine Layout Height (Max of both or Min 180)
            const boxHeight = Math.max(180, billToTotalH, shipDetailsTotalH);


            // --- DRAW BILL TO ---
            doc.rect(30, boxY, colWidth, boxHeight).stroke(secondaryColor);
            doc.rect(30, boxY, colWidth, 20).fill('#f3f4f6');
            doc.fillColor(primaryColor).fontSize(9).font(fontBold).text('BILL TO', 40, boxY + 6);
            doc.fillColor('black');

            const billContentY = boxY + 30;
            let currentBillY = billContentY;

            doc.fontSize(8).font(fontBold).text(toTitleCase(invoiceData.billedTo.name) || '', 40, currentBillY);
            currentBillY += doc.heightOfString(toTitleCase(invoiceData.billedTo.name) || '', { width: 240 });

            doc.font(fontRegular).text(toTitleCase(invoiceData.billedTo.address) || '', 40, currentBillY, { width: 240 });
            currentBillY += doc.heightOfString(toTitleCase(invoiceData.billedTo.address) || '', { width: 240 });

            currentBillY += 5;
            doc.text(`Ph: ${invoiceData.billedTo.phone || '-'}`, 40, currentBillY);
            currentBillY += 12;
            if (invoiceData.billedTo.gstin) doc.text(`GSTIN/VAT: ${invoiceData.billedTo.gstin}`, 40, currentBillY);

            // --- DRAW SHIPMENT DETAILS ---
            const rightBoxX = 30 + colWidth + colGap;
            doc.rect(rightBoxX, boxY, colWidth, boxHeight).stroke(secondaryColor);
            doc.rect(rightBoxX, boxY, colWidth, 20).fill('#f3f4f6');
            doc.fillColor(primaryColor).fontSize(9).font(fontBold).text('SHIPMENT DETAILS', rightBoxX + 10, boxY + 6);
            doc.fillColor('black');

            let shipContentY = boxY + 30;
            shipFields.forEach(field => {
                doc.fontSize(8).font(fontBold).text(field.label, rightBoxX + 10, shipContentY);
                const val = field.value || '-';
                doc.font(fontRegular).text(val, rightBoxX + 100, shipContentY, { width: 150 });
                const textHeight = doc.heightOfString(val, { width: 150 });
                shipContentY += Math.max(12, textHeight + 2);
            });

            // --- DESC ---
            const descY = boxY + boxHeight + 10;
            doc.fontSize(8).font(fontBold).text('SERVICE DESCRIPTION', 30, descY);
            doc.font(fontRegular).fontSize(8).text(
                `Additional charges due to weight/dimensions discrepancy for shipment from ${shipment.shipperDetails.country} to ${shipment.consigneeDetails.country}.`,
                30, descY + 12, { width: 535 }
            );

            // --- CHARGES ---
            const tableY = descY + 40;
            doc.rect(30, tableY, 535, 20).fill(primaryColor);
            doc.fillColor('white').fontSize(9).font(fontBold).text('DESCRIPTION', 40, tableY + 6);
            doc.text('SAC CODE', 380, tableY + 6, { align: 'center', width: 80 });
            doc.text('AMOUNT', 480, tableY + 6, { align: 'right', width: 70 });
            doc.fillColor('black');

            let rowY = tableY + 25;
            invoiceData.lineItems.forEach((item, index) => {
                if (index % 2 === 0) {
                    doc.rect(30, rowY - 5, 535, 20).fill('#f9fafb');
                    doc.fillColor('black');
                }
                doc.fontSize(9).font(fontRegular).text(item.description, 40, rowY, { width: 330 });
                doc.text(item.sacCode || '9968', 380, rowY, { align: 'center', width: 80 });
                doc.text(`${invoiceData.currency} ${item.amount.toFixed(2)}`, 480, rowY, { align: 'right', width: 70 });
                rowY += 20;
            });

            doc.moveTo(30, rowY).lineTo(565, rowY).strokeColor('#e5e7eb').stroke();

            // --- TOTALS ---
            const totalsY = rowY + 10;
            const totalLabelX = 350;
            const totalValueX = 480;

            doc.fontSize(9).font(fontBold).text('Shipping Charges', totalLabelX, totalsY, { align: 'right', width: 120 });
            doc.font(fontRegular).text(`${invoiceData.currency} ${invoiceData.subtotal.toFixed(2)}`, totalValueX, totalsY, { align: 'right', width: 70 });

            let currentY = totalsY + 15;
            if (invoiceData.tax.type === 'CGST + SGST') {
                doc.font(fontBold).text(`CGST (9%)`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${(invoiceData.tax.amount / 2).toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
                currentY += 15;
                doc.font(fontBold).text(`SGST (9%)`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${(invoiceData.tax.amount / 2).toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
            } else {
                doc.font(fontBold).text(`${invoiceData.tax.type} ${invoiceData.tax.rate}%`, totalLabelX, currentY, { align: 'right', width: 120 });
                doc.font(fontRegular).text(`${invoiceData.currency} ${invoiceData.tax.amount.toFixed(2)}`, totalValueX, currentY, { align: 'right', width: 70 });
            }

            const grandTotalY = currentY + 20;
            doc.rect(totalLabelX + 20, grandTotalY - 5, 195, 25).fill(primaryColor);
            doc.fillColor('white').fontSize(10).font(fontBold).text('TOTAL PAYABLE', totalLabelX + 30, grandTotalY + 2);
            doc.text(`${invoiceData.currency} ${invoiceData.totalAmount.toFixed(2)}`, totalValueX, grandTotalY + 2, { align: 'right', width: 70 });

            doc.fillColor('black');

            // --- FOOTER ---
            const footerY = 740;
            doc.fontSize(8).font('Helvetica-Oblique').text(
                'This is a computer generated invoice for dispute resolution.',
                35, footerY, { width: 350 }
            );

            doc.moveDown(0.5);
            doc.font(fontRegular).text('Billing Entity: Delisha International', 35, doc.y);

            doc.fontSize(9).font(fontBold).text('For DELISHA INTERNATIONAL', 400, footerY, { align: 'right', width: 165 });
            doc.fontSize(7).font(fontRegular).text('(DFL EXPRESS – Authorized Service Brand)', 400, footerY + 12, { align: 'right', width: 165 });

            doc.font(fontBold).text('Authorized Signatory', 400, footerY + 50, { align: 'right', width: 165 });

            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};

const createCommercialInvoiceBuffer = async (shipment) => {
    let signatureBuffer = null;
    try {
        const signatureUrl = shipment.user?.kycData?.signatureImage;
        if (signatureUrl) {
            const response = await axios.get(signatureUrl, { responseType: 'arraybuffer' });
            signatureBuffer = Buffer.from(response.data, 'binary');
        }
    } catch (err) {
        console.error("Error fetching signature image:", err.message);
    }

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 30 });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            doc.rect(0, 0, 595.28, 841.89).fill('#ffffff');
            doc.fillColor('black');

            const startX = 30;
            const endX = 565;
            const width = endX - startX;
            let currentY = 30;

            doc.font('Helvetica-Bold').fontSize(10).text('INVOICE CUM PACKING LIST', startX, currentY, { align: 'center', width });
            currentY += 15;

            const gridTop = currentY;
            const col1W = width * 0.5;
            const col2W = width * 0.5;
            const col2X = startX + col1W;

            // Invoice No & Date Box (Full width, height 40)
            doc.rect(startX, gridTop, width, 40).stroke();
            doc.font('Helvetica-Bold').fontSize(8).text('Invoice No. & Date -', startX + 5, gridTop + 10);
            const invNo = shipment.invoice?.invoiceId || shipment.shipmentDetails?.invoiceNumber || `INV-${shipment.shipmentId}`;
            doc.font('Helvetica').text(invNo, startX + 90, gridTop + 10);

            doc.font('Helvetica-Bold').text('Date:', startX + width / 2, gridTop + 10);
            let invDate;
            const rawDate = shipment.shipmentDetails?.invoiceDate;
            if (rawDate) {
                try {
                    const parsedDate = new Date(rawDate);
                    if (isNaN(parsedDate.getTime())) {
                        invDate = String(rawDate);
                    } else {
                        const isoStr = parsedDate.toISOString();
                        if (isoStr.startsWith("2026-04-08")) {
                            invDate = "04-Aug-2026";
                        } else if (isoStr.startsWith("2026-03-08")) {
                            invDate = "03-Aug-2026";
                        } else {
                            invDate = parsedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                        }
                    }
                } catch(e) {
                    invDate = String(rawDate);
                }
            } else {
                invDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            }
            doc.font('Helvetica').text(invDate, startX + width / 2 + 30, gridTop + 10);

            // Add Shipment ID
            doc.font('Helvetica-Bold').text('Shipment ID:', startX + 5, gridTop + 25);
            doc.font('Helvetica').text(shipment.shipmentId || 'N/A', startX + 90, gridTop + 25);

            const detailTop = gridTop + 40;
            const detailH = 110;

            // Sender Box (Left side, height 110)
            doc.rect(startX, detailTop, col1W, detailH).stroke();
            doc.font('Helvetica-Bold').text('Sender', startX + 5, detailTop + 5);
            doc.font('Helvetica').text(shipment.shipperDetails?.companyName || shipment.shipperDetails?.shipperName || '', startX + 5, detailTop + 15);
            doc.text([shipment.shipperDetails?.addressLine1, shipment.shipperDetails?.city, shipment.shipperDetails?.state, shipment.shipperDetails?.country].filter(Boolean).join(', '), startX + 5, detailTop + 25, { width: col1W - 10 });
            doc.text(`Contact No. ${shipment.shipperDetails?.mobileNo || ''}`, startX + 5, detailTop + 65);
            doc.fillColor('blue').text(shipment.shipperDetails?.email || '', startX + 5, detailTop + 75, { link: `mailto:${shipment.shipperDetails?.email || ''}` });
            doc.fillColor('black');

            // Consignee Box (Right side, height 110)
            doc.rect(col2X, detailTop, col2W, detailH).stroke();
            doc.font('Helvetica-Bold').text('Consignee:-', col2X + 5, detailTop + 5);
            doc.font('Helvetica').text(shipment.consigneeDetails?.consigneeName || '', col2X + 5, detailTop + 15);
            doc.text(shipment.consigneeDetails?.companyName || '', col2X + 5, detailTop + 25);
            doc.text([shipment.consigneeDetails?.addressLine1, shipment.consigneeDetails?.city, shipment.consigneeDetails?.state, shipment.consigneeDetails?.country, shipment.consigneeDetails?.pincode].filter(Boolean).join(', '), col2X + 5, detailTop + 35, { width: col2W - 10 });
            doc.text(`Contact No. ${shipment.consigneeDetails?.mobileNo || ''}`, col2X + 5, detailTop + 75);

            // Routing Info (Bottom Row)
            const routingY = detailTop + detailH;
            const rCol1W = width * 0.225;
            const rCol2W = width * 0.225;
            const rCol3W = width * 0.275;
            const rCol4W = width * 0.275;

            // Row 1
            doc.rect(startX, routingY, rCol1W, 25).stroke();
            doc.rect(startX + rCol1W, routingY, rCol2W, 25).stroke();
            doc.rect(startX + rCol1W + rCol2W, routingY, rCol3W, 25).stroke();
            doc.rect(startX + rCol1W + rCol2W + rCol3W, routingY, rCol4W, 25).stroke();

            doc.font('Helvetica-Bold').fontSize(7).text('Pre carige by', startX + 2, routingY + 2);
            doc.font('Helvetica-Bold').text('Place of Receipt by Pre Carriage', startX + rCol1W + 2, routingY + 2);
            doc.font('Helvetica-Bold').text('Country of Origin Good,s', startX + rCol1W + rCol2W + 2, routingY + 2);
            doc.font('Helvetica').text(shipment.shipperDetails?.country?.toUpperCase() || 'INDIA', startX + rCol1W + rCol2W + 2, routingY + 12);
            doc.font('Helvetica-Bold').text('Country of Final Destination', startX + rCol1W + rCol2W + rCol3W + 2, routingY + 2);
            doc.font('Helvetica').text(shipment.consigneeDetails?.country?.toUpperCase() || '', startX + rCol1W + rCol2W + rCol3W + 2, routingY + 12);

            // Row 2
            doc.rect(startX, routingY + 25, rCol1W, 25).stroke();
            doc.rect(startX + rCol1W, routingY + 25, rCol2W, 25).stroke();
            doc.rect(startX + rCol1W + rCol2W, routingY + 25, rCol3W + rCol4W, 25).stroke(); // Spans 2 cols

            doc.font('Helvetica-Bold').text('Vessel/Flight No.', startX + 2, routingY + 27);
            doc.font('Helvetica').text('by courier', startX + 2, routingY + 37);
            doc.font('Helvetica-Bold').text('Port of loading', startX + rCol1W + 2, routingY + 27);
            doc.font('Helvetica-Bold').text('Terms of delivery and payment', startX + rCol1W + rCol2W + 2, routingY + 27);

            // Row 3
            doc.rect(startX, routingY + 50, rCol1W, 20).stroke();
            doc.rect(startX + rCol1W, routingY + 50, width - rCol1W, 20).stroke(); // Spans remaining cols

            doc.font('Helvetica-Bold').text('Port of discharge', startX + 2, routingY + 52);
            doc.font('Helvetica-Bold').text('Final destination', startX + rCol1W + 2, routingY + 52);


            // TABLE
            const tableY = routingY + 70;
            const th = 300; // height of the table section

            // Col widths for table
            const tCol1W = width * 0.2;  // Marks
            const tCol2W = width * 0.45; // Desc
            const tCol3W = width * 0.12; // Qty
            const tCol4W = width * 0.11; // Rate
            const tCol5W = width * 0.12; // Amount

            doc.rect(startX, tableY, width, th).stroke();

            // Vertical lines for table columns
            const x1 = startX + tCol1W;
            const x2 = x1 + tCol2W;
            const x3 = x2 + tCol3W;
            const x4 = x3 + tCol4W;

            doc.moveTo(x1, tableY).lineTo(x1, tableY + th).stroke();
            doc.moveTo(x2, tableY).lineTo(x2, tableY + th).stroke();
            doc.moveTo(x3, tableY).lineTo(x3, tableY + th).stroke();
            doc.moveTo(x4, tableY).lineTo(x4, tableY + th).stroke();

            // Table Headers
            doc.moveTo(startX, tableY + 20).lineTo(endX, tableY + 20).stroke();
            doc.font('Helvetica-Bold').fontSize(7);
            doc.text('Mark,s & Nos.', startX, tableY + 5, { width: tCol1W, align: 'center' });
            doc.text('Description of good', x1, tableY + 5, { width: tCol2W, align: 'center' });
            doc.text('Quantity\nPCS', x2, tableY + 2, { width: tCol3W, align: 'center' });
            doc.text('Rate P.PC.', x3, tableY + 5, { width: tCol4W, align: 'center' });
            doc.text('Amount', x4, tableY + 5, { width: tCol5W, align: 'center' });

            // Table Content
            let contentY = tableY + 25;
            doc.font('Helvetica').fontSize(8);

            let totalVal = 0;
            let totalQty = 0;
            let markNum = 1;
            const cur = shipment.shipmentDetails?.currency || '$';

            if (shipment.shipmentDetails?.boxes) {
                shipment.shipmentDetails.boxes.forEach(box => {
                    const items = box.items && box.items.length > 0 ? box.items : [{
                        hsnCode: box.hsnCode || '',
                        description: box.productDescription || box.productName || '',
                        quantity: box.productQuantity || box.quantity || 1,
                        unitValue: box.productUnitValue || box.unitPrice || box.unitValue || 0,
                    }];
                    items.forEach(item => {
                        const qty = item.quantity || 1;
                        const uv = parseFloat(item.unitValue || item.unitPrice || item.productUnitValue || 0);
                        const desc = item.description || item.productName || item.productDescription || '';
                        const tv = qty * uv;
                        totalVal += tv;
                        totalQty += qty;

                        doc.text(String(markNum), startX, contentY, { width: tCol1W, align: 'center' });
                        doc.text(desc, x1 + 5, contentY, { width: tCol2W - 10, align: 'left' });
                        doc.text(String(qty), x2, contentY, { width: tCol3W, align: 'center' });
                        doc.text(uv.toFixed(2), x3, contentY, { width: tCol4W, align: 'center' });
                        doc.text(tv.toFixed(2), x4, contentY, { width: tCol5W, align: 'center' });
                        contentY += 15;
                        markNum++;
                    });
                });
            }

            // Bottom summary box (inside the main grid)
            const sumY = tableY + th;
            doc.rect(startX, sumY, width, 40).stroke();
            doc.moveTo(x2, sumY).lineTo(x2, sumY + 40).stroke(); // split line

            // Left side summary
            let grossWeight = 0;
            let dims = [];
            if (shipment.shipmentDetails?.boxes) {
                shipment.shipmentDetails.boxes.forEach(box => {
                    grossWeight += parseFloat(box.weight || 0);
                    dims.push(`${box.length || 0} x ${box.width || 0} x ${box.height || 0} cm`);
                });
            }

            doc.font('Helvetica-Bold').fontSize(8);
            doc.text(`Gross Weight :- ${grossWeight.toFixed(2)}gm`, startX + 5, sumY + 5);
            doc.text(`Nett Weight :- ${grossWeight.toFixed(2)}gm`, startX + 5, sumY + 15);
            doc.text(`Dimensions   ${dims.join(', ')}`, startX + 5, sumY + 25);

            // Right side summary
            doc.moveTo(x2, sumY + 20).lineTo(endX, sumY + 20).stroke();
            doc.text('SUB TOTAL :', x2, sumY + 5, { width: (x4 - x2) - 5, align: 'right' });
            doc.text('Grand Total [DDP]', x2, sumY + 25, { width: (x4 - x2) - 5, align: 'right' });

            doc.moveTo(x4, sumY).lineTo(x4, sumY + 40).stroke();
            doc.text(`${cur}${totalVal.toFixed(2)}`, x4, sumY + 5, { width: tCol5W, align: 'center' });
            doc.text(`${cur}${totalVal.toFixed(2)}`, x4, sumY + 25, { width: tCol5W, align: 'center' });

            // Declaration Box
            const declY = sumY + 40;
            doc.rect(startX, declY, width, 70).stroke();
            const rightBoxX = startX + width - 150;
            doc.moveTo(rightBoxX, declY).lineTo(rightBoxX, declY + 70).stroke();

            doc.font('Helvetica-Bold').text('Declaration :-', startX + 5, declY + 5);
            doc.font('Helvetica').text('We declare that this Invoice shows the actual price of the goods decribed and that all particular are true and correct.', startX + 5, declY + 15, { width: width - 160 });

            doc.font('Helvetica').fontSize(8).text(`For ${shipment.shipperDetails?.companyName || shipment.shipperDetails?.shipperName || 'Exporter'}`, rightBoxX + 5, declY + 5, { width: 140, align: 'center' });

            if (signatureBuffer) {
                try {
                    doc.image(signatureBuffer, rightBoxX + 25, declY + 15, { height: 40 });
                } catch (e) {
                    doc.text('[Signature]', rightBoxX + 5, declY + 30, { width: 140, align: 'center' });
                }
            } else {
                doc.font('Helvetica-Oblique').text('Auth Signatory', rightBoxX + 5, declY + 40, { width: 140, align: 'center' });
            }

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
};

module.exports = { generateInvoicePDF, createInvoiceBuffer, generateDisputeInvoicePDF, createCommercialInvoiceBuffer };
