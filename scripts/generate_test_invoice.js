const { createInvoiceBuffer } = require('../utils/pdfGenerator');
const fs = require('fs');
const path = require('path');

const run = async () => {
    const mockInvoiceData = {
        invoiceId: 'INV/2026/001',
        invoiceDate: new Date(),
        currency: 'INR',
        paymentTerms: 'Prepaid',
        billedTo: {
            name: 'John Doe',
            address: '123 Main St, Connaught Place',
            city: 'New Delhi',
            country: 'India',
            phone: '+91 99999 88888',
            email: 'john@example.com',
            gstin: '07ABCDE1234F1Z5'
        },
        lineItems: [
            { description: 'Freight Charges', amount: 1500 },
            { description: 'Fuel Surcharge', amount: 200 }
        ],
        subtotal: 1700,
        tax: {
            type: 'IGST',
            rate: 18,
            amount: 306
        },
        totalAmount: 2006
    };

    const mockShipment = {
        trackingId: '9876543210',
        createdAt: new Date(),
        shipmentDetails: {
            shipmentMode: 'Air',
            boxes: [{ weight: 5 }, { weight: 3 }]
        },
        serviceDetails: {
            serviceName: 'Express Premium',
            chargeableWeight: 8
        },
        shipperDetails: {
            city: 'Mumbai',
            country: 'India'
        },
        consigneeDetails: {
            city: 'London',
            country: 'United Kingdom'
        }
    };

    try {
        console.log("Generating PDF...");
        const buffer = await createInvoiceBuffer(mockInvoiceData, mockShipment);

        const outputPath = path.join(__dirname, '../../Frontend/public/test_invoice.pdf');
        fs.writeFileSync(outputPath, buffer);

        console.log(`PDF Generated successfully at: ${outputPath}`);
    } catch (err) {
        console.error("Error generating PDF:", err);
    }
};

run();
