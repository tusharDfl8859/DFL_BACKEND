/**
 * CarrierBookingService
 * 
 * Unified service for booking shipments across all carriers.
 * Provides a single interface that automatically selects the appropriate
 * carrier adapter based on the service/carrier name.
 */

const fs = require('fs');
const path = require('path');
const SkynetAdapter = require('./adapters/SkynetAdapter');
const TPLAdapter = require('./adapters/TPLAdapter');
const UnitedAdapter = require('./adapters/UnitedAdapter');  // Future
const EnviaAdapter = require('./adapters/EnviaAdapter');
const WillowCommerceAdapter = require('./adapters/WillowCommerceAdapter');

const safeReferencePart = (value) => String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

class CarrierBookingService {
    constructor() {
        // Initialize adapters
        this.adapters = {
            SKYNET: new SkynetAdapter(),
            'SKYNET-ECOMMERCE': new SkynetAdapter('SKYNET-ECOMMERCE'),
            TPL: new TPLAdapter(),
            UNITED: new UnitedAdapter(),  // Future
            ENVIA: new EnviaAdapter(),
            WILLOW: new WillowCommerceAdapter(),
            WILLOWCOMMERCE: new WillowCommerceAdapter(),
        };


        // Carrier name mapping (normalize different names to adapter keys)
        this.carrierMap = {
            'Skynet': 'SKYNET',
            'SKYNET': 'SKYNET',
            'skynet': 'SKYNET',
            'skynet-ecommerce': 'SKYNET-ECOMMERCE',
            'SKYNET-ECOMMERCE': 'SKYNET-ECOMMERCE',
            'Skynet-ecommerce': 'SKYNET-ECOMMERCE',
            'SkynetEcommerce': 'SKYNET-ECOMMERCE',  // matches carrierConfig name field
            'skynetEcommerce': 'SKYNET-ECOMMERCE',
            'SKYNET_ECOMMERCE': 'SKYNET-ECOMMERCE',
            'TPL': 'TPL',
            'tpl': 'TPL',
            'United Courier': 'UNITED',
            'UNITED': 'UNITED',
            'Speedbox': 'SPEEDBOX',
            'SPEEDBOX': 'SPEEDBOX',
            'Envia': 'ENVIA',
            'ENVIA': 'ENVIA',
            'envia': 'ENVIA',
            '3rd Party': 'ENVIA',
            '3RD_PARTY': 'ENVIA',
            'WillowCommerce': 'WILLOW',
            'WILLOWCOMMERCE': 'WILLOW',
            'Willow Commerce': 'WILLOW',
            'WILLOW COMMERCE': 'WILLOW',
            'willow commerce': 'WILLOW',
            'Willow Commerce - US Express': 'WILLOW',
            'Willow': 'WILLOW',
            'WILLOW': 'WILLOW',
            'willow': 'WILLOW',
            'DFL Commerce Ground': 'WILLOW',
            'DFL COMMERCE GROUND': 'WILLOW',
            'DFL Commerce Uni Uni': 'WILLOW',
            'DFL COMMERCE UNI UNI': 'WILLOW',
            'DFL Commerce': 'WILLOW',
            'DFL COMMERCE': 'WILLOW'
        };

        // Numeric Carrier ID mapping matching service_config.json
        this.carrierCodeMap = {
            1: 'TPL',
            2: 'UNITED',
            3: 'SKYNET',
            4: 'SKYNET-ECOMMERCE',
            5: 'ENVIA',
            6: 'WILLOW'
        };
    }

