/**
 * Date Utility Functions
 * Handles Timezone conversions (specifically IST) and Range calculations
 */

// IST Offset in milliseconds (UTC+5:30)
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

/**
 * Get Start and End Date for a given range in IST
 * If dates are provided, they are parsed as "Start of Day" and "End of Day" in IST
 * If not provided, returns "Today" in IST
 * @param {string} [startDate] - YYYY-MM-DD
 * @param {string} [endDate] - YYYY-MM-DD
 * @returns {{ start: Date, end: Date }}
 */
const getISTDateRange = (startDate, endDate) => {
    let start, end;

    if (startDate && endDate) {
        // Force start of day in IST (UTC+5:30)
        // e.g. "2026-01-14" -> "2026-01-14T00:00:00+05:30"
        start = new Date(`${startDate}T00:00:00+05:30`);
        end = new Date(`${endDate}T23:59:59.999+05:30`);
    } else {
        // Default to "Today" in Server Time (Approximation for simplicity, or strict IST if needed)
        start = new Date();
        start.setHours(0, 0, 0, 0);
        end = new Date();
        end.setHours(23, 59, 59, 999);
    }

    return { start, end };
};

/**
 * Get Previous Period Range for Comparison
 * @param {Date} start 
 * @param {Date} end 
 * @returns {{ previousStart: Date, previousEnd: Date }}
 */
const getPreviousPeriod = (start, end) => {
    // Check if range is roughly 1 day
    const isSingleDay = (end - start) < 86400000 + 1000;

    // Simple Logic: If single day, compare with yesterday. 
    // If range, could compare with previous N days, but for now we follow existing logic (Yesterday)
    // improving slightly to match duration if needed, but keeping existing behavior:

    const previousStart = new Date(start);
    previousStart.setDate(previousStart.getDate() - 1);

    // For single day comparison, we usually want the full previous day
    // For ranges, we might want to shift both back by the duration.
    // Existing logic was:
    // previousStart = start - 1 day
    // previousEnd = start (start of current period) - 1ms

    const previousEnd = new Date(start);
    previousEnd.setMilliseconds(-1);

    return { previousStart, previousEnd };
};

module.exports = {
    getISTDateRange,
    getPreviousPeriod
};
