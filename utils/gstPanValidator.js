/**
 * GSTIN - PAN Validation Utility
 * Format of GSTIN (15 characters):
 * - 2 digits: State code
 * - 10 characters (index 2-12): PAN of the entity
 * - 1 character: Entity number of same PAN in the state
 * - 1 character: 'Z' by default
 * - 1 character: Check digit
 */

const validateGstPanMatch = (gstNumber, panNumber) => {
    if (!gstNumber) {
        return { isMatch: true, reason: 'No GSTIN provided' };
    }

    const cleanGst = String(gstNumber).trim().toUpperCase();
    const cleanPan = panNumber ? String(panNumber).trim().toUpperCase() : '';

    // Extract PAN from GSTIN if at least 12 characters
    const extractedPan = cleanGst.length >= 12 ? cleanGst.substring(2, 12) : '';

    if (!cleanPan) {
        return {
            isMatch: true,
            extractedPan: extractedPan || null,
            submittedPan: '',
            reason: 'No PAN provided for cross-check'
        };
    }

    if (extractedPan && cleanPan && extractedPan === cleanPan) {
        return {
            isMatch: true,
            extractedPan,
            submittedPan: cleanPan,
            reason: 'PAN matches GSTIN'
        };
    }

    if (!extractedPan) {
        return {
            isMatch: false,
            extractedPan: null,
            submittedPan: cleanPan,
            reason: `Invalid GSTIN length (${cleanGst.length} characters). Unable to extract PAN.`
        };
    }

    return {
        isMatch: false,
        extractedPan,
        submittedPan: cleanPan,
        reason: `The PAN extracted from the submitted GSTIN (${extractedPan}) does not match the submitted PAN (${cleanPan}).`
    };
};

module.exports = {
    validateGstPanMatch
};