    /**
     * Book a shipment with the appropriate carrier
     * @param {Object} shipment - Shipment document
     * @param {Object} user - User document (for KYC data)
     * @param {string|number} carrierIdentifier - Carrier name or carrierCode
     * @returns {Promise<{success: boolean, awb?: string, label?: string, labelUrl?: string, error?: string, fallbackToManual?: boolean, carrierRef?: string, carrier?: string, message?: string, isRetryable?: boolean}>}
     */
    async book(shipment, user, carrierIdentifier) {
        let normalizedCarrier;

        // If the identifier is a number or a string that represents a mapped number
        const codeKey = parseInt(carrierIdentifier);
        if (!isNaN(codeKey) && this.carrierCodeMap[codeKey]) {
            normalizedCarrier = this.carrierCodeMap[codeKey];
        } else {
            // Fallback to name map if string name (e.g. 'Skynet')
            normalizedCarrier = this.carrierMap[carrierIdentifier];
        }

        if (this.isSafeVerificationStubEnabled()) {
            return this.bookWithSafeVerificationStub(shipment, normalizedCarrier || this.normalizeCarrier(carrierIdentifier));
        }

        // Check if carrier is supported for API booking
        if (!normalizedCarrier || !this.adapters[normalizedCarrier]) {
            console.log(`[CarrierBookingService] Carrier ${carrierIdentifier} not supported for API booking, falling back to manual`);
            return {
                success: false,
                fallbackToManual: true,
                error: `Carrier ${carrierIdentifier} does not support API booking yet`
            };
        }

        // Carrier-Specific Kill Switch Check (Database-driven)
        try {
            const SystemConfig = require('../../models/SystemConfig');
            const config = await SystemConfig.findOne({ key: 'carrierApiToggles' });

            // If explicit OFF for THIS carrier, then skip. Otherwise default to ON.
            if (config && config.value && config.value[normalizedCarrier] === false) {
                console.warn(`[CarrierBookingService] KILL SWITCH ACTIVE for ${normalizedCarrier} (via DB): Skipping API booking`);
                return {
                    success: false,
                    fallbackToManual: true,
                    error: `Automated bookings for ${normalizedCarrier} are currently disabled by the administrator.`
                };
            }
        } catch (err) {
            console.error(`[CarrierBookingService] Error checking config for ${normalizedCarrier}, defaulting to ENABLED:`, err.message);
        }

        const adapter = this.adapters[normalizedCarrier];
        console.log(`[CarrierBookingService] Resolved adapter: ${normalizedCarrier} for identifier: ${carrierIdentifier}`);

        try {
            console.log(`[CarrierBookingService] Booking with ${normalizedCarrier}...`);

            const result = await adapter.book(shipment, user);

            console.log(`[CarrierBookingService] Booking successful! AWB: ${result.awbNo}`);

            return {
                success: true,
                awb: result.awbNo,
                forwardingNo: result.forwardingNo,
                label: result.label,
                labelUrl: result.labelUrl || null,
                encodedLabel: result.encodedLabel || null,
                carrierRef: result.carrierRef,
                message: result.message,
                carrier: normalizedCarrier
            };

        } catch (error) {
            console.error(`[CarrierBookingService] Booking failed:`, error.message);

            return {
                success: false,
                fallbackToManual: true,
                error: error.message,
                carrier: normalizedCarrier,
                isRetryable: error.isCarrierError && error.statusCode >= 500
            };
        }
    }

    /**
     * Track a shipment
     * @param {string} awb - AWB/Tracking number
     * @param {string} carrierName - Carrier name
     * @returns {Promise<Object>} - Tracking details
     */
    async track(awb, carrierName) {
        const normalizedCarrier = this.carrierMap[carrierName];

        if (!normalizedCarrier || !this.adapters[normalizedCarrier]) {
            throw new Error(`Carrier ${carrierName} not supported for tracking`);
        }

        return this.adapters[normalizedCarrier].track(awb);
    }

    /**
     * Generate manifest
     * @param {Array} shipmentIds - Shipment IDs to manifest
     * @param {string} carrierName - Carrier name
     * @param {Object} options - Additional manifest options
     * @returns {Promise<Object>} - Manifest details
     */
    async manifest(shipmentIds, carrierName, options = {}) {
        const normalizedCarrier = this.carrierMap[carrierName];

        if (!normalizedCarrier || !this.adapters[normalizedCarrier]) {
            throw new Error(`Carrier ${carrierName} not supported for manifest generation`);
        }

        return this.adapters[normalizedCarrier].manifest(
            shipmentIds,
            options.manifestDate,
            options.cdAwbNumber,
            options.courierName
        );
    }

