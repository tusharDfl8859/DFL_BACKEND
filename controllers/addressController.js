const Address = require('../models/Address');
const { logActivity } = require('../utils/activityLogger');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const getCustomerId = (req) => req.user?.customerId || req.user?._id?.toString() || req.params?.customerId || req.body?.customerId;

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const getAddressUpdatePayload = (body) => {
    const payload = {};

    if (body.name !== undefined) payload.name = body.name;
    if (body.companyName !== undefined) payload.companyName = body.companyName;
    if (body.contact !== undefined) payload.contact = body.contact;
    if (body.address !== undefined) payload.address = body.address;
    if (body.alternateContact !== undefined) payload.alternateContact = body.alternateContact;
    if (body.isDefault !== undefined) payload.isDefault = body.isDefault;

    return payload;
};

// Add a new address
const addAddress = async (req, res) => {
    try {
        const customerID = getCustomerId(req);
        if (!customerID) {
            return res.status(401).json({ message: 'Not authorized, customer ID missing' });
        }

        const { name, companyName, contact, address, alternateContact, isDefault } = req.body;

        // If this is the first address, make it default
        const addressCount = await Address.countDocuments({ customerID });
        const shouldBeDefault = addressCount === 0 || isDefault;

        // If setting as default, unset other defaults for this user
        if (shouldBeDefault) {
            await Address.updateMany({ customerID }, { isDefault: false });
        }

        const newAddress = new Address({
            customerID,
            savedAddressId: uuidv4(),
            name,
            companyName,
            contact,
            address,
            alternateContact,
            isDefault: shouldBeDefault
        });

        const savedAddress = await newAddress.save();
        try {
            await logActivity(req, {
                action: 'ADDRESS_ADDED',
                targetModel: 'Address',
                target: savedAddress._id
            });
        } catch (logErr) {
            console.error('Activity log error in addAddress:', logErr);
        }
        res.status(201).json(savedAddress);
    } catch (error) {
        console.error('Error adding address:', error);
        res.status(500).json({ message: 'Error adding address', error: error.message });
    }
};

// Get all addresses for a customer
const getAddresses = async (req, res) => {
    try {
        const customerId = getCustomerId(req);
        if (!customerId) {
            return res.status(401).json({ message: 'Not authorized, customer ID missing' });
        }

        const addresses = await Address.find({ customerID: customerId }).sort({ isDefault: -1, createdAt: -1 });
        res.status(200).json(addresses);
    } catch (error) {
        console.error('Error fetching addresses:', error);
        res.status(500).json({ message: 'Error fetching addresses', error: error.message });
    }
};

// Update an address
const updateAddress = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid address id' });
        }

        const customerId = getCustomerId(req);
        if (!customerId) {
            return res.status(401).json({ message: 'Not authorized, customer ID missing' });
        }

        const addressToUpdate = await Address.findOne({ _id: id, customerID: customerId });
        if (!addressToUpdate) {
            return res.status(404).json({ message: 'Address not found' });
        }

        const updates = getAddressUpdatePayload(req.body);

        if (updates.isDefault) {
            await Address.updateMany({ customerID: customerId }, { isDefault: false });
        }

        const updatedAddress = await Address.findOneAndUpdate(
            { _id: id, customerID: customerId },
            updates,
            { returnDocument: 'after', runValidators: true }
        );

        try {
            await logActivity(req, {
                action: 'ADDRESS_UPDATED',
                targetModel: 'Address',
                target: updatedAddress._id
            });
        } catch (logErr) {
            console.error('Activity log error in updateAddress:', logErr);
        }

        res.status(200).json(updatedAddress);
    } catch (error) {
        console.error('Error updating address:', error);
        res.status(500).json({ message: 'Error updating address', error: error.message });
    }
};

// Delete an address
const deleteAddress = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid address id' });
        }

        const customerId = getCustomerId(req);
        if (!customerId) {
            return res.status(401).json({ message: 'Not authorized, customer ID missing' });
        }

        const deletedAddress = await Address.findOneAndDelete({ _id: id, customerID: customerId });

        if (!deletedAddress) {
            return res.status(404).json({ message: 'Address not found' });
        }

        try {
            await logActivity(req, {
                action: 'ADDRESS_DELETED',
                targetModel: 'Address',
                target: deletedAddress._id
            });
        } catch (logErr) {
            console.error('Activity log error in deleteAddress:', logErr);
        }

        res.status(200).json({ message: 'Address deleted successfully' });
    } catch (error) {
        console.error('Error deleting address:', error);
        res.status(500).json({ message: 'Error deleting address', error: error.message });
    }
};

module.exports = {
    addAddress,
    getAddresses,
    updateAddress,
    deleteAddress
};
