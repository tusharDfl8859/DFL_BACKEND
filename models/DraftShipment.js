const mongoose = require('mongoose');

const draftShipmentSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true,
            required: function () {
                return !this.partner;
            }
        },
        partner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Partner',
            default: null,
            index: true
        },
        customerType: {
            type: String,
            default: null
        },
        partnerMargin: {
            type: Number,
            default: 0
        },
        shipperDetails: {
            shipperName: String,
            companyName: String,
            mobileNo: String,
            email: String,
            location: String,
            addressLine1: String,
            addressLine2: String,
            city: String,
            state: String,
            country: String,
            pincode: String,
            alternateName: String,
            alternateMobile: String,
            shipperType: String,
            shipperIdType: String,
            shipperIdNo: String,
            date: Date,
            pickupType: String,
            countryCode: String
        },
        consigneeDetails: {
            consigneeName: String,
            companyName: String,
            mobileNo: String,
            email: String,
            location: String,
            addressLine1: String,
            addressLine2: String,
            city: String,
            state: String,
            country: String,
            pincode: String,
            alternateName: String,
            alternateMobile: String,
            consigneeType: String,
            consigneeIdType: String,
            consigneeIdNo: String,
            countryCode: String
        },
        shipmentDetails: {
            shipmentType: String,
            shipmentCategory: String,
            shipmentMode: String,
            preferredUnit: String,
            noOfBoxes: String,
            currency: String,
            referenceNumber: String,
            invoiceNumber: String,
            invoiceDate: Date,
            consigneeCountry: String,
            ctshCode: String,
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
            igstTaxPercentage: String,
            gstPaymentType: String,
            boxes: [{
                length: String,
                width: String,
                height: String,
                weight: String,
                items: [{
                    productName: String,
                    hsnCode: String,
                    quantity: String,
                    unitPrice: String,
                    igst: String,
                }]
            }],
        },
        // We might want to save the selected rate context if available, but usually draft is pre-booking
        savedRate: {
            serviceName: String,
            serviceCode: String,
            carrierCode: String,
            provider: String,
            price: Number,
            eta: String,
            image: String,
            chargeableWeight: Number,
            breakdown: Object
        },
        isConcierge: {
            type: Boolean,
            default: false
        },
        bookingSource: {
            type: String,
            default: 'PORTAL'
        },
        shipmentRefId: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true,
    }
);

const DraftShipment = mongoose.model('DraftShipment', draftShipmentSchema);

module.exports = DraftShipment;
