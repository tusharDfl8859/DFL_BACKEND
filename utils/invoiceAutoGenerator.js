const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { generateInvoicePDF } = require('./pdfGenerator');

const toTitleCase = (str) => {
    if (!str) return '';
    return str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

/**
 * Automatically builds invoice data, generates the official DFL invoice PDF,
 * uploads it to Cloudinary, and locks the invoice with status 'Generated'.
 * (Native DFL system only - No Zoho sync).
 * 
 * @param {string|Object} shipmentOrId - Shipment document or Shipment ObjectId
 * @returns {Promise<Object>} Updated shipment with locked invoice
 */
const autoGenerateAndLockInvoice = async (shipmentOrId) => {
    try {
        let shipment = null;
        if (typeof shipmentOrId === 'string' || shipmentOrId._id === undefined) {
            shipment = await Shipment.findById(shipmentOrId).populate('user');
        } else {
            shipment = shipmentOrId;
            if (!shipment.user || typeof shipment.user === 'string') {
                shipment = await Shipment.findById(shipment._id).populate('user');
            }
        }

        if (!shipment) {
            console.error('[AutoInvoice] Shipment not found for auto invoice generation');
            return null;
        }

        // 1. Calculate Pricing & Tax Breakdown
        const priceStr = String(shipment.serviceDetails?.price || '0');
        const totalPrice = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
        const surcharge = parseFloat(shipment.serviceDetails?.countrySurcharge) || 0;
        const taxRate = 18;

        const baseCost = totalPrice / (1 + (taxRate / 100));
        const taxAmount = totalPrice - baseCost;
        const basePrice = Math.max(0, baseCost - surcharge);

        // 2. Determine GST Tax Type (CGST + SGST vs IGST)
        const isUP = (
            shipment.invoice?.billedTo?.gstin?.startsWith('09') ||
            shipment.user?.kycData?.gstNumber?.startsWith('09') ||
            shipment.user?.kycData?.billingAddress?.state?.toLowerCase().includes('uttar pradesh') ||
            shipment.user?.kycData?.billingAddress?.state?.toLowerCase().includes('up') ||
            shipment.shipperDetails?.state?.toLowerCase().includes('uttar pradesh') ||
            shipment.shipperDetails?.state?.toLowerCase().includes('up')
        );
        const taxType = isUP ? 'CGST + SGST' : 'IGST';

        // 3. Format Billed-To Details
        const billToCountry = shipment.shipperDetails?.country || 'India';
        const formattedAddress = [
            shipment.shipperDetails?.addressLine1,
            shipment.shipperDetails?.addressLine2,
            shipment.shipperDetails?.city,
            shipment.shipperDetails?.state,
            `${billToCountry}${shipment.shipperDetails?.pincode ? ' - ' + shipment.shipperDetails.pincode : ''}`
        ].filter(Boolean).join(', ');

        const billedTo = {
            name: toTitleCase(shipment.shipperDetails?.shipperName || shipment.user?.name || 'Customer'),
            companyName: toTitleCase(shipment.shipperDetails?.companyName || shipment.user?.companyName || ''),
            address: toTitleCase(formattedAddress),
            city: toTitleCase(shipment.shipperDetails?.city || ''),
            state: toTitleCase(shipment.shipperDetails?.state || ''),
            country: toTitleCase(billToCountry),
            pincode: shipment.shipperDetails?.pincode || '',
            phone: shipment.shipperDetails?.mobileNo || shipment.user?.phone || '',
            email: shipment.shipperDetails?.email || shipment.user?.email || '',
            gstin: shipment.user?.kycData?.gstNumber || shipment.invoice?.billedTo?.gstin || ''
        };

        // 4. Construct Itemized Line Items
        const lineItems = [
            {
                description: 'Shipping Charges',
                sacCode: '9968',
                amount: Number(basePrice.toFixed(2))
            }
        ];

        if (surcharge > 0) {
            lineItems.push({
                description: 'Fuel/Country Surcharge',
                sacCode: '9968',
                amount: Number(surcharge.toFixed(2))
            });
        }

        const invoiceId = `INV-${shipment.shipmentId}`;
        const invoiceDate = new Date().toISOString().split('T')[0];

        const invoiceData = {
            invoiceId,
            invoiceDate,
            currency: 'INR',
            paymentTerms: 'Prepaid',
            billedTo,
            lineItems,
            tax: {
                type: taxType,
                rate: taxRate,
                amount: Number(taxAmount.toFixed(2))
            },
            subtotal: Number(baseCost.toFixed(2)),
            totalAmount: Number(totalPrice.toFixed(2)),
            status: 'Generated'
        };

        // 5. Generate PDF via PDFKit and upload to Cloudinary
        const pdfUrl = await generateInvoicePDF(invoiceData, shipment);

        // 6. Update and Lock Shipment Invoice in MongoDB
        shipment.invoice = {
            ...invoiceData,
            status: 'Generated',
            pdfUrl: pdfUrl
        };

        if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
        if (!shipment.shipmentDetails.invoiceNumber) {
            shipment.shipmentDetails.invoiceNumber = invoiceId;
        }

        shipment.markModified('invoice');
        shipment.markModified('shipmentDetails');

        await shipment.save({ validateBeforeSave: false });

        console.log(`[AutoInvoice] ✅ Invoice automatically generated and locked for Shipment ${shipment.shipmentId}: ${pdfUrl}`);
        return shipment;
    } catch (error) {
        console.error(`[AutoInvoice] ❌ Error generating automatic invoice:`, error.message);
        return null;
    }
};

module.exports = {
    autoGenerateAndLockInvoice
};
