const Manifest = require('../models/Manifest');
const { logActivity } = require('../utils/activityLogger');
const Shipment = require('../models/Shipment');
const Address = require('../models/Address');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const path = require('path');
const fs = require('fs');

const getAuthenticatedUserId = (req) => {
    return req.user?._id || req.user?.id || req.admin?._id || null;
};

const isAdminRequester = (req) => {
    if (req.admin) return true;
    if (req.user?.isAdmin) return true;
    const role = (req.user?.role || '').toLowerCase();
    if (['admin', 'super_admin', 'operation', 'sales_manager', 'sales_executive', 'member'].includes(role)) return true;
    if (req.user?.role === 'Admin') return true;
    return false;
};

const isSameUser = (shipmentUser, userId) => {
    if (!shipmentUser || !userId) return false;
    return shipmentUser.toString() === userId.toString();
};

const getBusinessDateString = (date = new Date(), timezone = 'Asia/Kolkata') => {
    try {
        const d = new Date(date);
        const options = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
        const formatter = new Intl.DateTimeFormat('en-CA', options);
        return formatter.format(d); // YYYY-MM-DD
    } catch (err) {
        return new Date(date).toISOString().slice(0, 10);
    }
};

// DFL Serviceable Pickup Cities (Delhi-NCR, Jaipur, Bhopal, Surat, Baroda, Nagina)
const DFL_PICKUP_CITIES = [
    'delhi',
    'new delhi',
    'ncr',
    'noida',
    'greater noida',
    'gurgaon',
    'gurugram',
    'ghaziabad',
    'faridabad',
    'jaipur',
    'bhopal',
    'surat',
    'baroda',
    'vadodara',
    'nagina'
];

const determineDefaultPickupMode = (addressString) => {
    if (!addressString || typeof addressString !== 'string') {
        return { pickupType: '3rd Party Pickup', pickupBy: 'Delhivery' };
    }
    const normalized = addressString.toLowerCase();
    const isDFL = DFL_PICKUP_CITIES.some(city => normalized.includes(city));
    if (isDFL) {
        return { pickupType: 'DFL Pickup', pickupBy: 'DFL Pickup' };
    }
    return { pickupType: '3rd Party Pickup', pickupBy: 'Delhivery' };
};

exports.determineDefaultPickupMode = determineDefaultPickupMode;
exports.DFL_PICKUP_CITIES = DFL_PICKUP_CITIES;

const MAX_MANIFEST_VALUE = 50000;

// Helper: Calculate shipment value reliably (Primary: Booking Amount / Service Price)
const getShipmentValue = (shipment) => {
    if (!shipment) return 0;

    // 1. Primary: Booking / Service Price paid by user
    if (shipment.serviceDetails && shipment.serviceDetails.price) {
        const cleaned = String(shipment.serviceDetails.price).replace(/[₹\s,]/g, '');
        const priceVal = parseFloat(cleaned);
        if (!isNaN(priceVal) && priceVal > 0) return Math.round(priceVal * 100) / 100;
    }

    // 2. Fallback: Invoice Total Amount
    if (shipment.invoice && shipment.invoice.totalAmount) {
        const invCleaned = String(shipment.invoice.totalAmount).replace(/[₹\s,]/g, '');
        const invVal = parseFloat(invCleaned);
        if (!isNaN(invVal) && invVal > 0) return Math.round(invVal * 100) / 100;
    }

    // 3. Fallback: Declared Item Value
    const details = shipment.shipmentDetails || {};
    const directVal = parseFloat(String(details.totalItemValue || details.totalTaxableValue || details.declaredValue || details.invoiceValue || 0).replace(/[₹\s,]/g, ''));
    if (!isNaN(directVal) && directVal > 0) return Math.round(directVal * 100) / 100;

    if (Array.isArray(details.boxes) && details.boxes.length > 0) {
        let boxItemsTotal = 0;
        details.boxes.forEach(box => {
            if (Array.isArray(box.items) && box.items.length > 0) {
                box.items.forEach(item => {
                    const price = parseFloat(item.unitPrice) || 0;
                    const qty = parseFloat(item.quantity) || 1;
                    boxItemsTotal += (price * qty);
                });
            }
        });
        if (boxItemsTotal > 0) return Math.round(boxItemsTotal * 100) / 100;
    }

    return 0;
};

// Helper: Calculate box count / packets
const getShipmentPacketCount = (shipment) => {
    if (!shipment) return 1;
    const details = shipment.shipmentDetails || {};
    const count = parseInt(details.noOfBoxes || (Array.isArray(details.boxes) ? details.boxes.length : 1), 10);
    return isNaN(count) || count <= 0 ? 1 : count;
};

// Helper: Calculate weight
const getShipmentWeight = (shipment) => {
    if (!shipment) return 0;
    const details = shipment.shipmentDetails || {};
    if (Array.isArray(details.boxes) && details.boxes.length > 0) {
        const total = details.boxes.reduce((acc, b) => acc + (parseFloat(b.weight) || 0), 0);
        if (total > 0) return total;
    }
    const chargeable = parseFloat(shipment.serviceDetails?.chargeableWeight || 0);
    return isNaN(chargeable) ? 0 : chargeable;
};

