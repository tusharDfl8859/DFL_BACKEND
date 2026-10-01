const { generateDFLBrandedLabel } = require('../utils/labelGenerator');
const fs = require('fs');
const path = require('path');

const mockShipment = {
    shipmentId: 'DFL12345678',
    trackingId: 'DFL987654321',
    createdAt: new Date(),
    shipperDetails: {
        shipperName: 'John Doe',
        addressLine1: '123 Business Park',
        city: 'New Delhi',
        pincode: '110001',
        country: 'India',
        mobileNo: '9876543210'
    },
    consigneeDetails: {
        consigneeName: 'Jane Smith',
        addressLine1: '456 Residential Ave',
        city: 'New York',
        state: 'NY',
        pincode: '10001',
        country: 'USA',
        mobileNo: '1234567890'
    },
    shipmentDetails: {
        boxes: [
            { weight: 2.5, length: 10, width: 10, height: 10 },
            { weight: 1.5, length: 10, width: 10, height: 10 }
        ]
    }
};

async function test() {
    try {
        console.log('Generating mock DFL label...');
        const buffer = await generateDFLBrandedLabel(mockShipment);
        const outputPath = path.join(__dirname, 'test-label-dfl.pdf');
        fs.writeFileSync(outputPath, buffer);
        console.log(`Success! DFL Label saved to: ${outputPath}`);

    } catch (err) {
        console.error('Failed to generate label:', err);
    }
}

test();
