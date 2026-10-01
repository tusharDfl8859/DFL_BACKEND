const xlsx = require('xlsx');
const sendEmail = require('./emailService');
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const PackingBoxShipment = require('../models/PackingBoxShipment');

const {
    CSV_V_EXCEL_HEADERS,
    buildCsvVRow,
    CSV_IV_EXCEL_HEADERS,
    buildCsvIvRow
} = require('../services/packing/packingService');

const TARGET_EMAILS = {
    // UNITED: 'tauseefuwc@gmail.com',
    // SKYNET: 'EOPS@skynetww.com',
    //  'SKYNET ECOMMERCE': 'EOPS@skynetww.com',
    // TPL: 'RAAJ@transitpl.com',
    RSA: 'express.ops@thedflgroup.com', // fallback until RSA email is provided
    DEFAULT: 'express.ops@thedflgroup.com'
};

const CC_EMAILS = [
    'express.ops@thedflgroup.com',
    'support@thedflexpress.com',
    'kaushal.tech@thedflgroup.com',
    'rg@thedflgroup.com'
];

const generateCsbvExcel = (shipments, boxMap = {}) => {
    const dataRows = shipments.map(s => {
        const boxId = boxMap[s._id.toString()] || '';
        return buildCsvVRow(s, { boxId });
    });

    const sheetData = [CSV_V_EXCEL_HEADERS, ...dataRows];
    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    worksheet['!cols'] = CSV_V_EXCEL_HEADERS.map(() => ({ wch: 18 }));

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'CSB-V Report');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const generateCsb4Excel = (shipments, targetCarrierCode = '', boxMap = {}) => {
    const dataRows = shipments.map(s => {
        const boxId = boxMap[s._id.toString()] || '';
        return buildCsvIvRow(s, { boxId });
    });

    const sheetData = [CSV_IV_EXCEL_HEADERS, ...dataRows];
    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    worksheet['!cols'] = CSV_IV_EXCEL_HEADERS.map(() => ({ wch: 18 }));

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'CSV IV Manifest');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const sendCsbvReport = async (shipmentIds, shipperEmailCode, csbType = 'CSB-V') => {
    try {
        const shipments = await Shipment.find({ _id: { $in: shipmentIds } }).populate('user', 'kycData');
        if (!shipments || shipments.length === 0) {
            throw new Error('No shipments found for the provided IDs.');
        }

        const isCsb4 = csbType === 'CSB-IV';
        
        // Find packing box shipments to get BOX IDs
        const boxMappings = await PackingBoxShipment.find({ shipment: { $in: shipments.map(s => s._id) } })
            .populate('packingBox', 'boxId')
            .lean();

        const boxMap = {};
        boxMappings.forEach(bm => {
            if (bm.shipment && bm.packingBox) {
                boxMap[bm.shipment.toString()] = bm.packingBox.boxId;
            }
        });

        const excelBuffer = isCsb4 ? generateCsb4Excel(shipments, shipperEmailCode, boxMap) : generateCsbvExcel(shipments, boxMap);
        const targetEmail = TARGET_EMAILS[shipperEmailCode] || TARGET_EMAILS.DEFAULT;

        const carrierDisplayName = shipperEmailCode ? shipperEmailCode.trim() : '';
        const csbName = isCsb4 ? 'CSB-IV' : 'CSB-V';
        
        const reportTitle = carrierDisplayName ? `${carrierDisplayName} ${csbName} Automated Report` : `${csbName} Automated Report`;
        const emailSubject = carrierDisplayName ? `${carrierDisplayName} ${csbName} Report` : `${csbName} Report`;
        const emailBodyText = carrierDisplayName 
            ? `Please find attached the ${carrierDisplayName} ${csbName} Report generated for the selected shipments.`
            : `Please find attached the ${csbName} Report generated for the selected shipments.`;

        const fileName = isCsb4 ? `CSB4_Report_${new Date().toISOString().split('T')[0]}.xlsx` : `CSBV_Report_${new Date().toISOString().split('T')[0]}.xlsx`;

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #0275d8;">${reportTitle}</h2>
                <p>Hello Team,</p>
                <p>${emailBodyText}</p>
                <br/>
                <p>Best Regards,</p>
                <p><strong>DFL Operations Team</strong></p>
            </div>
        `;

        await sendEmail({
            email: targetEmail + ',' + CC_EMAILS.join(','),
            subject: emailSubject,
            html: emailHtml,
            attachments: [
                {
                    filename: fileName,
                    content: excelBuffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ]
        });

        return excelBuffer;
    } catch (error) {
        console.error('[CsbvReportService] Error generating/sending report:', error);
        throw error;
    }
};

module.exports = { sendCsbvReport };
