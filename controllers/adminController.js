const authController = require('./admin/authController');
const userController = require('./admin/userController');
const shipmentController = require('./admin/shipmentController');
const queryController = require('./admin/queryController');
const reportController = require('./admin/reportController');
const dashboardController = require('./admin/dashboardController');
const bulkController = require('./admin/bulkController');

module.exports = {
    // Auth
    authAdmin: authController.authAdmin,
    verifyLoginOtp: authController.verifyLoginOtp,
    sendAdminOtp: authController.sendAdminOtp,
    sendFinanceOtp: authController.sendFinanceOtp,
    verifyFinanceOtp: authController.verifyFinanceOtp,

    // User Management
    getUsers: userController.getUsers,
    getUserById: userController.getUserById,
    assignUser: userController.assignUser,
    verifyUser: userController.verifyUser,
    reviewFranchiseCustomerFinalKyc: userController.reviewFranchiseCustomerFinalKyc,
    deleteUser: userController.deleteUser,
    updateUserTag: userController.updateUserTag,
    updateUserMarkup: userController.updateUserMarkup,
    createAdmin: userController.createAdmin,
    createTeamMember: userController.createTeamMember,
    getTeamMembers: userController.getTeamMembers,
    deleteTeamMember: userController.deleteTeamMember,
    updateTeamMember: userController.updateTeamMember,
    getTeamMemberStats: userController.getTeamMemberStats,
    resetUserPassword: userController.resetUserPassword,
    getUserWalletHistory: userController.getUserWalletHistory,
    exportUserWalletHistory: userController.exportUserWalletHistory,
    exportAllWalletHistory: userController.exportAllWalletHistory,
    toggleUserRestriction: userController.toggleUserRestriction,
    updateUserExemption: userController.updateUserExemption,
    exportUsers: userController.exportUsers,
    getInactiveUsers: userController.getInactiveUsers,
    triggerBulkEmail: userController.triggerBulkEmail,
    sendBulkCustomEmail: userController.sendBulkCustomEmail,
    syncUserActivity: userController.syncUserActivity,
    updateUserBranch: userController.updateUserBranch,
    updateTeamMemberBranch: userController.updateTeamMemberBranch,
    sendKycEditOtp: userController.sendKycEditOtp,
    updateUserKycBySuperAdmin: userController.updateUserKycBySuperAdmin,
    uploadKycDocToCloudinary: userController.uploadKycDocToCloudinary,
    updateUserCredentials: userController.updateUserCredentials,

    // Shipment Management
    getAllShipments: shipmentController.getAllShipments,
    getShipmentById: shipmentController.getShipmentById,
    updateShipmentStatus: shipmentController.updateShipmentStatus,
    updateShipmentTrackingId: shipmentController.updateShipmentTrackingId,
    exportShipments: shipmentController.exportShipments,
    deleteShipment: shipmentController.deleteShipment,

    // Queries
    getAllQueries: queryController.getAllQueries,
    getQueryById: queryController.getQueryById,
    updateQueryStatus: queryController.updateQueryStatus,
    assignQuery: queryController.assignQuery,
    sendCustomQuote: queryController.sendCustomQuote,

    // Reports
    getDailyReport: reportController.getDailyReport,
    getDailyReportDetails: reportController.getDailyReportDetails,
    getSalesPersonReport: reportController.getSalesPersonReport,
    getSalesPersonShipments: reportController.getSalesPersonShipments,

    // Dashboard & Announcements
    getDashboardStats: dashboardController.getDashboardStats,
    createAnnouncement: dashboardController.createAnnouncement,
    getAllAnnouncements: dashboardController.getAllAnnouncements,
    deleteAnnouncement: dashboardController.deleteAnnouncement,
    toggleAnnouncement: dashboardController.toggleAnnouncement,
    getLogs: dashboardController.getLogs,
    getUserSessionsAPI: dashboardController.getUserSessionsAPI,
    exportUserActivityToExcel: dashboardController.exportUserActivityToExcel,
    forceRefreshRates: dashboardController.forceRefreshRates,

    // Bulk Operations & Manifests
    getAllManifests: bulkController.getAllManifests,
    getManifestById: bulkController.getManifestById,
    getAllBulkUploads: bulkController.getAllBulkUploads,
    getBulkUploadById: bulkController.getBulkUploadById,
    updateBulkUploadStatus: bulkController.updateBulkUploadStatus,

    // Carrier Booking Logs
    getCarrierBookingLogs: dashboardController.getCarrierBookingLogs,

    // System Health
    getSystemHealth: dashboardController.getSystemHealth
};
