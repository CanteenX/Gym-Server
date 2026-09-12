/**
 * Input Validation & Sanitization Middleware
 * Implements OWASP best practices for input validation:
 * - Schema-based validation using express-validator
 * - Type checking
 * - Length limits
 * - Reject unexpected fields
 * - Sanitize inputs to prevent XSS/NoSQL injection
 * 
 * OWASP Input Validation Cheat Sheet:
 * https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 */

import { body, param, validationResult } from 'express-validator';
import mongoSanitize from 'express-mongo-sanitize';

// ============ CONSTANTS ============

// Maximum length limits for common fields
const MAX_LENGTHS = {
    EMAIL: 254, // RFC 5321 limit
    PASSWORD: 128,
    NAME: 100,
    SHORT_TEXT: 255,
    MEDIUM_TEXT: 1000,
    LONG_TEXT: 5000,
    PHONE: 20,
    URL: 2048,
    MONGODB_ID: 24,
    IP_ADDRESS: 45, // IPv6 max length
    COORDINATES: 20,
};

// Minimum length limits
const MIN_LENGTHS = {
    PASSWORD: 6,
    NAME: 1,
};

// ============ SANITIZATION HELPERS ============

/**
 * Sanitize string input - trim whitespace and escape HTML entities
 * @param {string} value - Input value
 * @returns {string} Sanitized value
 */
const sanitizeString = (value) => {
    if (typeof value !== 'string') return value;
    return value
        .trim()
        .replace(/[<>]/g, '') // Remove < and > to prevent basic XSS
        .replace(/javascript:/gi, '') // Remove javascript: protocol
        .replace(/on\w+=/gi, ''); // Remove event handlers like onclick=
};

/**
 * Create MongoDB sanitization middleware instance
 * Prevents NoSQL injection attacks
 */
export const mongoSanitizer = mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
        console.warn(`[SECURITY] Sanitized potentially malicious input in key: ${key}`);
    },
});

// ============ VALIDATION RESULT HANDLER ============

/**
 * Middleware to check validation results
 * Returns 400 with detailed error messages if validation fails
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);

    if (errors.isEmpty()) {
        return next();
    }

    const formattedErrors = errors.array().map(error => ({
        field: error.path || error.param,
        message: error.msg,
        value: error.value === undefined ? undefined : '[REDACTED]', // Don't expose sensitive values
    }));

    return res.status(400).json({
        isOk: false,
        status: 400,
        error: 'Validation Error',
        message: 'Invalid input data',
        details: formattedErrors,
    });
};

// ============ REUSABLE VALIDATORS ============

/**
 * Email validation chain
 */
export const emailValidator = body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Please provide a valid email address')
    .isLength({ max: MAX_LENGTHS.EMAIL }).withMessage(`Email must not exceed ${MAX_LENGTHS.EMAIL} characters`)
    .normalizeEmail();

/**
 * Password validation chain (for login - less strict)
 */
export const passwordValidator = body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: MIN_LENGTHS.PASSWORD, max: MAX_LENGTHS.PASSWORD })
    .withMessage(`Password must be between ${MIN_LENGTHS.PASSWORD} and ${MAX_LENGTHS.PASSWORD} characters`);

/**
 * Strong password validation chain (for registration/reset)
 */
export const strongPasswordValidator = body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8, max: MAX_LENGTHS.PASSWORD })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number');

/**
 * MongoDB ObjectId validation chain
 */
export const mongoIdValidator = (fieldName, location = 'param') => {
    const validator = location === 'param' ? param : body;
    return validator(fieldName)
        .notEmpty().withMessage(`${fieldName} is required`)
        .isMongoId().withMessage(`${fieldName} must be a valid ID`);
};

/**
 * Name field validation chain
 */
export const nameValidator = (fieldName) => body(fieldName)
    .trim()
    .notEmpty().withMessage(`${fieldName} is required`)
    .isLength({ min: MIN_LENGTHS.NAME, max: MAX_LENGTHS.NAME })
    .withMessage(`${fieldName} must be between ${MIN_LENGTHS.NAME} and ${MAX_LENGTHS.NAME} characters`)
    .customSanitizer(sanitizeString);

/**
 * Optional name field validation chain
 */
export const optionalNameValidator = (fieldName) => body(fieldName)
    .optional()
    .trim()
    .isLength({ max: MAX_LENGTHS.NAME })
    .withMessage(`${fieldName} must not exceed ${MAX_LENGTHS.NAME} characters`)
    .customSanitizer(sanitizeString);

/**
 * Phone number validation chain
 */
export const phoneValidator = (fieldName = 'mobileNumber') => body(fieldName)
    .optional()
    .trim()
    .isLength({ max: MAX_LENGTHS.PHONE })
    .withMessage(`${fieldName} must not exceed ${MAX_LENGTHS.PHONE} characters`)
    .matches(/^[+\d\s\-()]*$/)
    .withMessage(`${fieldName} contains invalid characters`);

/**
 * Boolean validation chain
 */
export const booleanValidator = (fieldName) => body(fieldName)
    .optional()
    .isBoolean().withMessage(`${fieldName} must be a boolean value`)
    .toBoolean();

