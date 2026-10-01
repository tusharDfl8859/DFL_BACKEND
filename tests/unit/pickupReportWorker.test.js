const cron = require('node-cron');
const Shipment = require('../../models/Shipment');
const Manifest = require('../../models/Manifest');
const ReportRecipient = require('../../models/ReportRecipient');
const PickupReportSnapshot = require('../../models/PickupReportSnapshot');
const sendEmail = require('../../utils/emailService');
const {
    uploadWhatsappMediaBuffer,
    sendTemplateMessage,
    sendWhatsappDocumentByMediaId,
    sendWhatsappTextMessage
} = require('../../services/whatsappService');
const { getWhatsappConfig } = require('../../config/whatsappConfig');

jest.mock('node-cron', () => ({
    schedule: jest.fn()
}));

jest.mock('../../models/Shipment', () => ({
    find: jest.fn()
}));

jest.mock('../../models/Manifest', () => ({
    find: jest.fn()
}));

jest.mock('../../models/ReportRecipient', () => ({
    find: jest.fn(),
    countDocuments: jest.fn(),
    insertMany: jest.fn()
}));

jest.mock('../../models/PickupReportSnapshot', () => ({
    create: jest.fn()
}));

jest.mock('../../utils/emailService', () => jest.fn());

jest.mock('../../services/whatsappService', () => ({
    uploadWhatsappMediaBuffer: jest.fn(),
    sendTemplateMessage: jest.fn(),
    sendWhatsappDocumentByMediaId: jest.fn(),
    sendWhatsappTextMessage: jest.fn()
}));

jest.mock('../../config/whatsappConfig', () => ({
    getWhatsappConfig: jest.fn()
}));

const {
    setupPickupReportCron,
    runPickupReportJob,
    autoSeedRecipientsFromEnv,
    getIndiaDateBounds,
    getShipmentRegion,
    groupShipmentsByRegion
} = require('../../workers/pickupReportWorker');

const createMockShipmentQuery = (data = []) => ({
    sort: jest.fn().mockResolvedValue(data)
});

const createMockManifestQuery = (data = []) => ({
    populate: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(data)
    })
});

const createMockRecipientQuery = (data = []) => ({
    lean: jest.fn().mockResolvedValue(data)
});

