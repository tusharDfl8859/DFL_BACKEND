const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const Shipment = require('../models/Shipment');
const User = require('../models/User');

// Use provided URI
const MONGO_URI = 'mongodb+srv://tech_db_user:xxQpx3E4TSjv5RlJ@cluster0.yvr1yuw.mongodb.net/?appName=Cluster0';

const exportShipments = async () => {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected.');

        const customerId = 'DFLC-329812';
        console.log(`Finding user with Customer ID: ${customerId}`);
        const user = await User.findOne({ customerId });

        if (!user) {
            console.error('User not found!');
            process.exit(1);
        }
        console.log(`User found: ${user.name} (${user._id})`);

        console.log('Fetching CSB-V shipments...');
        // Note: checking specifically for 'csb5'
        const shipments = await Shipment.find({
            user: user._id,
            'shipmentDetails.shipmentCategory': 'csb5'
        }).lean();

        console.log(`Found ${shipments.length} CSB-V shipments.`);

        if (shipments.length === 0) {
            console.log('No shipments found. Exiting.');
            process.exit(0);
        }

        const data = shipments.map(s => {
            const latestTracking = s.trackingHistory && s.trackingHistory.length > 0
                ? s.trackingHistory[0]
                : null;

            return {
                'Shipment ID': s.shipmentId,
                'Date': s.createdAt ? new Date(s.createdAt).toLocaleDateString() : 'N/A',
                'Consignee': s.consigneeDetails?.consigneeName || 'N/A',
                'Destination': s.consigneeDetails?.country || 'N/A',
                'Status': s.status,
                'Tracking ID': s.trackingId || 'N/A',
                'Carrier': s.trackingCarrier || 'Speedbox',
                'Latest Activity': latestTracking ? latestTracking.description : 'N/A',
                'Latest Location': latestTracking ? latestTracking.location : 'N/A',
                'Latest Time': latestTracking ? new Date(latestTracking.timestamp).toLocaleString() : 'N/A'
            };
        });

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(data);
        xlsx.utils.book_append_sheet(wb, ws, 'CSB-V Shipments');

        // Create exports directory if it doesn't exist
        const exportDir = path.join(__dirname, '../exports');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const fileName = `CSB5_Shipments_${customerId}_${Date.now()}.xlsx`;
        const filePath = path.join(exportDir, fileName);

        xlsx.writeFile(wb, filePath);
        console.log(`SUCCESS: Exported to ${filePath}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
};

exportShipments();