    /**
     * Check if a carrier supports API booking
     * @param {string|number} carrierIdentifier - Carrier name or carrierCode
     * @returns {boolean}
     */
    supportsApiBooking(carrierIdentifier) {
        if (this.isSafeVerificationStubEnabled()) {
            return true;
        }
        const normalizedCarrier = this.normalizeCarrier(carrierIdentifier);
        return !!(normalizedCarrier && this.adapters[normalizedCarrier]);
    }

    normalizeCarrier(carrierIdentifier) {
        if (typeof carrierIdentifier === 'number' && this.carrierCodeMap[carrierIdentifier]) {
            return this.carrierCodeMap[carrierIdentifier];
        }
        const codeKey = parseInt(carrierIdentifier);
        if (!isNaN(codeKey) && this.carrierCodeMap[codeKey]) {
            return this.carrierCodeMap[codeKey];
        }
        return this.carrierMap[carrierIdentifier] || String(carrierIdentifier || '').toUpperCase();
    }

    async findByMerchantReference(carrierIdentifier, merchantReference) {
        const normalizedCarrier = this.normalizeCarrier(carrierIdentifier);
        if (this.isSafeVerificationStubEnabled()) {
            return this.findByMerchantReferenceWithSafeVerificationStub(normalizedCarrier, merchantReference);
        }
        const adapter = this.adapters[normalizedCarrier];
        if (!adapter || typeof adapter.findByMerchantReference !== 'function') {
            return {
                found: false,
                carrier: normalizedCarrier,
                unsupported: true
            };
        }
        return adapter.findByMerchantReference(merchantReference);
    }

    async cancelByShipment(shipment, carrierIdentifier, cancellationReference) {
        const normalizedCarrier = this.normalizeCarrier(carrierIdentifier);
        if (this.isSafeVerificationStubEnabled()) {
            return this.cancelWithSafeVerificationStub(shipment, normalizedCarrier, cancellationReference);
        }
        const adapter = this.adapters[normalizedCarrier];
        if (!adapter || typeof adapter.cancel !== 'function') {
            return {
                status: 'NOT_SUPPORTED',
                carrier: normalizedCarrier,
                message: `Carrier ${normalizedCarrier} does not support automated cancellation.`
            };
        }
        return adapter.cancel(shipment, cancellationReference);
    }

    async findCancellationByReference(carrierIdentifier, cancellationReference) {
        const normalizedCarrier = this.normalizeCarrier(carrierIdentifier);
        if (this.isSafeVerificationStubEnabled()) {
            return this.findCancellationWithSafeVerificationStub(normalizedCarrier, cancellationReference);
        }
        const adapter = this.adapters[normalizedCarrier];
        if (!adapter || typeof adapter.findCancellationByReference !== 'function') {
            return {
                found: false,
                carrier: normalizedCarrier,
                unsupported: true
            };
        }
        return adapter.findCancellationByReference(cancellationReference);
    }

    isSafeVerificationStubEnabled() {
        if (process.env.OPENAPI_SAFE_CARRIER_STUB !== 'true') {
            return false;
        }
        if (process.env.NODE_ENV === 'production') {
            throw new Error('OPENAPI_SAFE_CARRIER_STUB cannot be enabled in production.');
        }
        return true;
    }

    getSafeVerificationStatePath(partnerRequestId) {
        const stateDir = process.env.OPENAPI_SAFE_CARRIER_STUB_STATE_DIR
            || path.join(process.cwd(), '.tmp-openapi-safe-carrier');
        fs.mkdirSync(stateDir, { recursive: true });
        return path.join(stateDir, `${safeReferencePart(partnerRequestId)}.json`);
    }

    readSafeVerificationState(partnerRequestId) {
        const statePath = this.getSafeVerificationStatePath(partnerRequestId);
        try {
            return JSON.parse(fs.readFileSync(statePath, 'utf8'));
        } catch (error) {
            return { attempts: 0 };
        }
    }