// Recalculate totals for a manifest document
const recalculateManifestTotals = (shipments) => {
    let totalVal = 0;
    let totalPkts = 0;
    let totalWt = 0;

    (shipments || []).forEach(s => {
        totalVal += getShipmentValue(s);
        totalPkts += getShipmentPacketCount(s);
        totalWt += getShipmentWeight(s);
    });

    return {
        totalOrders: shipments.length,
        packetCount: totalPkts,
        totalWeight: Math.round(totalWt * 100) / 100,
        manifestValue: totalVal.toFixed(2)
    };
};

// Helper: Format shipment for frontend
const formatShipmentData = (shipment) => {
    const val = getShipmentValue(shipment);
    const packets = getShipmentPacketCount(shipment);
    const weight = getShipmentWeight(shipment);

    return {
        _id: shipment._id,
        shipmentId: shipment.shipmentId || shipment._id,
        trackingId: shipment.trackingId || shipment.shipmentId || '',
        orderDate: shipment.createdAt,
        createdAt: shipment.createdAt,
        consigneeName: shipment.consigneeDetails?.consigneeName || 'Unknown',
        consigneeDetails: shipment.consigneeDetails,
        shipperDetails: shipment.shipperDetails,
        shipperAddress: [
            shipment.shipperDetails?.addressLine1,
            shipment.shipperDetails?.addressLine2,
            shipment.shipperDetails?.city,
            shipment.shipperDetails?.state,
            shipment.shipperDetails?.pincode
        ].filter(Boolean).join(', '),
        status: shipment.status || 'Pending',
        packages: packets,
        packetCount: packets,
        weight: weight,
        orderValue: val,
        formattedValue: `₹${val.toLocaleString('en-IN')}`
    };
};

// 1. Get Pickup Addresses for user
exports.getUserPickupAddresses = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const userObj = req.user || {};

        // Fetch saved addresses from Address model
        const customerId = userObj.customerId || userObj.customerID || userId;
        const savedAddresses = await Address.find({
            $or: [
                { customerID: customerId },
                { customerID: userId },
                { customerID: userObj._id?.toString() }
            ]
        }).sort({ isDefault: -1, createdAt: -1 });

        const addressList = [];
        const seen = new Set();

        const normalizeKey = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        savedAddresses.forEach(addr => {
            const parts = [
                addr.address?.addressLine,
                addr.address?.addressLine2,
                addr.address?.city,
                addr.address?.state,
                addr.address?.pincode
            ].filter(Boolean);

            const formatted = parts.join(', ');
            const key = normalizeKey(formatted);

            if (formatted && key && !seen.has(key)) {
                seen.add(key);
                addressList.push({
                    id: addr._id,
                    name: addr.name || 'Saved Address',
                    companyName: addr.companyName || '',
                    addressLine: addr.address?.addressLine || '',
                    city: addr.address?.city || '',
                    state: addr.address?.state || '',
                    pincode: addr.address?.pincode || '',
                    address: formatted,
                    isDefault: addr.isDefault || false,
                    isSaved: true
                });
            }
        });

        // Also fetch distinct shipper addresses from recent shipments (if not already saved)
        const recentShipments = await Shipment.find({
            user: userId,
            'shipperDetails.addressLine1': { $exists: true, $ne: '' }
        })
        .sort({ createdAt: -1 })
        .limit(30);

        recentShipments.forEach(s => {
            const sd = s.shipperDetails;
            const parts = [
                sd?.addressLine1,
                sd?.addressLine2,
                sd?.city,
                sd?.state,
                sd?.pincode
            ].filter(Boolean);

            const formatted = parts.join(', ');
            const key = normalizeKey(formatted);

            if (formatted && key && !seen.has(key)) {
                seen.add(key);
                addressList.push({
                    id: null,
                    name: sd?.shipperName || 'Recent Shipment Address',
                    companyName: sd?.companyName || '',
                    addressLine: sd?.addressLine1 || '',
                    city: sd?.city || '',
                    state: sd?.state || '',
                    pincode: sd?.pincode || '',
                    address: formatted,
                    isDefault: false,
                    isSaved: false
                });
            }
        });

        res.status(200).json(addressList);
    } catch (error) {
        
        res.status(500).json({ message: 'Error fetching pickup addresses' });
    }
};

// 2. Get pending shipments (Backward Compatibility)
exports.getPendingShipments = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const query = {
            user: userId,
            manifestId: null,
            status: { $nin: ['Cancelled', 'Delivered', 'RTO'] }
        };

        const shipments = await Shipment.find(query).sort({ createdAt: -1 });
        res.status(200).json(shipments);
    } catch (error) {
        
        res.status(500).json({ message: 'Error fetching pending shipments' });
    }
};

