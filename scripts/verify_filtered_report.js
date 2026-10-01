const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const adminController = require('../controllers/adminController');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const verifyReport = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        // 1. Find a Super Admin
        const superAdmin = await Admin.findOne({ role: 'super_admin' });
        if (!superAdmin) {
            console.error('No Super Admin found');
            process.exit(1);
        }
        console.log(`Found Super Admin: ${superAdmin.email} (${superAdmin._id})`);

        // 2. Find a Regular Admin (Team Member)
        // We look for role 'admin'
        let teamAdmin = await Admin.findOne({ role: 'admin' });

        if (!teamAdmin) {
            console.log('No Regular Admin (role: "admin") found. Checks will be limited to Super Admin.');
        } else {
            console.log(`Found Team Admin: ${teamAdmin.email} (${teamAdmin._id})`);
        }

        // Mock Response Object
        const mockRes = () => {
            const res = {};
            res.status = (code) => {
                res.statusCode = code;
                return res;
            };
            res.json = (data) => {
                res.jsonData = data;
                return res;
            };
            return res;
        };

        // 3. Get Report for Super Admin
        console.log('\n--- Super Admin Report ---');
        // Mock req with query for "All Time" effectively or default (Today)
        // Let's use a wide range to ensure we capture data
        const reqSuper = {
            query: { startDate: '2023-01-01', endDate: new Date().toISOString() },
            user: superAdmin
        };
        const resSuper = mockRes();
        await adminController.getDailyReport(reqSuper, resSuper);

        let superStats = {};

        if (resSuper.jsonData) {
            superStats = resSuper.jsonData.kpi;
            console.log('Super Admin KPI:', JSON.stringify(superStats, null, 2));
        } else {
            console.error('Super Admin Report Failed');
        }

        // 4. Get Report for Team Admin
        if (teamAdmin) {
            console.log('\n--- Team Admin Report ---');

            // Check how many users are assigned to this admin
            const allocatedCount = await User.countDocuments({ assignedTo: teamAdmin._id });
            console.log(`Users explicitly assigned to ${teamAdmin.email}: ${allocatedCount}`);

            const reqTeam = {
                query: { startDate: '2023-01-01', endDate: new Date().toISOString() },
                user: teamAdmin
            };
            const resTeam = mockRes();
            await adminController.getDailyReport(reqTeam, resTeam);

            if (resTeam.jsonData) {
                const teamStats = resTeam.jsonData.kpi;
                console.log('Team Admin KPI:', JSON.stringify(teamStats, null, 2));

                // Verification logic
                // Team stats should be <= Super stats
                const revenueOk = teamStats.revenue <= superStats.revenue;
                const shipmentsOk = teamStats.shipments <= superStats.shipments;

                console.log(`\nVerification Results:`);
                console.log(`Revenue <= Super Admin: ${revenueOk} (${teamStats.revenue} <= ${superStats.revenue})`);
                console.log(`Shipments <= Super Admin: ${shipmentsOk} (${teamStats.shipments} <= ${superStats.shipments})`);

                if (allocatedCount === 0 && teamStats.activeUsers > 0) {
                    console.warn('WARNING: Admin has 0 assigned users but sees active users in report. Check logic.');
                } else if (allocatedCount > 0 && teamStats.activeUsers === 0) {
                    console.warn('INFO: Admin has assigned users but none are active in this period.');
                }

                if (revenueOk && shipmentsOk) {
                    console.log('SUCCESS: Filtering logic holds (Team Admin sees subset).');
                } else {
                    console.error('FAILURE: Team Admin sees MORE data than Super Admin.');
                }

            } else {
                console.error('Team Admin Report Failed');
            }
        }

        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

verifyReport();
