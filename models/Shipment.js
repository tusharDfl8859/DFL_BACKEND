const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    PARTNER_API_CANCELLATION_STATUS_VALUES,
    PARTNER_API_PROCESSING_STATUS_VALUES,
    PARTNER_API_REFUND_STATUS_VALUES,
    SHIPMENT_BOOKING_SOURCES,
    SHIPMENT_BOOKING_SOURCE_VALUES
} = require('../constants/developerPortal');

const shipmentSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            ref: 'User',
            index: true
        },
        partnerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Partner',
            default: null,
            index: true
        },
        customerType: {
            type: String,
            enum: ['Regular', 'Walk-In'],
            default: 'Regular'
        },
        bookedByType: {
            type: String,
            enum: ['User', 'Partner', 'Admin', 'System'],
            default: 'User'
        },
        bookedById: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: 'bookedByType',
            default: null
        },
        billingOwnerType: {
            type: String,
            enum: ['User', 'Partner', 'Admin', 'System'],
            default: 'User'
        },
        billingOwnerId: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: 'billingOwnerType',
            default: null
        },
        bookingSource: {
            type: String,
            enum: SHIPMENT_BOOKING_SOURCE_VALUES,
            default: SHIPMENT_BOOKING_SOURCES.CUSTOMER_DASHBOARD,
            index: true
        },
        environment: {
            type: String,
            enum: [...DEVELOPER_ENVIRONMENT_VALUES, null],
            default: null,
            index: true
        },
        processingStatus: {
            type: String,
            enum: [...PARTNER_API_PROCESSING_STATUS_VALUES, null],
            default: null,
            index: true
        },
        developerAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'DeveloperAccount',
            default: null,
            index: true
        },
        credentialId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ApiCredential',
            default: null,
            index: true
        },
        credentialPublicId: {
            type: String,
            trim: true,
            maxlength: 40,
            default: null
        },
        credentialPrefix: {
            type: String,
            trim: true,
            maxlength: 40,
            default: null
        },
        partnerRequestId: {
            type: String,
            trim: true,
            maxlength: 120,
            default: null,
            index: true
        },
        partnerApiBookingId: {
            type: String,
            trim: true,
            maxlength: 40,
            default: null,
            index: true
        },
        idempotencyRecordId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PartnerApiIdempotency',
            default: null,
            index: true
        },
        walletReservationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletReservation',
            default: null,
            index: true
        },
        outboxEventId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PartnerApiOutboxEvent',
            default: null,
            index: true
        },
        partnerApiRequestId: {
            type: String,
            trim: true,
            maxlength: 120,
            default: null
        },
        carrierMerchantReference: {
            type: String,
            trim: true,
            maxlength: 160,
            default: null
        },
        carrierAttemptCount: {
            type: Number,
            default: 0,
            min: 0
        },
        shopifyOrderId: {
            type: String,
            default: null,
            index: true
        },
        ebayOrderId: {
            type: String,
            default: null,
            index: true
        },
        etsyOrderId: {
            type: String,
            default: null,
            index: true
        },
        carrierLastAttemptAt: {
            type: Date,
            default: null
        },
        carrierLastErrorCode: {
            type: String,
            trim: true,
            maxlength: 80,
            default: null
        },
        carrierRawResponseSummary: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },
        labelStatus: {
            type: String,
            enum: ['LABEL_PENDING', 'LABEL_READY', 'LABEL_FAILED', null],
            default: null,
            index: true
        },
        labelGeneratedAt: {
            type: Date,
            default: null
        },
        walletSettlementStatus: {
            type: String,
            enum: ['NOT_REQUIRED', 'PENDING', 'SETTLED', 'RELEASED', 'RECONCILIATION_REQUIRED', 'ADDITIONAL_FUNDS_REQUIRED', null],
            default: null,
            index: true
        },
        walletSettlementReference: {
            type: String,
            trim: true,
            maxlength: 260,
            default: null,
            index: true
        },
        walletSettlementTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Transaction',
            default: null,
            index: true
        },
        cancellationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PartnerApiCancellation',
            default: null,
            index: true
        },
        cancellationStatus: {
            type: String,
            enum: [...PARTNER_API_CANCELLATION_STATUS_VALUES, null],
            default: null,
            index: true
        },
        refundStatus: {
            type: String,
            enum: [...PARTNER_API_REFUND_STATUS_VALUES, null],
            default: null,
            index: true
        },
        cancellationRequestedAt: {
            type: Date,
            default: null
        },
        cancellationCompletedAt: {
            type: Date,
            default: null
        },
        cancellationReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null
        },
        cancellationOutboxEventId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PartnerApiOutboxEvent',
            default: null,
            index: true
        },
        carrierCancellationStatus: {
            type: String,
            enum: ['NOT_REQUIRED', 'REQUESTED', 'CANCELLED', 'REJECTED', 'RETRYABLE_FAILURE', 'STATUS_UNKNOWN', 'FAILED_FINAL', 'NOT_SUPPORTED', null],
            default: null,
            index: true
        },
        carrierCancellationReference: {
            type: String,
            trim: true,
            maxlength: 180,
            default: null
        },
        carrierCancellationSummary: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },
        walletReleaseReference: {
            type: String,
            trim: true,
            maxlength: 260,
            default: null,
            index: true
        },
        walletRefundReference: {
            type: String,
            trim: true,
            maxlength: 260,
            default: null,
            index: true
        },
        walletRefundTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Transaction',
            default: null,
            index: true
        },
        refundedAt: {
            type: Date,
            default: null
        },
        pricingSnapshot: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },
        manifestId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Manifest',
            default: null,
            index: true
        },
        bulkUploadId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BulkUpload',
            default: null,
            index: true
        },
        bulkOrderId: {
            type: String,
            default: null,
            index: true
        },
        manifestPickupCost: {
            type: Number,
            default: 0
        },
        manifestDate: {
            type: Date,
            default: null
        },
        pickupDetails: {
            rider: { type: String, default: '' },
            window: { type: String, default: '' },
            actualTime: { type: String, default: '' },
            status: { type: String, enum: ['Pending', 'Picked Up', 'Failed', 'Delayed'], default: 'Pending' },
            delayReason: { type: String, default: '' },
            pickedAt: { type: Date, default: null },
            pickedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
        },
        shipmentId: {
            type: String,
            unique: true,
        },
        trackingId: {
            type: String,
            default: '',
        },
        trackingCarrier: {
            type: String,
            default: 'Speedbox'
        },
        shipperDetails: {
            shipperName: { type: String, required: true },
            companyName: String,
            mobileNo: { type: String, required: true },
            email: String,
            location: String,
            addressLine1: { type: String, required: true },
            addressLine2: String,
            city: { type: String, required: true },
            state: String,
            country: { type: String, required: true },
            countryCode: String,
            pincode: { type: String, required: true },
            alternateName: String,
            alternateMobile: String,
            shipperType: String,
            shipperIdType: String,
            shipperIdNo: String,
            date: Date,
            pickupType: String,
        },
        consigneeDetails: {
            consigneeName: { type: String, required: true },
            companyName: String,
            mobileNo: { type: String, required: true },
            email: String,
            location: String,
            addressLine1: { type: String, required: true },
            addressLine2: String,
            city: { type: String, required: true },
            state: String,
            country: { type: String, required: true },
            countryCode: String,
            pincode: { type: String, required: true },
            alternateName: String,
            alternateMobile: String,

        },
        shipmentDetails: {
            shipmentType: String,
            shipmentCategory: String,
            shipmentMode: String,
            preferredUnit: String,
            noOfBoxes: String,
            currency: String,
            referenceNumber: String,
            invoiceNumber: { type: String, required: true },
            invoiceDate: Date,
            consigneeCountry: String,
            ctshCode: String, // CTSH Code for CSB-V
            uom: String,
            totalItemValue: String,
            totalTaxableValue: String,
            totalIgstPaid: String,
            totalCessPaid: String,
            bondOrUt: String,
            gstinType: String,
            gstinId: String,
            stateCode: String,
            govNonGovType: String,
            accountNo: String,
            iecNumber: String,
            adCode: String,
            bankName: String,
            ifscCode: String,
            nfetFlag: String,
            csbVItems: [{
                productName: String,
                hsnCode: String,
                quantity: String,
                unitPrice: String,
                igst: String,
            }],
            purposeOfShipment: String,
            iorEoriNo: String,
            insureShipment: Boolean,
            addPackaging: Boolean,
            boxes: [{
                length: String,
                width: String,
                height: String,
                weight: String,
                hsnCode: String, // Added hsnCode at Box level
                items: [{
                    productName: String,
                    hsnCode: String,
                    quantity: String,
                    unitPrice: String,
                    igst: String, // Added IGST field
                }]
            }],
            gstPaymentType: { type: String, enum: ['lut', 'igst'], default: 'lut' }, // Added GST Payment Type
        },
        serviceDetails: {
            serviceName: String,
            serviceCode: String,
            provider: String,
            code: String,
            zone: String,
            configId: String,
            configVersion: String,
            carrierName: String,
            carrierCode: Number, // NEW: Explicit ID mapping to carrier
            price: String, // Total Customer Price
            dflCost: Number, // Cost deducted from partner's wallet
            eta: String,
            chargeableWeight: String,
            igstTaxPercentage: String, // NEW: For IGST shipments
            cost: Number, // Base Rate from Carrier
            markup: Number, // Markup Amount
            handling: Number, // Handling Charge (Oversized)
            countrySurcharge: Number, // Country-wise Surcharge
            fuelSurcharge: Number, // Fuel Surcharge
            extraMargin: { type: Number, default: 0 }
        },
        trackingHistory: [{
            status: String,
            location: String,
            timestamp: { type: Date, default: Date.now },
            description: String
        }],
        invoice: {
            invoiceId: { type: String, default: null },
            invoiceDate: { type: Date, default: null },
            currency: { type: String, default: 'INR' },
            paymentTerms: String,
            billedTo: {
                name: String,
                companyName: String,
                address: String,
                city: String,
                state: String,
                country: String,
                pincode: String,
                phone: String,
                email: String,
                gstin: String
            },
            lineItems: [{
                description: String,
                amount: Number
            }],
            tax: {
                type: { type: String, default: 'IGST' },
                rate: { type: Number, default: 18 },
                amount: { type: Number, default: 0 }
            },
            subtotal: { type: Number, default: 0 },
            totalAmount: { type: Number, default: 0 },
            status: { type: String, enum: ['Draft', 'Generated'], default: 'Draft' }, // Draft or Generated
            pdfUrl: { type: String, default: null }, // URL to stored PDF
            zoho_invoice_id: { type: String, default: null },
            zoho_sync_status: { type: String, default: null }
        },
        status: {
            type: String,
            required: true,
            default: 'Pending',
            enum: ['Pending', 'Processing', 'Shipment Received at Our Hub', 'Received at Destination Hub', 'Shipment Dispatched', 'In Transit', 'Out for Delivery', 'Delivered', 'Cancelled', 'On Hold', 'Dispute Raised', 'Dispute Resolved', 'Action Required', 'RTO'],
            index: true
        },
        paymentMode: {
            type: String,
            default: 'Wallet',
            enum: ['Wallet', 'COD', 'Prepaid']
        },
        actualScannedWeight: {
            type: Number,
            default: null
        },
        holdReason: {
            type: String,
            default: null
        },
        firstMileSticker: {
            type: String,
            default: null
        },
        lastMileSticker: {
            type: String,
            default: null
        },
        shippingBill: {
            url: { type: String, default: null },
            publicId: { type: String, default: null },
            uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
            uploadedByName: { type: String, default: null },
            uploadedAt: { type: Date, default: null },
            fileName: { type: String, default: null },
            fileSize: { type: Number, default: 0 },
            status: { type: String, enum: ['Pending', 'Available'], default: 'Pending', index: true }
        },
        // ===== CARRIER BOOKING FIELDS =====
        carrierLabel: {
            type: String,  // Base64 encoded PDF label from carrier
            default: null
        },
        carrierLabelUrl: {
            type: String,  // Cloudinary URL for the carrier label
            default: null
        },
        carrierBookingId: {
            type: String,  // External AWB/reference ID from carrier
            default: null
        },
        carrierBookedAt: {
            type: Date,
            default: null
        },
        carrierBookingStatus: {
            type: String,
            enum: ['PENDING', 'BOOKED', 'FAILED', 'MANUAL', 'REQUESTED', 'STATUS_UNKNOWN', 'DEAD_LETTER', 'CLAIMED', 'SKIPPED_CANCELLED'],
            default: 'PENDING',
            index: true
        },
        carrierBookingError: {
            type: String,  // Error message if booking failed
            default: null
        },
        manualBookedBy: {
            type: String,  // Admin name who clicked 'Mark as Manual Booking'
            default: null
        },
        lastMileAWB: {
            type: String,
            default: ''
        },
        lastMileTrackingNumber: {
            type: String,
            default: ''
        },
        stickerDeletionLog: {
            type: Map,
            of: new mongoose.Schema({
                deletedBy: String,
                deletedAt: { type: Date, default: Date.now }
            }, { _id: false }),
            default: {}
        },
        carrierExecutionClaimId: {
            type: String,
            default: null
        },
        carrierExecutionClaimedAt: {
            type: Date,
            default: null
        },
        carrierExecutionLeaseExpiresAt: {
            type: Date,
            default: null,
            index: true
        },
        carrierRequestStartedAt: {
            type: Date,
            default: null
        },
        carrierExecutionWorkerId: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true,
    }
);