// 3. Create Manifest (Initial state = OPEN, with or without initial shipments)
exports.createManifest = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const { pickupAddress, pickupAddressId, shipmentIds = [] } = req.body;

        if (!pickupAddress || !pickupAddress.trim()) {
            return res.status(400).json({ message: 'Pickup Address is required to create a manifest' });
        }

        const normalizedShipmentIds = Array.isArray(shipmentIds) ? shipmentIds : (shipmentIds ? [shipmentIds] : []);
        const validShipmentIds = normalizedShipmentIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

        if (normalizedShipmentIds.length > 0 && validShipmentIds.length !== normalizedShipmentIds.length) {
            return res.status(400).json({ message: 'Invalid shipment selected' });
        }

        // Generate a unique ID (MAN-YYYYMMDD-XXXX)
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const manifestCode = `MAN-${dateStr}-${randomSuffix}`;

        let shipmentsToAttach = [];
        let totals = {
            totalOrders: 0,
            packetCount: 0,
            totalWeight: 0,
            manifestValue: '0.00'
        };

        if (validShipmentIds.length > 0) {
            shipmentsToAttach = await Shipment.find({
                _id: { $in: validShipmentIds },
                user: userId,
                manifestId: null
            });

            if (shipmentsToAttach.length !== validShipmentIds.length) {
                return res.status(400).json({ message: 'One or more shipments were not found or already assigned to a manifest' });
            }

            totals = recalculateManifestTotals(shipmentsToAttach);

            if (parseFloat(totals.manifestValue) > MAX_MANIFEST_VALUE) {
                return res.status(400).json({
                    message: `Manifest value cannot exceed ₹${MAX_MANIFEST_VALUE.toLocaleString('en-IN')}.`,
                    currentVal: 0,
                    addingVal: parseFloat(totals.manifestValue),
                    maxAllowed: MAX_MANIFEST_VALUE,
                    remainingVal: MAX_MANIFEST_VALUE
                });
            }
        }

        const todayDateStr = getBusinessDateString(new Date());

        // Check if customer already has a manifest for today - DISABLED FOR TESTING AS REQUESTED
        // const existingDaily = await Manifest.findOne({ user: userId, manifestBusinessDate: todayDateStr });
        // if (existingDaily) {
        //     return res.status(409).json({
        //         success: false,
        //         code: 'DAILY_MANIFEST_ALREADY_EXISTS',
        //         message: 'A manifest already exists for this customer for today.',
        //         manifestId: existingDaily._id,
        //         manifest: existingDaily
        //     });
        // }

        const defaultMode = determineDefaultPickupMode(pickupAddress);

        const newManifest = new Manifest({
            manifestId: manifestCode,
            user: userId,
            manifestBusinessDate: null,
            pickupAddress: pickupAddress.trim(),
            pickupAddressId: pickupAddressId || null,
            shipments: shipmentsToAttach.map(s => s._id),
            totalOrders: totals.totalOrders,
            packetCount: totals.packetCount,
            totalWeight: totals.totalWeight,
            manifestValue: totals.manifestValue,
            pickupType: defaultMode.pickupType,
            pickupBy: defaultMode.pickupBy,
            status: 'OPEN'
        });

        const savedManifest = await newManifest.save();

        if (shipmentsToAttach.length > 0) {
            await Shipment.updateMany(
                { _id: { $in: shipmentsToAttach.map(s => s._id) }, user: userId, manifestId: null },
                {
                    $set: {
                        manifestId: savedManifest._id,
                        manifestDate: new Date()
                    }
                }
            );
        }

        try {
            await logActivity(req, {
                action: 'MANIFEST_CREATED',
                targetModel: 'Manifest',
                target: savedManifest._id
            });
        } catch (logErr) {
            // Activity log failure is non-blocking for manifest creation
        }

        await savedManifest.populate([
            { path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] }
        ]);

        res.status(201).json(savedManifest);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Error creating manifest' });
    }
};

// 4. Get all manifests for user with pagination and search
exports.getManifests = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const { search, status, page = 1, limit = 10 } = req.query;

        let query = { user: userId };

        if (status && status !== 'All') {
            if (status === 'OPEN') {
                query.status = 'OPEN';
            } else if (status === 'CLOSED') {
                query.status = { $in: ['CLOSED', 'Completed', 'BOOKED'] };
            } else if (status === 'GENERATED' || status === 'Generated') {
                query.status = { $in: ['Generated', 'GENERATED', 'BOOKED'] };
            } else {
                query.status = status;
            }
        }

        if (search && search.trim()) {
            const regex = new RegExp(search.trim(), 'i');
            query.$or = [
                { manifestId: regex },
                { pickupAddress: regex }
            ];
        }

        const totalEntries = await Manifest.countDocuments(query);
        const manifests = await Manifest.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit, 10))
            .populate('shipments');

        // Status counts for tabs
        const allUserManifests = await Manifest.find({ user: userId }).select('status');
        const counts = {
            'All': allUserManifests.length,
            'OPEN': allUserManifests.filter(m => m.status === 'OPEN').length,
            'CLOSED': allUserManifests.filter(m => m.status === 'CLOSED' || m.status === 'Completed' || m.status === 'BOOKED').length,
            'GENERATED': allUserManifests.filter(m => m.status === 'Generated' || m.status === 'GENERATED' || m.status === 'BOOKED').length
        };

        res.status(200).json({
            manifests,
            totalEntries,
            totalPages: Math.ceil(totalEntries / limit) || 1,
            currentPage: parseInt(page, 10),
            statusCounts: counts
        });
    } catch (error) {
        
        res.status(500).json({ message: 'Error fetching manifests' });
    }
};

// 5. Get single manifest by ID
exports.getManifestById = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const manifest = await Manifest.findById(req.params.id)
            .populate({
                path: 'shipments',
                populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }]
            })
            .populate('pickupCostUpdatedBy', 'name designation')
            .populate('user', 'name email companyName phone mobile mobileNo');

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Strict customer isolation check
        const manifestUserId = manifest.user?._id ? manifest.user._id.toString() : manifest.user.toString();
        if (manifestUserId !== userId.toString() && !req.admin && req.user?.role !== 'Admin') {
            return res.status(403).json({ message: 'Access denied. You can only view your own manifests.' });
        }

        // Auto-sync totals if open
        if (manifest.status === 'OPEN' || manifest.status === 'Generated') {
            const totals = recalculateManifestTotals(manifest.shipments || []);
            if (
                manifest.manifestValue !== totals.manifestValue ||
                manifest.totalOrders !== totals.totalOrders ||
                manifest.packetCount !== totals.packetCount ||
                manifest.totalWeight !== totals.totalWeight
            ) {
                manifest.totalOrders = totals.totalOrders;
                manifest.packetCount = totals.packetCount;
                manifest.totalWeight = totals.totalWeight;
                manifest.manifestValue = totals.manifestValue;
                await manifest.save();
            }
        }

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error fetching manifest details' });
    }
};

