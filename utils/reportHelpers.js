/**
 * Report Helper Functions
 * Contains reusable Aggregation Stages and Filter logic
 */

const User = require('../models/User');

/**
 * Reusable $convert stage for Price strings ("₹ 1,200") to Double
 */
const CONVERT_PRICE_TO_DOUBLE = {
    $convert: {
        input: {
            $trim: {
                input: {
                    $replaceAll: {
                        input: {
                            $replaceAll: {
                                input: { $toString: "$serviceDetails.price" },
                                find: ",",
                                replacement: ""
                            }
                        },
                        find: "₹",
                        replacement: ""
                    }
                }
            }
        },
        to: "double",
        onError: 0,
        onNull: 0
    }
};

/**
 * Reusable $convert stage for Weight strings ("10 kg") to Double
 */
const CONVERT_WEIGHT_TO_DOUBLE = {
    $convert: {
        input: {
            $trim: {
                input: {
                    $replaceAll: {
                        input: {
                            $replaceAll: {
                                input: {
                                    $toString: {
                                        $ifNull: [
                                            "$serviceDetails.chargeableWeight",
                                            {
                                                $ifNull: [
                                                    "$serviceDetails.weight",
                                                    {
                                                        $ifNull: [
                                                            "$totalWeight",
                                                            { $ifNull: ["$chargeableWeight", "0"] }
                                                        ]
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                },
                                find: "kg",
                                replacement: ""
                            }
                        },
                        find: "KG",
                        replacement: ""
                    }
                }
            }
        },
        to: "double",
        onError: 0,
        onNull: 0
    }
};


/**
 * Extract weight in KG from shipment document safely in JS
 */
const extractShipmentWeight = (s) => {
    if (!s) return 0;

    const parseNum = (val) => {
        if (val === null || val === undefined) return 0;
        if (typeof val === 'number') return isNaN(val) ? 0 : val;
        if (typeof val === 'string') {
            const cleaned = val.replace(/,/g, '').trim();
            const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)/);
            return match ? parseFloat(match[1]) || 0 : 0;
        }
        return 0;
    };

    // Priority 1: serviceDetails.chargeableWeight
    let w = parseNum(s.serviceDetails?.chargeableWeight);
    if (w > 0) return w;

    // Priority 2: serviceDetails.weight
    w = parseNum(s.serviceDetails?.weight);
    if (w > 0) return w;

    // Priority 3: Sum of boxes (shipmentDetails.boxes or boxes)
    const boxes = s.shipmentDetails?.boxes || s.boxes;
    if (Array.isArray(boxes) && boxes.length > 0) {
        const boxSum = boxes.reduce((acc, box) => {
            const bw = parseNum(box.chargeableWeight) || parseNum(box.weight) || parseNum(box.actualWeight);
            return acc + bw;
        }, 0);
        if (boxSum > 0) return boxSum;
    }

    // Priority 4: Top-level totalWeight or chargeableWeight
    w = parseNum(s.totalWeight);
    if (w > 0) return w;

    w = parseNum(s.chargeableWeight);
    if (w > 0) return w;

    return 0;
};

/**
 * @param {Object} admin - The admin user object from request
 * @returns {Promise<{ generalFilter: Object, userFilter: Object }>}
 */
const getRoleBasedFilters = async (admin) => {
    let generalFilter = {}; // For items referencing user (Shipment, Transaction)
    let userFilter = {};    // For User items

    if (admin.role === 'member') {
        // Find all users assigned to this admin
        // Note: We use the Model directly here. Alternatively passes allocatedUserIds if fetched outside.
        const allocatedUsers = await User.find({ assignedTo: admin._id }).select('_id');
        const allocatedUserIds = allocatedUsers.map(u => u._id);

        generalFilter = { user: { $in: allocatedUserIds } };
        userFilter = { _id: { $in: allocatedUserIds } };
    }

    return { generalFilter, userFilter };
};

module.exports = {
    CONVERT_PRICE_TO_DOUBLE,
    CONVERT_WEIGHT_TO_DOUBLE,
    extractShipmentWeight,
    getRoleBasedFilters
};