/**
 * Pagination validation chain
 */
export const paginationValidators = [
    body('skip')
        .optional()
        .isInt({ min: 0 }).withMessage('skip must be a non-negative integer')
        .toInt(),
    body('per_page')
        .optional()
        .isInt({ min: 1, max: 100 }).withMessage('per_page must be between 1 and 100')
        .toInt(),
    body('sorton')
        .optional()
        .trim()
        .isLength({ max: 50 }).withMessage('sorton must not exceed 50 characters')
        .matches(/^[a-zA-Z_]+$/).withMessage('sorton contains invalid characters'),
    body('sortdir')
        .optional()
        .trim()
        .isIn(['asc', 'desc', 'ASC', 'DESC']).withMessage('sortdir must be asc or desc'),
    body('match')
        .optional()
        .trim()
        .isLength({ max: MAX_LENGTHS.SHORT_TEXT }).withMessage(`match must not exceed ${MAX_LENGTHS.SHORT_TEXT} characters`)
        .customSanitizer(sanitizeString),
];

// ============ ENDPOINT-SPECIFIC VALIDATORS ============

/**
 * Login request validation
 */
export const loginValidation = [
    emailValidator,
    passwordValidator,
    handleValidationErrors,
];

/**
 * Employee creation validation
 */
export const createEmployeeValidation = [
    nameValidator('employeeName'),
    mongoIdValidator('departmentId', 'body'),
    mongoIdValidator('roleId', 'body'),
    body('emailOffice')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .isLength({ max: MAX_LENGTHS.EMAIL }).withMessage(`Email must not exceed ${MAX_LENGTHS.EMAIL} characters`)
        .normalizeEmail(),
    phoneValidator('mobileNumber'),
    mongoIdValidator('countryId', 'body'),
    mongoIdValidator('stateId', 'body'),
    mongoIdValidator('cityId', 'body'),
    body('address')
        .optional()
        .trim()
        .isLength({ max: MAX_LENGTHS.MEDIUM_TEXT })
        .withMessage(`Address must not exceed ${MAX_LENGTHS.MEDIUM_TEXT} characters`)
        .customSanitizer(sanitizeString),
    strongPasswordValidator,
    booleanValidator('isActive'),
    handleValidationErrors,
];

/**
 * Company creation validation
 */
export const createCompanyValidation = [
    nameValidator('companyName'),
    emailValidator,
    strongPasswordValidator,
    phoneValidator('mobileNumber'),
    body('gstNumber')
        .optional()
        .trim()
        .isLength({ max: 20 })
        .withMessage('GST number must not exceed 20 characters')
        .customSanitizer(sanitizeString),
    body('countryId').optional().isMongoId().withMessage('Country must be a valid ID'),
    body('stateId').optional().isMongoId().withMessage('State must be a valid ID'),
    body('cityId').optional().isMongoId().withMessage('City must be a valid ID'),
    body('address')
        .optional()
        .trim()
        .isLength({ max: MAX_LENGTHS.MEDIUM_TEXT })
        .customSanitizer(sanitizeString),
    body('pincode')
        .optional()
        .trim()
        .isLength({ max: 10 })
        .matches(/^[\d-]*$/)
        .withMessage('Pincode contains invalid characters'),
    body('website')
        .optional()
        .trim()
        .isLength({ max: MAX_LENGTHS.URL })
        .isURL({ require_protocol: false }).withMessage('Invalid website URL'),
    booleanValidator('isActive'),
    handleValidationErrors,
];

/**
 * OTP validation
 */
export const otpValidation = [
    emailValidator,
    body('otp')
        .trim()
        .notEmpty().withMessage('OTP is required')
        .isLength({ min: 6, max: 6 }).withMessage('OTP must be exactly 6 digits')
        .isNumeric().withMessage('OTP must contain only numbers'),
    handleValidationErrors,
];

/**
 * Password reset validation
 */