// 6. Get Available Shipments for Manifest (Partitioned into Same vs Other Address)
exports.getAvailableShipmentsForManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Strict customer isolation check
        if (manifest.user.toString() !== userId.toString() && !req.admin && req.user?.role !== 'Admin') {
            return res.status(403).json({ message: 'Access denied. You can only access your own manifests.' });
        }

        // Available shipments: strictly for logged in user, not in any manifest, active status
        const availableShipments = await Shipment.find({
            user: userId,
            manifestId: null,
            status: { $nin: ['Cancelled', 'Delivered', 'RTO'] }
        }).sort({ createdAt: -1 });

        const manifestPickupAddr = (manifest.pickupAddress || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const sameAddressOrders = [];
        const otherAddressOrders = [];

        availableShipments.forEach(shipment => {
            const formatted = formatShipmentData(shipment);
            const shipperAddr = (shipment.shipperDetails?.addressLine1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const fullShipper = formatted.shipperAddress.toLowerCase().replace(/[^a-z0-9]/g, '');

            // Match if address line 1 or full address matches manifest pickup address
            const isMatch = shipperAddr && (
                manifestPickupAddr.includes(shipperAddr) ||
                shipperAddr.includes(manifestPickupAddr) ||
                fullShipper.includes(manifestPickupAddr) ||
                manifestPickupAddr.includes(fullShipper)
            );

            if (isMatch) {
                sameAddressOrders.push(formatted);
            } else {
                otherAddressOrders.push(formatted);
            }
        });

        res.status(200).json({
            manifestId: manifest.manifestId,
            pickupAddress: manifest.pickupAddress,
            sameAddressOrders,
            otherAddressOrders,
            totalAvailable: availableShipments.length
        });
    } catch (error) {
        
        res.status(500).json({ message: 'Error fetching available shipments' });
    }
};

// 7. Add Orders to Manifest (with ₹50,000 value limit check)
exports.addOrdersToManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);
        const { shipmentIds = [] } = req.body;

        if (!Array.isArray(shipmentIds) || shipmentIds.length === 0) {
            return res.status(400).json({ message: 'Please select at least one order to add.' });
        }

        const manifest = await Manifest.findById(id).populate('shipments');
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found.' });
        }

        // Strict customer isolation check
        if (manifest.user.toString() !== userId.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ message: 'Access denied. You can only modify your own manifests.' });
        }

        if (manifest.status === 'CLOSED' || manifest.status === 'Completed') {
            return res.status(400).json({ message: 'Cannot add orders. This manifest is CLOSED.' });
        }

        // Fetch new shipments to add strictly belonging to logged-in user
        const newShipments = await Shipment.find({
            _id: { $in: shipmentIds },
            user: userId,
            manifestId: null
        });

        if (newShipments.length === 0) {
            return res.status(400).json({ message: 'None of the selected orders are available for this manifest.' });
        }

        // Calculate combined shipments and totals
        const existingShipments = manifest.shipments || [];
        const existingShipmentIds = new Set(existingShipments.map(s => s._id.toString()));

        const toAdd = newShipments.filter(s => !existingShipmentIds.has(s._id.toString()));
        if (toAdd.length === 0) {
            return res.status(400).json({ message: 'Selected orders are already in this manifest.' });
        }

        const combinedShipments = [...existingShipments, ...toAdd];
        const newTotals = recalculateManifestTotals(combinedShipments);
        const currentVal = parseFloat(manifest.manifestValue || 0);
        const addingVal = parseFloat(newTotals.manifestValue) - currentVal;
        const totalAfter = parseFloat(newTotals.manifestValue);

        // ENFORCE ₹50,000 VALUE LIMIT
        if (totalAfter > MAX_MANIFEST_VALUE) {
            return res.status(400).json({
                message: `Manifest value cannot exceed ₹${MAX_MANIFEST_VALUE.toLocaleString('en-IN')}.`,
                currentVal: currentVal,
                addingVal: addingVal,
                totalAfterAdd: totalAfter,
                maxAllowed: MAX_MANIFEST_VALUE,
                remainingVal: Math.max(0, MAX_MANIFEST_VALUE - currentVal)
            });
        }

        // Update manifest
        manifest.shipments = combinedShipments.map(s => s._id);
        manifest.totalOrders = newTotals.totalOrders;
        manifest.packetCount = newTotals.packetCount;
        manifest.totalWeight = newTotals.totalWeight;
        manifest.manifestValue = newTotals.manifestValue;
        await manifest.save();

        // Update shipments
        await Shipment.updateMany(
            { _id: { $in: toAdd.map(s => s._id) }, user: userId },
            {
                $set: {
                    manifestId: manifest._id,
                    manifestDate: new Date()
                }
            }
        );

        await manifest.populate([
            { path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error adding orders to manifest' });
    }
};

// 8. Remove Order from Manifest
exports.removeOrderFromManifest = async (req, res) => {
    try {
        const { id, shipmentId } = req.params;
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id).populate('shipments');
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Strict customer isolation check
        if (manifest.user.toString() !== userId.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ message: 'Access denied. You can only modify your own manifests.' });
        }

        if (manifest.status === 'CLOSED' || manifest.status === 'Completed') {
            return res.status(400).json({ message: 'Cannot remove orders. This manifest is CLOSED.' });
        }

        const remainingShipments = (manifest.shipments || []).filter(s => s._id.toString() !== shipmentId);

        // Unlink shipment
        await Shipment.updateOne(
            { _id: shipmentId, user: userId },
            { $set: { manifestId: null, manifestDate: null } }
        );

        const newTotals = recalculateManifestTotals(remainingShipments);

        manifest.shipments = remainingShipments.map(s => s._id);
        manifest.totalOrders = newTotals.totalOrders;
        manifest.packetCount = newTotals.packetCount;
        manifest.totalWeight = newTotals.totalWeight;
        manifest.manifestValue = newTotals.manifestValue;
        await manifest.save();

        await manifest.populate([
            { path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error removing order from manifest' });
    }
};

// 9. Close Manifest
exports.closeManifest = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id).populate('shipments');
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Strict customer isolation check
        if (manifest.user.toString() !== userId.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ message: 'Access denied. You can only close your own manifests.' });
        }

        if (['CLOSED', 'Completed', 'BOOKED', 'GENERATED', 'Generated'].includes(manifest.status)) {
            return res.status(400).json({ message: 'This manifest is already closed or booked and cannot be closed again.' });
        }

        // Recalculate latest totals to be 100% consistent
        const totals = recalculateManifestTotals(manifest.shipments || []);
        manifest.totalOrders = totals.totalOrders;
        manifest.packetCount = totals.packetCount;
        manifest.totalWeight = totals.totalWeight;
        manifest.manifestValue = totals.manifestValue;

        manifest.status = 'CLOSED';
        manifest.closedAt = new Date();
        manifest.closedBy = userId;
        manifest.status = 'CLOSED';

        await manifest.save();

        await manifest.populate([
            { path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] }
        ]);

        return res.status(200).json(manifest);
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Error closing manifest' });
    }
};

