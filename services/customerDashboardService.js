const Shipment = require('../models/Shipment');

const PERIODS = ['this_month', 'last_month', 'last_3_months', 'last_6_months', 'this_year', 'all_time'];

const ACTIVE_STATUSES = [
    'In Transit',
    'Pending',
    'Out for Delivery',
    'Processing',
    'Shipment Received at Our Hub',
    'Received at Destination Hub',
    'Shipment Dispatched'
];

const ALERT_STATUSES = ['Dispute Raised', 'On Hold', 'Cancelled', 'Exception'];

const STATUS_LABELS = {
    pending: 'Pending',
    processing: 'Processing',
    'shipment received at our hub': 'Shipment Received at Our Hub',
    'received at destination hub': 'Received at Destination Hub',
    'shipment dispatched': 'Shipment Dispatched',
    'in transit': 'In Transit',
    'out for delivery': 'Out for Delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    'on hold': 'On Hold',
    'dispute raised': 'Dispute Raised',
    'dispute resolved': 'Dispute Resolved',
    exception: 'Exception',
    rto: 'RTO',
    bulk: 'Bulk'
};

const normalizeStatusKey = (status) => (
    String(status || '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
);

const toTitleCase = (value) => (
    String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
);

const canonicalStatusLabel = (status) => {
    const key = normalizeStatusKey(status);
    const receivedHubMatch = key.match(/^received in (.+) hub$/);

    if (receivedHubMatch) {
        return `Received in ${toTitleCase(receivedHubMatch[1])} Hub`;
    }

    return STATUS_LABELS[key] || String(status || 'Unknown').trim() || 'Unknown';
};

const getDateRanges = (now = new Date()) => {
    const endOfDay = (date) => {
        const next = new Date(date);
        next.setHours(23, 59, 59, 999);
        return next;
    };

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));

    return {
        this_month: {
            start: thisMonthStart,
            end: endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0))
        },
        last_month: {
            start: lastMonthStart,
            end: lastMonthEnd
        },
        last_3_months: {
            start: new Date(now.getFullYear(), now.getMonth() - 2, 1),
            end: endOfDay(now)
        },
        last_6_months: {
            start: new Date(now.getFullYear(), now.getMonth() - 5, 1),
            end: endOfDay(now)
        },
        this_year: {
            start: new Date(now.getFullYear(), 0, 1),
            end: endOfDay(now)
        },
        all_time: null
    };
};

const priceToNumberExpression = {
    $convert: {
        input: {
            $replaceAll: {
                input: {
                    $trim: {
                        input: { $toString: '$serviceDetails.price' },
                        chars: '₹ '
                    }
                },
                find: ',',
                replacement: ''
            }
        },
        to: 'double',
        onError: 0,
        onNull: 0
    }
};

const dateRangeMatchExpression = (range) => {
    if (!range) return true;

    return {
        $and: [
            { $gte: ['$createdAt', range.start] },
            { $lte: ['$createdAt', range.end] }
        ]
    };
};

const buildStatusAggregation = (userId, ranges) => {
    const groupStage = {
        _id: '$status',
        all_time: { $sum: 1 },
        monthlySpend: {
            $sum: {
                $cond: [
                    dateRangeMatchExpression(ranges.this_month),
                    priceToNumberExpression,
                    0
                ]
            }
        }
    };

    PERIODS.filter((period) => period !== 'all_time').forEach((period) => {
        groupStage[period] = {
            $sum: {
                $cond: [
                    dateRangeMatchExpression(ranges[period]),
                    1,
                    0
                ]
            }
        };
    });

    return [
        { $match: { user: userId } },
        { $group: groupStage }
    ];
};

const addAllCount = (counts) => ({
    ...counts,
    All: Object.values(counts).reduce((sum, count) => sum + count, 0)
});

const getCount = (counts, status) => counts[status] || 0;

const buildSummaryFromStatusRows = (rows) => {
    const statusCountsByPeriod = PERIODS.reduce((acc, period) => {
        acc[period] = {};
        return acc;
    }, {});

    let totalSpend = 0;

    rows.forEach((row) => {
        const status = canonicalStatusLabel(row._id);
        totalSpend += row.monthlySpend || 0;

        PERIODS.forEach((period) => {
            const count = row[period] || 0;
            if (count > 0) {
                statusCountsByPeriod[period][status] = (statusCountsByPeriod[period][status] || 0) + count;
            }
        });
    });

    PERIODS.forEach((period) => {
        statusCountsByPeriod[period] = addAllCount(statusCountsByPeriod[period]);
    });

    const allTimeCounts = statusCountsByPeriod.all_time;
    const alertCounts = ALERT_STATUSES.reduce((acc, status) => {
        acc[status] = getCount(allTimeCounts, status);
        return acc;
    }, {});

    return {
        stats: {
            totalSpend,
            activeCount: ACTIVE_STATUSES.reduce((sum, status) => sum + getCount(allTimeCounts, status), 0),
            deliveredCount: getCount(allTimeCounts, 'Delivered'),
            inTransitCount: getCount(allTimeCounts, 'In Transit')
        },
        statusCountsByPeriod,
        alertCounts
    };
};

const getCustomerDashboardSummary = async (userId) => {
    const ranges = getDateRanges();

    const [recentShipments, statusRows] = await Promise.all([
        Shipment.find({ user: userId })
            .select('shipmentId status createdAt shipperDetails.city consigneeDetails.city serviceDetails.price')
            .sort({ createdAt: -1 })
            .limit(6)
            .lean(),
        Shipment.aggregate(buildStatusAggregation(userId, ranges))
    ]);

    return {
        recentShipments,
        ...buildSummaryFromStatusRows(statusRows)
    };
};

module.exports = {
    getCustomerDashboardSummary
};
