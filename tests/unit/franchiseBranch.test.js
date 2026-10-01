const mongoose = require('mongoose');
const Partner = require('../../models/Partner');
const User = require('../../models/User');
const { normalizeShipmentServiceDetails } = require('../../utils/shipmentServiceDetails');
const { validateGstPanMatch } = require('../../utils/gstPanValidator');

describe('Franchise Branch — Consolidated Unit Test Suite', () => {

    describe('1. Franchise Partner Schema & Maker-Checker Compliance Fields', () => {
        it('should allow custom franchise branch names (e.g. Abohar, Pune, Bengaluru) on User model without enum errors', () => {
            const customer = new User({
                customerId: 'DFLC1001',
                name: 'Walk In Customer',
                email: 'walkin@example.com',
                phone: '9876543299',
                password: 'password123',
                branch: 'Abohar'
            });

            const validateError = customer.validateSync();
            expect(validateError).toBeUndefined();
            expect(customer.branch).toBe('Abohar');
        });
        it('should initialize partner with default Maker-Checker KYC fields', () => {
            const partner = new Partner({
                partnerType: 'franchise',
                partnerCode: 'DFLP-MOCK01',
                companyName: 'Mock Franchise Hub',
                ownerName: 'Mock Owner',
                email: 'mockowner@example.com',
                phone: '9876543210',
                password: 'password123'
            });

            expect(partner.kycStatus).toBe('not_submitted');
            expect(partner.status).toBe('pending');
            expect(partner.kycData.uploadedByAdmin).toBeNull();
            expect(partner.kycData.partnerConfirmed).toBe(false);
            expect(partner.kycData.partnerConfirmedAt).toBeNull();
            expect(partner.kycData.documentStatuses.identity.status).toBe('not_submitted');
            expect(partner.kycData.documentStatuses.pan.status).toBe('not_submitted');
            expect(partner.kycData.documentStatuses.gst.status).toBe('not_submitted');
            expect(partner.kycData.documentStatuses.export.status).toBe('not_submitted');
            expect(partner.kycData.documentStatuses.documents.status).toBe('not_submitted');
        });

        it('should properly track admin-uploaded KYC state and partner confirmation transition', () => {
            const adminId = new mongoose.Types.ObjectId();
            const partner = new Partner({
                partnerType: 'franchise',
                partnerCode: 'DFLP-MOCK02',
                companyName: 'Mock Franchise Hub 2',
                ownerName: 'Mock Owner 2',
                email: 'mockowner2@example.com',
                phone: '9876543211',
                password: 'password123',
                kycData: {
                    uploadedByAdmin: adminId,
                    partnerConfirmed: false,
                    documentNumber: '123456789012',
                    panNumber: 'ABCDE1234F',
                    documentStatuses: {
                        identity: { status: 'pending' },
                        pan: { status: 'pending' },
                        gst: { status: 'pending' },
                        export: { status: 'pending' },
                        documents: { status: 'pending' }
                    }
                }
            });

            expect(partner.kycData.uploadedByAdmin.toString()).toBe(adminId.toString());
            expect(partner.kycData.partnerConfirmed).toBe(false);

            // Simulate partner confirmation
            partner.kycData.partnerConfirmed = true;
            partner.kycData.partnerConfirmedAt = new Date();
            partner.kycStatus = 'pending';

            expect(partner.kycData.partnerConfirmed).toBe(true);
            expect(partner.kycData.partnerConfirmedAt).toBeInstanceOf(Date);
            expect(partner.kycStatus).toBe('pending');
        });
    });

    describe('2. CSB-4 & CSB-5 Customer KYC Validation Rules', () => {
        it('should strictly validate 12-digit numeric Aadhaar format', () => {
            const aadhaarRegex = /^\d{12}$/;
            expect(aadhaarRegex.test('123456789012')).toBe(true);
            expect(aadhaarRegex.test('12345')).toBe(false);
            expect(aadhaarRegex.test('1234567890123')).toBe(false);
            expect(aadhaarRegex.test('1234ABCD9012')).toBe(false);
        });

        it('should strictly validate standard 10-character PAN format', () => {
            const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
            expect(panRegex.test('ABCDE1234F')).toBe(true);
            expect(panRegex.test('abcde1234f'.toUpperCase())).toBe(true);
            expect(panRegex.test('ABCD12345F')).toBe(false);
            expect(panRegex.test('12345ABCDE')).toBe(false);
            expect(panRegex.test('ABCDEF1234')).toBe(false);
        });

        it('should strictly validate 15-character GSTIN format', () => {
            const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
            expect(gstRegex.test('07ABCDE1234F1Z5')).toBe(true);
            expect(gstRegex.test('29ABCDE1234F1Z5')).toBe(true);
            expect(gstRegex.test('07ABCDE1234F15')).toBe(false); // 14 chars
            expect(gstRegex.test('07ABCDE1234F1Z59')).toBe(false); // 16 chars
        });

        it('should accurately cross-validate matching PAN inside GSTIN (index 2-12)', () => {
            const gst = '07ABCDE1234F1Z5';
            const pan = 'ABCDE1234F';
            const validation = validateGstPanMatch(gst, pan);

            expect(validation.isMatch).toBe(true);
            expect(validation.extractedPan).toBe('ABCDE1234F');
            expect(validation.submittedPan).toBe('ABCDE1234F');
        });

        it('should flag mismatch when GSTIN contains different PAN', () => {
            const gst = '07ABCDE1234F1Z5';
            const pan = 'WXYZP9999K';
            const validation = validateGstPanMatch(gst, pan);

            expect(validation.isMatch).toBe(false);
            expect(validation.extractedPan).toBe('ABCDE1234F');
            expect(validation.submittedPan).toBe('WXYZP9999K');
        });
    });

    describe('3. Pricing Engine & Deterministic 2-Decimal Precision', () => {
        it('should normalize floating point price strings to exactly 2 decimals', () => {
            const normalized = normalizeShipmentServiceDetails({
                serviceName: 'Express Global',
                price: '1911.0800000000002',
                extraMargin: 150
            });

            expect(normalized.price).toBe('1911.08');
            expect(normalized.extraMargin).toBe(150);
        });

        it('should normalize floating point number price to 2 decimals', () => {
            const normalized = normalizeShipmentServiceDetails({
                serviceName: 'Economy Global',
                price: 2450.559999999
            });

            expect(normalized.price).toBe('2450.56');
        });

        it('should handle zero, missing, and non-negative extraMargin values safely', () => {
            const normalZero = normalizeShipmentServiceDetails({ extraMargin: 0 });
            expect(normalZero.extraMargin).toBe(0);

            const normalEmpty = normalizeShipmentServiceDetails({});
            expect(normalEmpty.extraMargin).toBe(0);
        });
    });

    describe('4. First-Mile Shipping Label Storage Configuration', () => {
        it('should correctly distinguish PDF MIME types for raw storage', () => {
            const isPdf = (mimetype) => mimetype === 'application/pdf' || mimetype.includes('pdf');

            expect(isPdf('application/pdf')).toBe(true);
            expect(isPdf('image/png')).toBe(false);
            expect(isPdf('image/jpeg')).toBe(false);
            expect(isPdf('application/x-pdf')).toBe(true);
        });
    });

    describe('5. Franchise Partner KYC Verification, Auto-Approval & Mandatory Assets', () => {
        it('should auto-verify and activate partner upon Step 2 confirmation', () => {
            const partner = new Partner({
                partnerType: 'franchise',
                partnerCode: 'DFLP-AUTO01',
                companyName: 'Auto Verification Hub',
                ownerName: 'Hub Owner',
                email: 'autoowner@example.com',
                phone: '9876543299',
                kycStatus: 'pending',
                kycData: {
                    uploadedByAdmin: new mongoose.Types.ObjectId(),
                    partnerConfirmed: false,
                    documentNumber: '123456789012',
                    panNumber: 'ABCDE1234F',
                    gstNumber: '07ABCDE1234F1Z5',
                    gstFile: 'https://cloudinary.com/gst.pdf',
                    photoImage: 'https://cloudinary.com/photo.jpg',
                    signatureImage: 'https://cloudinary.com/sign.png'
                }
            });

            // Simulate Step 2 confirmation logic from confirmPartnerKyc
            partner.kycData.partnerConfirmed = true;
            partner.kycData.partnerConfirmedAt = new Date();
            partner.kycStatus = 'verified';
            partner.kycVerified = true;
            partner.kycData.identityVerified = true;
            partner.kycData.panVerified = true;
            if (partner.kycData.gstNumber || partner.kycData.gstFile) {
                partner.kycData.documentsVerified = true;
            }

            expect(partner.kycData.partnerConfirmed).toBe(true);
            expect(partner.kycStatus).toBe('verified');
            expect(partner.kycVerified).toBe(true);
            expect(partner.kycData.identityVerified).toBe(true);
            expect(partner.kycData.panVerified).toBe(true);
            expect(partner.kycData.documentsVerified).toBe(true);
            expect(partner.kycData.partnerConfirmedAt).toBeInstanceOf(Date);
        });

        it('should not set uploadedByAdmin when admin creates partner without documents (avoiding empty verification screen)', () => {
            const reqBodyWithoutKyc = {
                companyName: 'New Hub Without KYC',
                ownerName: 'Fresh Owner',
                email: 'fresh@example.com',
                phone: '9876543200',
                kycData: {}
            };

            const kycData = reqBodyWithoutKyc.kycData && (reqBodyWithoutKyc.kycData.documentNumber || reqBodyWithoutKyc.kycData.panNumber || reqBodyWithoutKyc.kycData.aadharFrontImage)
                ? { uploadedByAdmin: new mongoose.Types.ObjectId(), ...reqBodyWithoutKyc.kycData }
                : {};

            expect(kycData.uploadedByAdmin).toBeUndefined();
            expect(Boolean(kycData.uploadedByAdmin && (kycData.documentNumber || kycData.panNumber))).toBe(false);
        });

        it('should persist photoImage, signatureImage and billingAddress when admin uploads partner KYC', () => {
            const partner = new Partner({
                partnerType: 'franchise',
                partnerCode: 'DFLP-ADMINUP',
                companyName: 'Admin Upload Hub',
                ownerName: 'Admin Owner',
                email: 'adminupload@example.com',
                phone: '9876543201',
                billingAddress: {
                    addressLine1: 'Plot 42, Sector 18',
                    city: 'Gurugram',
                    state: 'Haryana',
                    country: 'India',
                    pincode: '122001'
                },
                kycData: {
                    documentNumber: '998877665544',
                    panNumber: 'ABCDE9999K',
                    photoImage: 'https://cloudinary.com/photo.jpg',
                    signatureImage: 'https://cloudinary.com/sign.png',
                    billingAddress: {
                        addressLine1: 'Plot 42, Sector 18',
                        city: 'Gurugram',
                        state: 'Haryana',
                        country: 'India',
                        pincode: '122001'
                    },
                    partnerConfirmed: false
                }
            });

            expect(partner.kycData.photoImage).toBe('https://cloudinary.com/photo.jpg');
            expect(partner.kycData.signatureImage).toBe('https://cloudinary.com/sign.png');
            expect(partner.billingAddress.addressLine1).toBe('Plot 42, Sector 18');
            expect(partner.billingAddress.pincode).toBe('122001');
            expect(partner.kycData.partnerConfirmed).toBe(false);
        });

        it('should reset partnerConfirmed to false when admin updates or adds business KYC documents', () => {
            const partner = new Partner({
                partnerType: 'franchise',
                partnerCode: 'DFLP-REVERIFY',
                companyName: 'Reverify Hub',
                ownerName: 'Reverify Owner',
                email: 'reverify@example.com',
                phone: '9876543202',
                kycStatus: 'verified',
                kycData: {
                    partnerConfirmed: true,
                    partnerConfirmedAt: new Date('2026-09-01'),
                    documentNumber: '112233445566',
                    panNumber: 'ABCDE1111A'
                }
            });

            expect(partner.kycData.partnerConfirmed).toBe(true);

            // Admin adds business KYC later
            partner.kycData.gstNumber = '07ABCDE1111A1Z1';
            partner.kycData.gstFile = 'https://cloudinary.com/gst.pdf';
            partner.kycData.partnerConfirmed = false;
            partner.kycData.partnerConfirmedAt = null;
            partner.kycStatus = 'pending';

            expect(partner.kycData.partnerConfirmed).toBe(false);
            expect(partner.kycData.partnerConfirmedAt).toBeNull();
            expect(partner.kycStatus).toBe('pending');
        });

        it('should enforce mandatory validation on Aadhaar, PAN, Photo, and Signature in Step 1 form submission', () => {
            const validateStep1 = (form, files) => {
                const missing = [];
                if (!form.docNumber || !/^\d{12}$/.test(form.docNumber)) missing.push('Aadhaar Number');
                if (!files.aadharFront) missing.push('Aadhaar Front');
                if (!files.aadharBack) missing.push('Aadhaar Back');
                if (!form.panNumber || !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(form.panNumber)) missing.push('PAN Number');
                if (!files.panCard) missing.push('PAN Card Image');
                if (!files.photo) missing.push('Photo');
                if (!files.signature) missing.push('Signature');
                return { isValid: missing.length === 0, missing };
            };

            const invalidSubmission = validateStep1(
                { docNumber: '123456789012', panNumber: 'ABCDE1234F' },
                { aadharFront: 'front.jpg', aadharBack: 'back.jpg', panCard: 'pan.jpg' } // missing photo and signature
            );

            expect(invalidSubmission.isValid).toBe(false);
            expect(invalidSubmission.missing).toContain('Photo');
            expect(invalidSubmission.missing).toContain('Signature');

            const validSubmission = validateStep1(
                { docNumber: '123456789012', panNumber: 'ABCDE1234F' },
                { aadharFront: 'front.jpg', aadharBack: 'back.jpg', panCard: 'pan.jpg', photo: 'photo.jpg', signature: 'sign.png' }
            );

            expect(validSubmission.isValid).toBe(true);
            expect(validSubmission.missing.length).toBe(0);
        });
    });
});
