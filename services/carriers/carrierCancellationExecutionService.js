const Shipment = require('../../models/Shipment');
const carrierBookingService = require('./CarrierBookingService');
const {
    DEVELOPER_AUDIT_ACTIONS,
    PARTNER_API_CANCELLATION_STATUSES,
    SHIPMENT_BOOKING_SOURCES
} = require('../../constants/developerPortal');
const { getCarrierIdentifier } = require('./carrierBookingExecutionService');

const CARRIER_CANCELLATION_RESULTS = Object.freeze({
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
    RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
    STATUS_UNKNOWN: 'STATUS_UNKNOWN',
    FAILED_FINAL: 'FAILED_FINAL',
    NOT_SUPPORTED: 'NOT_SUPPORTED'
});

const safeReferencePart = (value) => String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

const buildCancellationReference = ({ shipment, cancellation }) => (
    `DFL-CANCEL-${safeReferencePart(shipment.developerAccountId)}-${safeReferencePart(shipment.partnerApiBookingId)}-${safeReferencePart(cancellation.cancellationId)}`
).slice(0, 180);

const normalizeCancellationResult = (result = {}) => {
    const status = String(result.status || '').toUpperCase();
    if (status === CARRIER_CANCELLATION_RESULTS.CANCELLED || result.cancelled || result.success) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.CANCELLED,
            carrierCancellationReference: result.carrierCancellationReference || result.reference || null,
            carrier: result.carrier || null,
            message: result.message || 'Carrier cancellation confirmed.'
        };
    }
    if (status === CARRIER_CANCELLATION_RESULTS.REJECTED || result.rejected) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.REJECTED,
            carrier: result.carrier || null,
            message: result.message || 'Carrier rejected cancellation.'
        };
    }
    if (status === CARRIER_CANCELLATION_RESULTS.STATUS_UNKNOWN || result.statusUnknown) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.STATUS_UNKNOWN,
            carrier: result.carrier || null,
            message: result.message || 'Carrier cancellation status is unknown.'
        };
    }
    if (status === CARRIER_CANCELLATION_RESULTS.NOT_SUPPORTED || result.unsupported) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.NOT_SUPPORTED,
            carrier: result.carrier || null,
            message: result.message || 'Carrier cancellation lookup is not supported.'
        };
    }
    if (result.isRetryable || status === CARRIER_CANCELLATION_RESULTS.RETRYABLE_FAILURE) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.RETRYABLE_FAILURE,
            carrier: result.carrier || null,
            message: result.message || result.error || 'Retryable carrier cancellation failure.'
        };
    }
    return {
        status: CARRIER_CANCELLATION_RESULTS.FAILED_FINAL,
        carrier: result.carrier || null,
        message: result.message || result.error || 'Carrier cancellation failed.'
    };
};

const cancelShipment = async ({ shipmentId, cancellation, executionSource = 'WORKER' }) => {
    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) throw new Error('Shipment not found for carrier cancellation.');
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        throw new Error('Carrier cancellation can process Partner API shipments only.');
    }
    if (shipment.cancellationStatus === PARTNER_API_CANCELLATION_STATUSES.CANCELLED) {
        return {
            status: CARRIER_CANCELLATION_RESULTS.CANCELLED,
            alreadyCancelled: true,
            carrierCancellationReference: shipment.carrierCancellationReference
        };
    }

    const carrierIdentifier = carrierBookingService.normalizeCarrier(getCarrierIdentifier(shipment));
    const cancellationReference = shipment.carrierCancellationReference || buildCancellationReference({ shipment, cancellation });
    const result = normalizeCancellationResult(await carrierBookingService.cancelByShipment(
        shipment,
        carrierIdentifier,
        cancellationReference
    ));

    return {
        ...result,
        carrierIdentifier,
        cancellationReference,
        executionSource,
        auditAction: result.status === CARRIER_CANCELLATION_RESULTS.CANCELLED
            ? DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_CANCELLATION_CONFIRMED
            : DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_CANCELLATION_REJECTED
    };
};

const reconcileCancellation = async ({ shipment, cancellation }) => {
    const carrierIdentifier = carrierBookingService.normalizeCarrier(getCarrierIdentifier(shipment));
    const cancellationReference = shipment.carrierCancellationReference || buildCancellationReference({ shipment, cancellation });
    const result = await carrierBookingService.findCancellationByReference(carrierIdentifier, cancellationReference);
    return normalizeCancellationResult(result);
};

module.exports = {
    CARRIER_CANCELLATION_RESULTS,
    buildCancellationReference,
    cancelShipment,
    reconcileCancellation
};
