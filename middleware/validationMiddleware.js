const { validationResult, body } = require('express-validator');
const { validatePassword } = require('../utils/passwordPolicy');

// Middleware to check validation results
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const errorArray = errors.array();
        const firstMessage = errorArray[0]?.msg || 'Validation failed';
        return res.status(400).json({
            success: false,
            message: firstMessage,
            errors: errorArray
        });
    }
    next();
};

const customPasswordValidator = (value) => {
    const result = validatePassword(value);
    if (!result.isValid) {
        throw new Error(result.message);
    }
    return true;
};

// Auth Validations
const validateSignup = [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false }),
    body('password').custom(customPasswordValidator),
    body('phone').optional().isString().trim(),
    handleValidationErrors
];

const validateLogin = [
    body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false }),
    body('password').notEmpty().withMessage('Password is required'),
    handleValidationErrors
];

const validateEmail = [
    body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false }),
    handleValidationErrors
];

const validateResetPassword = [
    body('password').custom(customPasswordValidator),
    handleValidationErrors
];

const validateProfileUpdate = [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('email').optional().trim().isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false }),
    body('phone').optional().isString().trim(),
    body('password').optional().custom(customPasswordValidator),
    handleValidationErrors
];

// Shipment Validations
const validateShipmentCreate = [
    body('shipperDetails').notEmpty().withMessage('Shipper details are required'),
    body('consigneeDetails').notEmpty().withMessage('Consignee details are required'),
    body('shipmentDetails').notEmpty().withMessage('Shipment details are required'),
    handleValidationErrors
];

module.exports = {
    handleValidationErrors,
    validateSignup,
    validateLogin,
    validateEmail,
    validateResetPassword,
    validateProfileUpdate,
    validateShipmentCreate
};