describe('PickupReportWorker Unit & Automation Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getWhatsappConfig.mockReturnValue({
            enabled: true,
            pickupReportTemplate: 'dfl_pickup_daily_report',
            pickupReportTemplateLanguage: 'hi'
        });
    });

    describe('1. India Date Bounds & Timezone Math (getIndiaDateBounds)', () => {
        test('should calculate correct IST start, end, 9:30 AM, 1:30 PM, and tomorrow bounds', () => {
            const fixedDate = new Date('2026-09-02T10:00:00.000Z');
            const bounds = getIndiaDateBounds(fixedDate);

            expect(bounds).toHaveProperty('todayStart');
            expect(bounds).toHaveProperty('todayEnd');
            expect(bounds).toHaveProperty('tomorrowStart');
            expect(bounds).toHaveProperty('tomorrowEnd');
            expect(bounds).toHaveProperty('nineThirtyAMToday');
            expect(bounds).toHaveProperty('oneThirtyPMToday');
            expect(bounds).toHaveProperty('nowUTC');

            expect(bounds.todayEnd.getTime()).toBeGreaterThan(bounds.todayStart.getTime());
            expect(bounds.tomorrowStart.getTime()).toBeGreaterThan(bounds.todayEnd.getTime());
            expect(bounds.oneThirtyPMToday.getTime()).toBeGreaterThan(bounds.nineThirtyAMToday.getTime());
        });
    });

    describe('2. Regional Classification & Grouping (getShipmentRegion & groupShipmentsByRegion)', () => {
        test('should classify Delhi NCR cities accurately', () => {
            expect(getShipmentRegion({ shipperDetails: { city: 'New Delhi' } })).toBe('DELHI_NCR');
            expect(getShipmentRegion({ shipperDetails: { city: 'Noida', state: 'UP' } })).toBe('DELHI_NCR');
            expect(getShipmentRegion({ shipperDetails: { addressLine1: 'Cyber City Gurugram' } })).toBe('DELHI_NCR');
            expect(getShipmentRegion({ shipperDetails: { location: 'Ghaziabad Industrial Area' } })).toBe('DELHI_NCR');
            expect(getShipmentRegion({ shipperDetails: { city: 'Faridabad' } })).toBe('DELHI_NCR');
        });

        test('should classify Jaipur accurately', () => {
            expect(getShipmentRegion({ shipperDetails: { city: 'Jaipur', state: 'Rajasthan' } })).toBe('JAIPUR');
            expect(getShipmentRegion({ shipperDetails: { addressLine1: 'Mansarovar, jaipur' } })).toBe('JAIPUR');
        });

        test('should classify other regions as OTHERS', () => {
            expect(getShipmentRegion({ shipperDetails: { city: 'Mumbai', state: 'Maharashtra' } })).toBe('OTHERS');
            expect(getShipmentRegion({ shipperDetails: { city: 'Bengaluru' } })).toBe('OTHERS');
            expect(getShipmentRegion({})).toBe('OTHERS');
        });

        test('should group multiple shipments by region maintaining counts', () => {
            const shipments = [
                { shipperDetails: { city: 'Delhi' } },
                { shipperDetails: { city: 'Noida' } },
                { shipperDetails: { city: 'Jaipur' } },
                { shipperDetails: { city: 'Mumbai' } }
            ];

            const grouped = groupShipmentsByRegion(shipments);
            expect(grouped.delhiNcr).toHaveLength(2);
            expect(grouped.jaipur).toHaveLength(1);
            expect(grouped.others).toHaveLength(1);
            expect(grouped.total).toBe(4);
        });
    });

    describe('3. 3-Slot Daily Schedules Setup (setupPickupReportCron)', () => {
        test('should schedule exactly 3 cron jobs in Asia/Kolkata timezone (9:30 AM, 1:30 PM, 7:30 PM)', () => {
            ReportRecipient.countDocuments.mockResolvedValue(1);

            setupPickupReportCron();

            expect(cron.schedule).toHaveBeenCalledTimes(3);

            // 1. 9:30 AM
            expect(cron.schedule).toHaveBeenCalledWith(
                '30 9 * * *',
                expect.any(Function),
                expect.objectContaining({ scheduled: true, timezone: 'Asia/Kolkata' })
            );

            // 2. 1:30 PM
            expect(cron.schedule).toHaveBeenCalledWith(
                '30 13 * * *',
                expect.any(Function),
                expect.objectContaining({ scheduled: true, timezone: 'Asia/Kolkata' })
            );

            // 3. 7:30 PM
            expect(cron.schedule).toHaveBeenCalledWith(
                '30 19 * * *',
                expect.any(Function),
                expect.objectContaining({ scheduled: true, timezone: 'Asia/Kolkata' })
            );
        });
    });

    describe('4. Dynamic Auto-Seeding from .env (autoSeedRecipientsFromEnv)', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        test('should seed recipients into DB when collection is empty', async () => {
            ReportRecipient.countDocuments.mockResolvedValue(0);
            ReportRecipient.insertMany.mockResolvedValue([]);

            process.env.PICKUP_REPORT_EMAILS = 'ops@example.com';
            process.env.PICKUP_REPORT_WHATSAPP_NUMBERS = '919876543210';

            await autoSeedRecipientsFromEnv();

            expect(ReportRecipient.insertMany).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ type: 'email', value: 'ops@example.com' }),
                    expect.objectContaining({ type: 'whatsapp', value: '9876543210' })
                ]),
                { ordered: false }
            );
        });

        test('should skip seeding when recipients already exist in DB', async () => {
            ReportRecipient.countDocuments.mockResolvedValue(2);

            await autoSeedRecipientsFromEnv();

            expect(ReportRecipient.insertMany).not.toHaveBeenCalled();
        });
    });

    describe('5. Report Generation & Multi-Channel Dispatch (runPickupReportJob)', () => {
        test('should skip notification dispatch cleanly when totalPendingCount is 0', async () => {
            ReportRecipient.find
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'email', value: 'admin@dfl.com', isActive: true }]))
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'whatsapp', value: '9876543210', isActive: true }]));

            Shipment.find.mockReturnValue(createMockShipmentQuery([]));
            Manifest.find.mockReturnValue(createMockManifestQuery([]));
            PickupReportSnapshot.create.mockResolvedValue({ _id: 'snap-empty-1' });

            const result = await runPickupReportJob('9:30_AM');

            expect(result.success).toBe(true);
            expect(result.totalPendingCount).toBe(0);
            expect(result.message).toMatch(/no pending shipments or manifests found/i);

            // Verify notifications were NOT dispatched
            expect(sendEmail).not.toHaveBeenCalled();
            expect(uploadWhatsappMediaBuffer).not.toHaveBeenCalled();
            expect(sendTemplateMessage).not.toHaveBeenCalled();

            // Verify snapshot was recorded
            expect(PickupReportSnapshot.create).toHaveBeenCalledWith(
                expect.objectContaining({ cronName: '9:30_AM', shipmentIds: [] })
            );
        });

        test('should generate PDF reports and dispatch Email & WhatsApp for 9:30_AM slot with data', async () => {
            const mockShipments = [
                {
                    _id: 'ship1',
                    shipmentId: 'DFL-101',
                    user: { name: 'Acme Corp', mobile: '9876543210' },
                    shipperDetails: { city: 'Noida', addressLine1: 'Sector 62' },
                    shipmentDetails: { boxes: [{ length: 20, width: 20, height: 20, weight: 5 }] }
                }
            ];

            const mockManifests = [
                {
                    _id: 'man1',
                    manifestId: 'MAN-201',
                    pickupAddress: 'Jaipur Road',
                    user: { name: 'Supplier One', phone: '9123456780' },
                    packetCount: 10,
                    date: new Date()
                }
            ];

            ReportRecipient.find
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'email', value: 'ops@dfl.com', isActive: true }]))
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'whatsapp', value: '9876543210', isActive: true }]));

            Shipment.find
                .mockReturnValueOnce(createMockShipmentQuery(mockShipments)) // urgent
                .mockReturnValueOnce(createMockShipmentQuery([])); // new

            Manifest.find
                .mockReturnValueOnce(createMockManifestQuery(mockManifests)) // urgent
                .mockReturnValueOnce(createMockManifestQuery([])); // new

            sendEmail.mockResolvedValue(true);
            uploadWhatsappMediaBuffer.mockResolvedValue({ success: true, mediaId: 'meta-media-id-777' });
            sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'wamid.123' });
            PickupReportSnapshot.create.mockResolvedValue({ _id: 'snap-930-success' });

            const result = await runPickupReportJob('9:30_AM');

            expect(result.success).toBe(true);
            expect(result.totalPendingCount).toBe(2);
            expect(result.shipmentsCount).toBe(1);
            expect(result.manifestsCount).toBe(1);

            // Verify Email dispatched with PDF attachment
            expect(sendEmail).toHaveBeenCalledWith(
                expect.objectContaining({
                    email: ['ops@dfl.com'],
                    subject: expect.stringContaining('9:30 AM Report'),
                    attachments: expect.arrayContaining([
                        expect.objectContaining({
                            contentType: 'application/pdf',
                            filename: expect.stringContaining('DFL_Pickup_Report_9:30_AM')
                        })
                    ])
                })
            );

            // Verify WhatsApp buffer uploaded to Meta Media API
            expect(uploadWhatsappMediaBuffer).toHaveBeenCalledWith(
                expect.objectContaining({
                    pdfBuffer: expect.any(Buffer),
                    filename: expect.stringContaining('DFL_Hindi_Pickup_Report_9:30_AM')
                })
            );

            // Verify approved WhatsApp template dispatched with document header and 3 parameters
            expect(sendTemplateMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    phone: '9876543210',
                    templateName: 'dfl_pickup_daily_report',
                    languageCode: 'hi',
                    headerMediaId: 'meta-media-id-777',
                    bodyParameters: expect.arrayContaining(['9:30 AM', '2'])
                })
            );

            // Verify snapshot recorded
            expect(PickupReportSnapshot.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    cronName: '9:30_AM',
                    shipmentIds: ['ship1']
                })
            );
        });

        test('should fallback to direct document and text message if WhatsApp template dispatch fails', async () => {
            const mockShipments = [
                {
                    _id: 'ship2',
                    shipmentId: 'DFL-102',
                    user: { name: 'Beta Ltd' },
                    shipperDetails: { city: 'Jaipur' }
                }
            ];

            ReportRecipient.find
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'email', value: 'ops@dfl.com', isActive: true }]))
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'whatsapp', value: '9876543210', isActive: true }]));

            Shipment.find
                .mockReturnValueOnce(createMockShipmentQuery([]))
                .mockReturnValueOnce(createMockShipmentQuery(mockShipments));

            Manifest.find
                .mockReturnValueOnce(createMockManifestQuery([]))
                .mockReturnValueOnce(createMockManifestQuery([]));

            sendEmail.mockResolvedValue(true);
            uploadWhatsappMediaBuffer.mockResolvedValue({ success: true, mediaId: 'media-888' });
            
            // 1. Template message fails
            sendTemplateMessage.mockResolvedValue({ success: false, reason: 'Template not approved on Meta' });
            // 2. Direct document succeeds
            sendWhatsappDocumentByMediaId.mockResolvedValue({ success: true, messageId: 'doc-msg-1' });
            PickupReportSnapshot.create.mockResolvedValue({ _id: 'snap-fallback-1' });

            const result = await runPickupReportJob('1:30_PM');

            expect(result.success).toBe(true);
            expect(sendTemplateMessage).toHaveBeenCalled();
            expect(sendWhatsappDocumentByMediaId).toHaveBeenCalledWith(
                expect.objectContaining({
                    phone: '9876543210',
                    mediaId: 'media-888'
                })
            );
        });

        test('should execute 7:30_PM slot covering today, tomorrow, and future bookings', async () => {
            const todayShipments = [{ _id: 's_urgent', shipperDetails: { city: 'Delhi' } }];
            const tomorrowShipments = [{ _id: 's_tomorrow', shipperDetails: { city: 'Jaipur' } }];
            const futureShipments = [{ _id: 's_future', shipperDetails: { city: 'Mumbai' } }];

            ReportRecipient.find
                .mockReturnValueOnce(createMockRecipientQuery([]))
                .mockReturnValueOnce(createMockRecipientQuery([{ type: 'whatsapp', value: '9876543210', isActive: true }]));

            Shipment.find
                .mockReturnValueOnce(createMockShipmentQuery(todayShipments))
                .mockReturnValueOnce(createMockShipmentQuery(tomorrowShipments))
                .mockReturnValueOnce(createMockShipmentQuery(futureShipments));

            Manifest.find
                .mockReturnValueOnce(createMockManifestQuery([]))
                .mockReturnValueOnce(createMockManifestQuery([]))
                .mockReturnValueOnce(createMockManifestQuery([]));

            uploadWhatsappMediaBuffer.mockResolvedValue({ success: true, mediaId: 'media-730' });
            sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'msg-730' });
            PickupReportSnapshot.create.mockResolvedValue({ _id: 'snap-730' });

            const result = await runPickupReportJob('7:30_PM');

            expect(result.success).toBe(true);
            expect(result.totalPendingCount).toBe(3);
            expect(result.shipmentsCount).toBe(3);
            expect(PickupReportSnapshot.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    cronName: '7:30_PM',
                    shipmentIds: ['s_urgent', 's_tomorrow', 's_future']
                })
            );
        });
    });
});
