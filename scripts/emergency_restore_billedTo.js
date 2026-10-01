const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Shipment = require('../models/Shipment');

async function restore() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const corrupted = await Shipment.find({
            $or: [
                { 'invoice.billedTo': null },
                { 'invoice.billedTo': { $exists: false } },
                { 'invoice.billedTo.name': { $exists: false } }
            ]
        });

        console.log(`Found ${corrupted.length} corrupted shipments. Restoring billedTo...`);

        let fixedCount = 0;
        for (const shipment of corrupted) {
            // Restore billedTo from shipperDetails
            const s = shipment.shipperDetails;
            
            const street1 = s.addressLine1 || '';
            const street2 = s.addressLine2 || '';
            const fullAddress = `${street1}${street2 ? ', ' + street2 : ''}, ${s.city}, ${s.state}, ${s.country} - ${s.pincode}`;

            shipment.invoice.billedTo = {
                name: s.shipperName || '',
                companyName: s.companyName || '',
                address: fullAddress,
                city: s.city || '',
                state: s.state || '',
                country: s.country || '',
                pincode: s.pincode || '',
                phone: s.mobileNo || '',
                email: s.email || '',
                gstin: shipment.user?.kycData?.gstNumber || ''
            };

            // Set mandatory flags for regeneration
            shipment.invoice.status = 'Draft';
            shipment.invoice.pdfUrl = null;

            await shipment.save({ validateBeforeSave: false });
            fixedCount++;
        }

        console.log(`Restoration complete! ${fixedCount} shipments fixed.`);
        await mongoose.disconnect();
    } catch (error) {
        console.error('Restoration failed:', error);
        process.exit(1);
    }
}

restore();