// 10. Download Box Label PDF (4x6 thermal ready PDF with Hub address & barcode)
exports.downloadBoxLabelPdf = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id)
            .populate([
                { path: 'shipments', populate: [{ path: 'shipperDetails' }, { path: 'consigneeDetails' }] },
                { path: 'user', select: 'name email companyName phone mobile mobileNo' }
            ]);

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Access check
        const manifestUserId = manifest.user?._id ? manifest.user._id.toString() : manifest.user.toString();
        if (manifestUserId !== userId?.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        const manifestCode = manifest.manifestId || 'MAN-DFL-0000';
        const totalPkgs = manifest.packetCount || manifest.shipments?.length || 1;
        const totalVal = parseFloat(manifest.manifestValue || 0).toFixed(2);

        const doc = new PDFDocument({
            size: [288, 432], // 4x6 inches
            margins: { top: 8, bottom: 8, left: 8, right: 8 }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=DFL_Box_Label_${manifestCode}.pdf`);

        doc.pipe(res);

        // Outer Border
        doc.rect(8, 8, 272, 416).lineWidth(2).strokeColor('#000000').stroke();

        // Header: Logo on Left, DFL PICKUP on Right
        const logoPath = path.join(__dirname, '../public/assets/dfl_longo.png');
        if (fs.existsSync(logoPath)) {
            try {
                doc.image(logoPath, 14, 12, { height: 18 });
            } catch (imgErr) {
                doc.fontSize(10).font('Helvetica-Bold').fillColor('#0B4F6C').text('DFL EXPRESS', 14, 14);
            }
        }
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text('DFL PICKUP', 15, 14, { width: 258, align: 'right' });
        doc.moveTo(8, 34).lineTo(280, 34).lineWidth(1.5).stroke();

        // Top Barcode
        try {
            const barcodePng = await bwipjs.toBuffer({
                bcid: 'code128',
                text: manifestCode,
                scale: 2,
                height: 10,
                includetext: true,
                textxalign: 'center',
                textsize: 8
            });
            doc.image(barcodePng, 24, 40, { fit: [240, 46], align: 'center' });
        } catch (bErr) {
            doc.fontSize(11).font('Courier-Bold').text(manifestCode, 15, 52, { align: 'center' });
        }

        doc.moveTo(8, 92).lineTo(280, 92).lineWidth(1.5).stroke();

        // Hub Delivery Address (Left) & Service (Right)
        doc.fontSize(7).font('Helvetica-Bold').text('DELIVERY ADDRESS', 14, 98);
        doc.fontSize(8).font('Helvetica-Bold').text('DFL Group Hub', 14, 108);
        doc.fontSize(7).font('Helvetica').text('A 111, Logix Technova, Block B, Sector 132,\nNoida, Uttar Pradesh - 201301', 14, 118, { width: 175 });
        doc.fontSize(7).font('Helvetica-Bold').text('Contact: 9355151122', 14, 142);

        // Vertical divider
        doc.moveTo(195, 92).lineTo(195, 155).lineWidth(1.5).stroke();

        // Service details (Right)
        doc.fontSize(8.5).font('Helvetica-Bold').text('Pre-paid', 202, 108);
        doc.fontSize(8.5).font('Helvetica-Bold').text('Express', 202, 122);

        doc.moveTo(8, 155).lineTo(280, 155).lineWidth(1.5).stroke();

        // Product summary table
        doc.rect(8, 155, 272, 15).fillColor('#f1f5f9').fill();
        doc.fillColor('#000000').fontSize(7).font('Helvetica-Bold');
        doc.text('Product Name', 14, 160, { width: 130 });
        doc.text('Qty', 150, 160, { width: 40, align: 'center' });
        doc.text('Total (Rs.)', 195, 160, { width: 75, align: 'right' });

        doc.moveTo(8, 170).lineTo(280, 170).lineWidth(1).stroke();

        doc.font('Helvetica').fontSize(7);
        doc.text('Assorted Goods', 14, 176, { width: 130 });
        doc.font('Helvetica-Bold').text(String(totalPkgs), 150, 176, { width: 40, align: 'center' });
        doc.text(totalVal, 195, 176, { width: 75, align: 'right' });

        doc.moveTo(8, 190).lineTo(280, 190).lineWidth(1).stroke();
        doc.rect(8, 190, 272, 15).fillColor('#f1f5f9').fill();
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(7);
        doc.text('Total:', 14, 195, { width: 175, align: 'right' });
        doc.text(`Rs. ${totalVal}`, 195, 195, { width: 75, align: 'right' });

        doc.moveTo(8, 205).lineTo(280, 205).lineWidth(1.5).stroke();

        // Bottom Barcode & Date
        try {
            const barcodePng2 = await bwipjs.toBuffer({
                bcid: 'code128',
                text: manifestCode,
                scale: 2,
                height: 10,
                includetext: true,
                textxalign: 'center',
                textsize: 8
            });
            doc.image(barcodePng2, 24, 212, { fit: [240, 46], align: 'center' });
        } catch (bErr2) {
            doc.fontSize(11).font('Courier-Bold').text(manifestCode, 15, 226, { align: 'center' });
        }

        const now = new Date(manifest.createdAt || new Date());
        const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);
        doc.fontSize(7).font('Courier').text(dateStr, 15, 265, { width: 258, align: 'center' });

        doc.moveTo(8, 276).lineTo(280, 276).lineWidth(1.5).stroke();

        // Sender & Return details
        const firstShipper = manifest.shipments?.[0]?.shipperDetails;
        const senderName = firstShipper?.shipperName || manifest.user?.name || 'Sender';
        const senderCompany = manifest.user?.companyName || firstShipper?.companyName || '';
        const senderPhone = firstShipper?.mobileNo || firstShipper?.contactNumber || manifest.user?.phone || manifest.user?.mobile || manifest.user?.mobileNo || '';

        doc.fontSize(7.5).font('Helvetica-Bold').text('SENDER & RETURN DETAILS', 14, 284);
        doc.fontSize(7.5).font('Helvetica-Bold').text(senderName, 14, 295);
        let curY = 306;
        if (senderCompany) {
            doc.fontSize(6.5).font('Helvetica').text(senderCompany, 14, curY);
            curY += 9;
        }
        doc.fontSize(7).font('Helvetica').text(manifest.pickupAddress || 'Customer Address', 14, curY, { width: 258 });

        if (senderPhone) {
            doc.fontSize(7.5).font('Helvetica-Bold').text(`Contact: ${senderPhone}`, 14, 340);
        }

        // Mark label as generated and transition status to 'Generated' if manifest is also printed
        manifest.isLabelGenerated = true;
        manifest.labelGeneratedAt = new Date();
        if (manifest.isManifestPrinted) {
            manifest.status = 'Generated';
        }
        await manifest.save();

        doc.end();
    } catch (error) {
        res.status(500).json({ message: error.message || 'Error generating box label PDF' });
    }
};

// 11. Mark Manifest Printed (and transition to 'Generated' if label is also generated)
exports.markManifestPrinted = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        // Access check
        const manifestUserId = manifest.user?._id ? manifest.user._id.toString() : manifest.user.toString();
        if (manifestUserId !== userId?.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        manifest.isManifestPrinted = true;
        manifest.manifestPrintedAt = new Date();

        if (manifest.isLabelGenerated) {
            manifest.status = 'Generated';
        }

        await manifest.save();

        await manifest.populate([
            { path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] },
            { path: 'user', select: 'name email companyName phone mobile mobileNo' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error marking manifest as printed' });
    }
};

// ==========================================
// ADMIN CONTROLLER FUNCTIONS (PRESERVED)
// ==========================================

// Update Pickup Cost (Sales Executive only)
exports.updatePickupCost = async (req, res) => {
    try {
        const { id } = req.params;
        const { pickupCost } = req.body;
        const admin = req.admin;

        if (admin?.designation !== 'Sales Executive') {
            return res.status(403).json({
                message: 'Access denied. Only Sales Executives can update PickUp-Cost.'
            });
        }

        const manifest = await Manifest.findById(id).populate('shipments');
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        const totalCost = parseFloat(pickupCost) || 0;
        const shipmentCount = manifest.shipments.length;

        if (shipmentCount > 0) {
            const baseCost = Math.floor((totalCost / shipmentCount) * 100) / 100;
            const distributedTotal = baseCost * shipmentCount;
            const remainder = Math.round((totalCost - distributedTotal) * 100) / 100;

            const bulkOps = manifest.shipments.map((shipment, index) => {
                let cost = baseCost;
                if (index === 0) {
                    cost += remainder;
                    cost = Math.round(cost * 100) / 100;
                }

                return {
                    updateOne: {
                        filter: { _id: shipment._id },
                        update: { $set: { manifestPickupCost: cost } }
                    }
                };
            });

            await Shipment.bulkWrite(bulkOps);
        }

        manifest.pickupCost = totalCost.toFixed(2);
        manifest.pickupCostUpdatedBy = admin._id;
        await manifest.save();

        await manifest.populate([
            { path: 'shipments', populate: { path: 'consigneeDetails' } },
            { path: 'pickupCostUpdatedBy', select: 'name email designation' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error updating pickup cost' });
    }
};

// Upload Manifest Label
exports.uploadManifestLabel = async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.admin || req.user;

        if (user?.designation !== 'Sales Executive') {
            return res.status(403).json({
                message: 'Access denied. Only Sales Executives can upload labels.'
            });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        const labelUrl = `/manifest-labels/${req.file.filename}`;
        manifest.labelUrl = labelUrl;
        await manifest.save();

        res.status(200).json({
            message: 'Label uploaded successfully',
            labelUrl: labelUrl,
            manifest
        });
    } catch (error) {
        
        res.status(500).json({ message: 'Error uploading manifest label' });
    }
};

// Delete Manifest Label
exports.deleteManifestLabel = async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.admin || req.user;

        if (user?.designation !== 'Sales Executive') {
            return res.status(403).json({
                message: 'Access denied. Only Sales Executives can delete labels.'
            });
        }

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        if (!manifest.labelUrl) {
            return res.status(400).json({ message: 'No label to delete' });
        }

        const filename = manifest.labelUrl.split('/').pop();
        const filePath = require('path').join(__dirname, '../public/manifest-labels', filename);

        const fs = require('fs').promises;
        try {
            await fs.unlink(filePath);
        } catch (unlinkErr) {
            // File might already be removed from disk; proceeding to clear DB reference
        }

        manifest.labelUrl = null;
        await manifest.save();

        res.status(200).json({ message: 'Label deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Error deleting manifest label' });
    }
};

// Update Shipment Pickup Cost
exports.updateShipmentPickupCost = async (req, res) => {
    try {
        const { id, shipmentId } = req.params;
        const { cost } = req.body;
        const user = req.admin || req.user;

        if (user?.designation !== 'Sales Executive') {
            return res.status(403).json({
                message: 'Access denied. Only Sales Executives can update shipment costs.'
            });
        }

        const shipment = await Shipment.findById(shipmentId);
        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        shipment.manifestPickupCost = parseFloat(cost) || 0;
        await shipment.save();

        const manifest = await Manifest.findById(id).populate('shipments');
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        const totalCost = manifest.shipments.reduce((sum, s) => {
            return sum + (s.manifestPickupCost || 0);
        }, 0);

        manifest.pickupCost = totalCost.toFixed(2);
        manifest.pickupCostUpdatedBy = user._id;
        await manifest.save();

        await manifest.populate([
            { path: 'shipments', populate: { path: 'consigneeDetails' } },
            { path: 'pickupCostUpdatedBy', select: 'name email designation' },
            { path: 'user', select: 'name email companyName' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error updating shipment cost' });
    }
};

// Update Pickup Status
exports.updatePickupStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['Pending', 'Completed'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be Pending or Completed.' });
        }

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        manifest.pickupStatus = status;
        await manifest.save();

        await manifest.populate([
            { path: 'user', select: 'name email companyName' },
            { path: 'pickupCostUpdatedBy', select: 'name designation' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error updating pickup status' });
    }
};

// Update Pickup By
exports.updatePickupBy = async (req, res) => {
    try {
        const { id } = req.params;
        const { pickupBy, pickupType } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        manifest.pickupBy = pickupBy;
        if (pickupType) {
            manifest.pickupType = pickupType;
        } else if (pickupBy === 'Self-Drop' || pickupBy === 'Self Drop') {
            manifest.pickupType = 'Self-Drop';
        } else if (pickupBy === 'DFL Pickup') {
            manifest.pickupType = 'DFL Pickup';
        } else {
            manifest.pickupType = '3rd Party Pickup';
        }

        await manifest.save();

        // --- AUTOMATED ENVIA 3RD-PARTY PICKUP BOOKING ON CARRIER SELECTION ---
        const is3rdParty = manifest.pickupType === '3rd Party Pickup' || (pickupBy && pickupBy !== 'DFL Pickup' && pickupBy !== 'Self-Drop' && pickupBy !== 'Self Drop');

        if (is3rdParty) {
            try {
                const { enviaPickupService } = require('../services/envia');
                const isEnviaEnabled = await enviaPickupService._isEnviaEnabled();
                if (isEnviaEnabled) {
                    console.log(`[AUTO-ENVIA-PICKUP] Auto-triggering Envia pickup booking for manifest ${id} with carrier: ${pickupBy}`);
                    const enviaRes = await enviaPickupService.create3rdPartyPickupManifest(id, req.user || req.admin, pickupBy);
                    if (enviaRes) {
                        manifest.awbNumber = enviaRes.awbNumber || manifest.awbNumber;
                        manifest.labelUrl = enviaRes.manifestUrl || enviaRes.labelUrl || manifest.labelUrl;
                        manifest.status = 'Generated';
                        await manifest.save();
                    }
                }
            } catch (autoErr) {
                console.warn(`[AUTO-ENVIA-PICKUP] Warning during auto-booking: ${autoErr.message}`);
            }
        }

        const updatedManifest = await Manifest.findById(id).populate([
            { path: 'user', select: 'name email companyName' },
            { path: 'pickupCostUpdatedBy', select: 'name designation' }
        ]);

        res.status(200).json(updatedManifest);
    } catch (error) {
        
        res.status(500).json({ message: error.message || 'Error updating pickup details' });
    }
};

// Update Invoice Number
exports.updateInvoiceNumber = async (req, res) => {
    try {
        const { id } = req.params;
        const { invoiceNumber } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        manifest.invoiceNumber = invoiceNumber;
        await manifest.save();

        await manifest.populate([
            { path: 'user', select: 'name email companyName' },
            { path: 'pickupCostUpdatedBy', select: 'name designation' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error updating invoice number' });
    }
};

// Update AWB Number
exports.updateAwbNumber = async (req, res) => {
    try {
        const { id } = req.params;
        const { awbNumber } = req.body;

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        manifest.awbNumber = awbNumber;
        await manifest.save();

        await manifest.populate([
            { path: 'user', select: 'name email companyName' },
            { path: 'pickupCostUpdatedBy', select: 'name designation' }
        ]);

        res.status(200).json(manifest);
    } catch (error) {
        
        res.status(500).json({ message: 'Error updating AWB number' });
    }
};

// Get Staff with Pickup Permission
exports.getPickupStaff = async (req, res) => {
    try {
        const Admin = require('../models/Admin');
        const staffMembers = await Admin.find({ isActive: true })
            .select('name contactNumber email designation department role permissions')
            .sort({ name: 1 });

        return res.status(200).json(staffMembers);
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Error fetching pickup staff' });
    }
};

// Generate / Download 3rd-Party Pickup Manifest via Envia
exports.download3rdPartyManifestPdf = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getAuthenticatedUserId(req);
        const { enviaPickupService } = require('../services/envia');

        const manifest = await Manifest.findById(id);
        if (!manifest) {
            return res.status(404).json({ success: false, message: 'Manifest not found' });
        }

        const manifestUserId = manifest.user?._id ? manifest.user._id.toString() : manifest.user.toString();
        if (manifestUserId !== userId?.toString() && !isAdminRequester(req)) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        // If manifest already has a generated label/manifest URL, return it
        if (manifest.labelUrl) {
            return res.status(200).json({
                success: true,
                manifestUrl: manifest.labelUrl,
                awbNumber: manifest.awbNumber,
                pickupBy: manifest.pickupBy
            });
        }

        // Otherwise generate on-demand via Envia
        const result = await enviaPickupService.create3rdPartyPickupManifest(id, req.user || req.admin);
        return res.status(200).json({
            success: true,
            manifestUrl: result.manifestUrl || result.labelUrl,
            awbNumber: result.awbNumber,
            pickupBy: result.carrier
        });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || 'Error generating 3rd-party pickup manifest via Envia'
        });
    }
};

// Get or create today's daily manifest for logged in customer
exports.getTodayManifest = async (req, res) => {
    try {
        const userId = getAuthenticatedUserId(req);
        const todayDateStr = getBusinessDateString(new Date());

        let manifest = await Manifest.findOne({ user: userId, manifestBusinessDate: todayDateStr })
            .populate({ path: 'shipments', populate: [{ path: 'consigneeDetails' }, { path: 'shipperDetails' }] });

        let created = false;
        if (!manifest) {
            const pendingShipments = await Shipment.find({ user: userId, manifestId: null, status: { $nin: ['Cancelled', 'Delivered', 'RTO'] } }).limit(1);
            const defaultAddress = pendingShipments[0]?.shipperDetails?.addressLine1 || 'Default Pickup Address';

            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const randomSuffix = Math.floor(1000 + Math.random() * 9000);
            const manifestCode = `MAN-${dateStr}-${randomSuffix}`;
            const defaultMode = determineDefaultPickupMode(defaultAddress);

            manifest = new Manifest({
                manifestId: manifestCode,
                user: userId,
                pickupAddress: defaultAddress,
                manifestBusinessDate: todayDateStr,
                pickupType: defaultMode.pickupType,
                pickupBy: defaultMode.pickupBy,
                status: 'OPEN'
            });
            await manifest.save();
            created = true;
        }

        res.status(200).json({
            success: true,
            created,
            manifest
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Error retrieving today manifest' });
    }
};

// Fetch Envia Rate options for consolidated manifest
exports.fetchManifestRates = async (req, res) => {
    try {
        const { id } = req.params;
        const { enviaPickupService } = require('../services/envia');
        const options = await enviaPickupService.getNormalizedRatesForManifest(id, req.user || req.admin);
        res.status(200).json({
            success: true,
            options
        });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            code: error.code || 'ENVIA_RATE_FAILED',
            message: error.message || 'Error fetching rates for manifest'
        });
    }
};

// Book Envia Pickup for consolidated manifest with rate selection & idempotency lock
exports.bookManifestPickup = async (req, res) => {
    try {
        const { id } = req.params;
        const { enviaPickupService } = require('../services/envia');
        const result = await enviaPickupService.bookConsolidatedManifest(id, req.user || req.admin, req.body);
        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            code: error.code || 'ENVIA_BOOKING_FAILED',
            message: error.message || 'Error booking pickup for manifest'
        });
    }
};