    writeSafeVerificationState(partnerRequestId, state) {
        const statePath = this.getSafeVerificationStatePath(partnerRequestId);
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    getSafeVerificationScenario(partnerRequestId) {
        const text = String(partnerRequestId || '').toLowerCase();
        if (text.includes('deadletter')) return 'deadletter';
        if (text.includes('retry')) return 'retry-once';
        if (text.includes('unknown')) return 'unknown-once';
        return process.env.OPENAPI_SAFE_CARRIER_STUB_SCENARIO || 'success';
    }

    async bookWithSafeVerificationStub(shipment, carrierIdentifier) {
        const partnerRequestId = shipment.partnerRequestId || shipment.shipmentId || shipment._id;
        const scenario = this.getSafeVerificationScenario(partnerRequestId);
        const state = this.readSafeVerificationState(partnerRequestId);
        state.attempts = Number(state.attempts || 0) + 1;
        state.carrierIdentifier = carrierIdentifier;
        state.partnerRequestId = partnerRequestId;
        state.updatedAt = new Date().toISOString();
        this.writeSafeVerificationState(partnerRequestId, state);

        if (scenario === 'deadletter') {
            return {
                success: false,
                error: 'Safe verification carrier retryable failure.',
                status: 503,
                carrier: carrierIdentifier,
                isRetryable: true
            };
        }

        if (scenario === 'retry-once' && state.attempts === 1) {
            return {
                success: false,
                error: 'Safe verification carrier retry-once failure.',
                status: 503,
                carrier: carrierIdentifier,
                isRetryable: true
            };
        }

        if (scenario === 'unknown-once' && state.attempts === 1) {
            return {
                success: false,
                statusUnknown: true,
                error: 'Safe verification carrier response lost after create.',
                carrier: carrierIdentifier
            };
        }

        return {
            success: true,
            awb: `AWB-${safeReferencePart(partnerRequestId)}`,
            carrierRef: `CREF-${safeReferencePart(partnerRequestId)}`,
            label: Buffer.from('%PDF-1.4 safe carrier verification label').toString('base64'),
            carrier: carrierIdentifier,
            message: 'Safe verification carrier booking completed.'
        };
    }

    async findByMerchantReferenceWithSafeVerificationStub(carrierIdentifier, merchantReference) {
        const partnerRequestId = String(merchantReference || '').split('-').filter(Boolean).pop() || merchantReference;
        return {
            found: true,
            awb: `AWB-${safeReferencePart(partnerRequestId)}`,
            carrierRef: `CREF-${safeReferencePart(partnerRequestId)}`,
            label: Buffer.from('%PDF-1.4 safe carrier reconciled label').toString('base64'),
            carrier: carrierIdentifier,
            carrierName: carrierIdentifier
        };
    }

    async cancelWithSafeVerificationStub(shipment, carrierIdentifier, cancellationReference) {
        const text = `${shipment.partnerRequestId || ''} ${shipment.partnerApiBookingId || ''} ${cancellationReference || ''}`.toLowerCase();
        if (text.includes('cancel-reject')) {
            return {
                status: 'REJECTED',
                carrier: carrierIdentifier,
                message: 'Safe verification carrier rejected cancellation.'
            };
        }
        if (text.includes('cancel-retry')) {
            return {
                status: 'RETRYABLE_FAILURE',
                carrier: carrierIdentifier,
                message: 'Safe verification retryable cancellation failure.',
                isRetryable: true
            };
        }
        if (text.includes('cancel-unknown')) {
            return {
                status: 'STATUS_UNKNOWN',
                carrier: carrierIdentifier,
                message: 'Safe verification cancellation status unknown.'
            };
        }
        return {
            status: 'CANCELLED',
            carrier: carrierIdentifier,
            carrierCancellationReference: cancellationReference,
            message: 'Safe verification carrier cancellation completed.'
        };
    }

    async findCancellationWithSafeVerificationStub(carrierIdentifier, cancellationReference) {
        const text = String(cancellationReference || '').toLowerCase();
        if (text.includes('unresolved')) {
            return {
                found: false,
                carrier: carrierIdentifier,
                status: 'STATUS_UNKNOWN',
                message: 'Safe verification cancellation remains unresolved.'
            };
        }
        return {
            found: true,
            carrier: carrierIdentifier,
            status: 'CANCELLED',
            carrierCancellationReference: cancellationReference
        };
    }

    /**
     * Get list of carriers that support API booking
     * @returns {Array<string>}
     */
    getSupportedCarriers() {
        return Object.keys(this.adapters);
    }
}

// Export singleton instance
module.exports = new CarrierBookingService();
