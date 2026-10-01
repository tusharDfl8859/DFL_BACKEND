const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const Announcement = require('../models/Announcement');
const Admin = require('../models/Admin');

const message = `⚠️ Air Freight Rate Advisory

Due to ongoing global conditions, fluctuations in airline capacity, and the possibility of flight schedule changes or cancellations, air freight rates may be subject to change without prior notice.

All rates displayed on this portal are indicative in nature and are subject to final airline confirmation and space availability at the time of booking and/or prior to flight departure. In the event of any airline rate revision or operational change, the updated freight charges will be communicated accordingly.

We appreciate your understanding and cooperation during this period of dynamic airline operations.`;

async function createAnnouncement() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const admin = await Admin.findOne({ role: { $in: ['super_admin', 'admin'] } });
        if (!admin) {
            console.error('No admin found to create announcement');
            process.exit(1);
        }

        // Deactivate old announcements if any, or just add this one as active
        // The user said "raise a announcement", so I'll create it.

        const announcement = await Announcement.create({
            title: 'Air Freight Rate Advisory',
            message: message,
            type: 'warning',
            priority: 'high',
            targetAudience: 'all',
            isActive: true,
            createdBy: admin._id
        });

        console.log('Announcement created:', announcement._id);
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

createAnnouncement();