// Indexes
shipmentSchema.index({ createdAt: -1 });
shipmentSchema.index({ 'shipperDetails.city': 1 });
shipmentSchema.index({ 'consigneeDetails.city': 1 });
shipmentSchema.index({ 'consigneeDetails.country': 1 }); // Optimizes Top Destinations aggregation

// COMPOUND INDEXES FOR DASHBOARD OPTIMIZATION
shipmentSchema.index({ user: 1, createdAt: -1 }); // Optimizes default user sorted view
shipmentSchema.index({ user: 1, status: 1 });     // Optimizes status aggregation & filtering
shipmentSchema.index({ user: 1, status: 1, createdAt: -1 }); // Optimizes filtered user shipment listing with date sort
shipmentSchema.index({ status: 1, createdAt: -1 }); // Optimizes dashboard $facet (status group + date filter)
shipmentSchema.index({ createdAt: -1, status: 1 }); // Optimizes date-first queries with status
shipmentSchema.index({ partnerId: 1, createdAt: -1 });
shipmentSchema.index({ developerAccountId: 1, environment: 1, partnerApiBookingId: 1 });
shipmentSchema.index({ carrierBookingStatus: 1, carrierExecutionLeaseExpiresAt: 1 });
shipmentSchema.index({ developerAccountId: 1, environment: 1, partnerRequestId: 1 });
shipmentSchema.index(
    { developerAccountId: 1, environment: 1, partnerRequestId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API,
            environment: 'LIVE',
            partnerRequestId: { $type: 'string' }
        },
        name: 'unique_live_partner_request_shipment'
    }
);

// Automatically sync main status change into trackingHistory timeline if not present
shipmentSchema.pre('save', function () {
    if (this.isModified('status') && this.status) {
        const topEvent = this.trackingHistory && this.trackingHistory[0];
        if (!topEvent || topEvent.status !== this.status) {
            this.trackingHistory.unshift({
                status: this.status,
                location: this.shipperDetails?.city || 'Hub',
                timestamp: new Date(),
                description: `Shipment status updated to ${this.status}`
            });
        }
    }
});

// Automatically close inactive customer alerts when a new shipment is booked
shipmentSchema.post('save', async function (doc) {
    try {
        const InactiveCustomerAlert = mongoose.model('InactiveCustomerAlert');
        if (InactiveCustomerAlert) {
            await InactiveCustomerAlert.findOneAndUpdate(
                { user: doc.user, status: 'active' },
                { $set: { status: 'closed', lastBookingDate: doc.createdAt } }
            );
        }
    } catch (err) {
        // Silently handle post-save background alert updates
    }
});

const Shipment = mongoose.model('Shipment', shipmentSchema);

module.exports = Shipment;