export const passwordResetValidation = [
    emailValidator,
    body('otp')
        .trim()
        .notEmpty().withMessage('OTP is required')
        .isLength({ min: 6, max: 6 }).withMessage('OTP must be exactly 6 digits')
        .isNumeric().withMessage('OTP must contain only numbers'),
    body('newPassword')
        .notEmpty().withMessage('New password is required')
        .isLength({ min: 8, max: MAX_LENGTHS.PASSWORD })
        .withMessage('Password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
    handleValidationErrors,
];

/**
 * Search/list validation
 */
export const searchValidation = [
    ...paginationValidators,
    handleValidationErrors,
];

/**
 * Public website lead (contact form) validation.
 *
 * This is the ONLY unauthenticated write in the Phase 1 website surface, so it
 * gets the strictest field-level validation in the file. Three things are
 * deliberate:
 *
 *  1. `website` is a HONEYPOT, not a real field. It is accepted (so the bot
 *     that filled it still gets a 200 and stops retrying) but capped at a
 *     length that cannot be used to smuggle a payload; the controller discards
 *     the whole submission when it is non-empty.
 *  2. `phone` is required and `email` is not — a Vadodara gym enquiry reaches
 *     us by phone; requiring an email would lose real leads. That mirrors
 *     models/Member.js, where email is optional too.
 *  3. Every free-text field runs through sanitizeString, because this copy is
 *     rendered back into an admin panel and into a notification email.
 *
 * NOTE: allowOnlyFields is intentionally NOT layered on top. A 400 for an
 * unexpected field would break the public form the moment the marketing site
 * adds one, and the controller never spreads req.body into the model — it reads
 * named fields only, so an extra field is inert rather than dangerous.
 */
export const createLeadValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('Name is required')
        .isLength({ min: MIN_LENGTHS.NAME, max: MAX_LENGTHS.NAME })
        .withMessage(`Name must be between ${MIN_LENGTHS.NAME} and ${MAX_LENGTHS.NAME} characters`)
        .customSanitizer(sanitizeString),
    body('phone')
        .trim()
        .notEmpty().withMessage('Phone number is required')
        .isLength({ min: 6, max: MAX_LENGTHS.PHONE })
        .withMessage(`Phone number must be between 6 and ${MAX_LENGTHS.PHONE} characters`)
        .matches(/^[+\d\s\-()]+$/).withMessage('Phone number contains invalid characters'),
    body('email')
        .optional({ values: 'falsy' })
        .trim()
        .isEmail().withMessage('Please provide a valid email address')
        .isLength({ max: MAX_LENGTHS.EMAIL }).withMessage(`Email must not exceed ${MAX_LENGTHS.EMAIL} characters`)
        .normalizeEmail(),
    body('message')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: MAX_LENGTHS.MEDIUM_TEXT })
        .withMessage(`Message must not exceed ${MAX_LENGTHS.MEDIUM_TEXT} characters`)
        .customSanitizer(sanitizeString),
    body('source')
        .optional({ values: 'falsy' })
        .trim()
        .isIn(['WEBSITE', 'CONTACT_FORM', 'BOOKING'])
        .withMessage('source must be WEBSITE, CONTACT_FORM or BOOKING'),
    body('branch')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 50 }).withMessage('branch must not exceed 50 characters')
        // Validated for SHAPE only. The real check is against the Branch master
        // in the controller, so opening a third gym never needs this file
        // edited (see models/Branch.js).
        .matches(/^[\w\s-]+$/).withMessage('branch contains invalid characters'),
    body('website')
        .optional({ values: 'null' })
        .isLength({ max: MAX_LENGTHS.SHORT_TEXT })
        .withMessage('Invalid submission'),
    handleValidationErrors,
];

// ============ MIDDLEWARE TO REJECT UNEXPECTED FIELDS ============

/**
 * Create middleware to reject unexpected fields in request body
 * @param {string[]} allowedFields - Array of allowed field names
 * @returns {Function} Express middleware
 */
export const allowOnlyFields = (allowedFields) => {
    return (req, res, next) => {
        if (req.body && typeof req.body === 'object') {
            const bodyFields = Object.keys(req.body);
            const unexpectedFields = bodyFields.filter(field => !allowedFields.includes(field));

            if (unexpectedFields.length > 0) {
                return res.status(400).json({
                    isOk: false,
                    status: 400,
                    error: 'Validation Error',
                    message: 'Unexpected fields in request body',
                    unexpectedFields: unexpectedFields,
                });
            }
        }
        next();
    };
};

// ============ ALLOWED FIELDS FOR ENDPOINTS ============

// Only email and password are read. The consent and client-origin fields are
// still TOLERATED because allowOnlyFields answers 400 with 'Unexpected fields'
// for anything not listed, and a browser holding a stale admin bundle would hit
// that on login - the one flow that must never break. Nothing reads them: the
// consent gate is gone and the login IP/location is no longer recorded. Drop
// them once no deployed client can still be sending them.
export const allowedLoginFields = [
    'email', 'password', 'locationConsent', 'ipConsent',
    'clientIP', 'clientLatitude', 'clientLongitude'
];

export const allowedEmployeeFields = [
    'employeeName', 'departmentId', 'roleId', 'emailOffice',
    'mobileNumber', 'countryId', 'stateId', 'cityId',
    'address', 'password', 'isActive'
];

export const allowedCompanyFields = [
    'companyName', 'email', 'password', 'mobileNumber',
    'gstNumber', 'countryId', 'stateId', 'cityId',
    'address', 'pincode', 'website', 'isActive', 'contactPersonName', 'contactNumber',
    'loginBanner', 'sidebarBgColor', 'addButtonColor', 'removeButtonColor', 'buttonStyle', 'enableSearchMenu'
];

export const allowedSearchFields = [
    'skip', 'per_page', 'sorton', 'sortdir', 'match', 'isActive'
];

export default {
    handleValidationErrors,
    mongoSanitizer,
    loginValidation,
    createEmployeeValidation,
    createCompanyValidation,
    otpValidation,
    passwordResetValidation,
    searchValidation,
    createLeadValidation,
    allowOnlyFields,
    allowedLoginFields,
    allowedEmployeeFields,
    allowedCompanyFields,
    allowedSearchFields,
};
