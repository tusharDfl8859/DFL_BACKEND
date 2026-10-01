const cron = require('node-cron');
const xlsx = require('xlsx');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const sendEmail = require('../utils/emailService');
const logger = require('../utils/logger');

let isRunning = false;

/**
 * Compile and generate the Daily Report Excel Buffer
 */
const generateDailyReportExcel = (shipments) => {
    const data = shipments.map(s => {
        const totalWeight = s.shipmentDetails?.boxes?.reduce((acc, box) => acc + (parseFloat(box.weight) || 0), 0) || s.serviceDetails?.chargeableWeight || 0;
        const invoiceValue = s.shipmentDetails?.boxes?.reduce((acc, b) => {
            return acc + (b.items?.reduce((sum, item) => sum + (parseFloat(item.unitPrice) * parseFloat(item.quantity) || 0), 0) || 0);
        }, 0) || s.shipmentDetails?.csbVItems?.reduce((acc, item) => acc + (parseFloat(item.unitPrice) * parseFloat(item.quantity) || 0), 0) || 0;
        
        const boxDimsStr = s.shipmentDetails?.boxes?.map(b => `${b.length || 0}x${b.width || 0}x${b.height || 0}`).join(', ') || '';

        return {
            'Shipment ID': s.shipmentId || s._id.toString(),
            'Date': s.createdAt ? new Date(s.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : '',
            'Status': s.status || '',
            'Tracking ID': s.trackingId || '',
            'AWB Number': s.lastMileAWB || s.trackingId || '',
            'Booked By Name': s.user?.name || '',
            'Booked By Company': s.user?.kycData?.companyName || 'N/A',
            'Shipper Name': s.shipperDetails?.shipperName || '',
            'Shipper Company': s.shipperDetails?.companyName || '',
            'Shipper Address': [s.shipperDetails?.addressLine1, s.shipperDetails?.addressLine2].filter(Boolean).join(', ') || '',
            'Pickup Date': s.shipperDetails?.date ? new Date(s.shipperDetails.date).toLocaleDateString('en-GB') : '',
            'Service Mode': s.shipperDetails?.pickupType || '',
            'Consignee Name': s.consigneeDetails?.consigneeName || '',
            'Consignee Company': s.consigneeDetails?.companyName || '',
            'Consignee Address': [s.consigneeDetails?.addressLine1, s.consigneeDetails?.addressLine2].filter(Boolean).join(', ') || '',
            'Orign': s.shipperDetails?.countryCode || s.shipperDetails?.country || '',
            'Destination': s.consigneeDetails?.countryCode || s.consigneeDetails?.country || '',
            'Type': s.shipmentDetails?.shipmentType || '',
            'Category': s.shipmentDetails?.shipmentCategory || '',
            'Mode': s.shipmentDetails?.shipmentMode || '',
            'Boxes Count': s.shipmentDetails?.noOfBoxes || s.shipmentDetails?.boxes?.length || 1,
            'Total Weight (kg)': totalWeight,
            'Chargeable Weight': s.serviceDetails?.chargeableWeight || '',
            'Declared Value': s.shipmentDetails?.totalItemValue || invoiceValue || 0,
            'Box Dims': boxDimsStr,
            'Service Name': s.serviceDetails?.serviceName || '',
            'Carrier': s.serviceDetails?.carrierName || '',
            'ETA': s.serviceDetails?.eta || '',
            'Price': s.serviceDetails?.price || 0,
            'IEC Number': s.shipmentDetails?.iecNumber || s.user?.kycData?.iecNumber || '',
            'AD Code': s.shipmentDetails?.adCode || s.user?.kycData?.adCode || '',
            'Bank Name': s.shipmentDetails?.bankName || s.user?.kycData?.bankName || '',
            'Account Number': s.shipmentDetails?.accountNo || s.user?.kycData?.bankAccountNumber || '',
            'IFSC Code': s.shipmentDetails?.ifscCode || s.user?.kycData?.ifscCode || '',
            'Payment Mode': s.serviceDetails?.paymentMode || 'Wallet'
        };
    });

    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Daily Booking Report');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

/**
 * Execute the Daily Report compilation and email dispatch
 */
const runDailyReportJob = async () => {
    if (isRunning) {
        console.warn('[DailyReportWorker] Job is already running. Skipping execution.');
        return { success: false, skipped: true };
    }

    isRunning = true;
    console.log('[DailyReportWorker] Starting Daily Booking Report Job...');
    logger.info('[DailyReportWorker] Starting daily bookings report compilation...');

    try {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC + 5:30
        const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
        const istNow = new Date(utcTime + istOffset);

        const istYesterday = new Date(istNow);
        istYesterday.setDate(istYesterday.getDate() - 1);

        const startOfYesterdayIST = new Date(istYesterday);
        startOfYesterdayIST.setHours(0, 0, 0, 0);
        const startOfYesterday = new Date(startOfYesterdayIST.getTime() - istOffset);

        const endOfYesterdayIST = new Date(istYesterday);
        endOfYesterdayIST.setHours(23, 59, 59, 999);
        const endOfYesterday = new Date(endOfYesterdayIST.getTime() - istOffset);

        const shipments = await Shipment.find({
            createdAt: { $gte: startOfYesterday, $lte: endOfYesterday }
        }).populate('user', 'name kycData').lean();

        if (!shipments || shipments.length === 0) {
            console.log('[DailyReportWorker] No shipments found for yesterday. Sending notification email...');
            await sendEmail({
                email: process.env.DAILY_REPORT_RECIPIENTS || 'kaushal.tech@thedflgroup.com,rg@thedflgroup.com,express.ops@thedflgroup.com',
                subject: 'Daily DFL Booking Report - No Bookings',
                html: `<p>Hello Team,</p><p>There were no bookings recorded in the system yesterday (${startOfYesterday.toLocaleDateString('en-GB')}).</p><br/><p>Best Regards,<br/>DFL Automated System</p>`
            });
            return { success: true, count: 0 };
        }

        const excelBuffer = generateDailyReportExcel(shipments);
        const fileName = `Daily_Report_${startOfYesterday.toISOString().split('T')[0]}.xlsx`;

        await sendEmail({
            email: process.env.DAILY_REPORT_RECIPIENTS || 'kaushal.tech@thedflgroup.com,rg@thedflgroup.com,express.ops@thedflgroup.com',
            subject: `Daily DFL Booking Report - ${startOfYesterday.toLocaleDateString('en-GB')}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #0b4f6c;">Daily DFL Booking Report</h2>
                    <p>Hello Team,</p>
                    <p>Please find attached the automated Daily Booking Report. This report contains details of all shipments booked during yesterday (${startOfYesterday.toLocaleDateString('en-GB')}).</p>
                    <p>Total Bookings: <strong>${shipments.length}</strong></p>
                    <br/>
                    <p>Best Regards,</p>
                    <p><strong>DFL Operations Team</strong></p>
                </div>
            `,
            attachments: [
                {
                    filename: fileName,
                    content: excelBuffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ]
        });

        console.log(`[DailyReportWorker] Successfully compiled and sent report for ${shipments.length} shipments.`);
        logger.info(`[DailyReportWorker] Successfully compiled and sent report for ${shipments.length} shipments.`);
        return { success: true, count: shipments.length };

    } catch (error) {
        console.error('[DailyReportWorker] Error running daily report job:', error);
        logger.error('[DailyReportWorker] Error running daily report job:', error.message);
        return { success: false, error: error.message };
    } finally {
        isRunning = false;
    }
};

/**
 * Setup daily cron at 9:30 AM (Asia/Kolkata timezone)
 */
const setupDailyReportCron = () => {
    // 30 9 * * * corresponds to 9:30 AM daily
    const cronSchedule = '30 9 * * *';
    const timezone = 'Asia/Kolkata';

    cron.schedule(cronSchedule, () => {
        runDailyReportJob();
    }, {
        scheduled: true,
        timezone
    });

    console.log(`[DailyReportWorker] Scheduled daily report job at ${cronSchedule} in ${timezone} timezone.`);
    logger.info(`[DailyReportWorker] Scheduled daily report job at ${cronSchedule} in ${timezone} timezone.`);
};

module.exports = {
    setupDailyReportCron,
    runDailyReportJob,
    generateDailyReportExcel
};
