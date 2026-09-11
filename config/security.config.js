/**
 * Security Configuration
 * Centralized security settings for the application
 * All security-related configuration should be defined here
 * 
 * OWASP References:
 * - https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
 * - https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
 */

import dotenv from 'dotenv';
dotenv.config();

// ============ ENVIRONMENT DETECTION ============
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// ============ RATE LIMITING CONFIGURATION ============
export const rateLimitConfig = {
    // General API rate limit
    general: {
        windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
        maxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    },

    // Authentication endpoints (stricter)
    auth: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 5, // 5 attempts
    },

    // Password reset (very strict)
    passwordReset: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 3,
    },

    // Search/heavy operations
    search: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 30,
    },

    // File uploads
    upload: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 10,
    },
};

// ============ CORS CONFIGURATION ============
export const corsConfig = {
    // Allowed origins - expand this list for production
    allowedOrigins: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:7002',
        ...(process.env.ALLOWED_ORIGINS?.split(',') || []),
    ].filter(Boolean),

    // Allowed methods
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],

    // Allowed headers
    allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'X-Client-IP',
        'X-Client-Latitude',
        'X-Client-Longitude',
    ],

    // Credentials
    credentials: true,

    // Preflight cache duration
    maxAge: 86400, // 24 hours
};

// ============ JWT CONFIGURATION ============
export const jwtConfig = {
    // Token expiry
    expiresIn: process.env.JWT_EXPIRY || '7d',

    // Algorithm
    algorithm: 'HS256',

    // Issuer (for token validation)
    issuer: 'demo-admin-api',

    // Audience
    audience: 'demo-admin-client',
};

// ============ PASSWORD POLICY ============
export const passwordPolicy = {
    minLength: 8,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: false, // Set to true for stricter policy

    // Regex for validation
    get regex() {
        let pattern = `^`;
        if (this.requireLowercase) pattern += `(?=.*[a-z])`;
        if (this.requireUppercase) pattern += `(?=.*[A-Z])`;
        if (this.requireNumbers) pattern += String.raw`(?=.*\d)`;
        if (this.requireSpecialChars) pattern += `(?=.*[@$!%*?&])`;
        pattern += `.{${this.minLength},${this.maxLength}}$`;
        return new RegExp(pattern);
    },
};

// ============ INPUT VALIDATION LIMITS ============
export const inputLimits = {
    email: { max: 254 }, // RFC 5321
    password: { min: 6, max: 128 },
    name: { min: 1, max: 100 },
    shortText: { max: 255 },
    mediumText: { max: 1000 },
    longText: { max: 5000 },
    phone: { max: 20 },
    url: { max: 2048 },
    mongoId: { exact: 24 },
    ipAddress: { max: 45 }, // IPv6
};

// ============ REQUEST SIZE LIMITS ============
export const requestLimits = {
    // JSON body size limit
    jsonLimit: '10mb',

    // URL-encoded body size limit
    urlEncodedLimit: '10mb',

    // File upload size limit
    fileUploadLimit: 10 * 1024 * 1024, // 10MB

    // Parameter count limit (prevents HPP)
    parameterLimit: 100,
};

// ============ SECURITY HEADERS ============
export const securityHeadersConfig = {
    // Content Security Policy
    csp: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://api.ipify.org'],
            fontSrc: ["'self'", 'https:', 'data:'],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
        },
    },

    // HSTS settings
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
    },
};

// ============ LOGIN ATTEMPT SETTINGS ============
export const loginAttemptConfig = {
    // Max failed attempts before lockout
    maxAttempts: 3,

    // Lockout duration in milliseconds
    lockoutDuration: 24 * 60 * 60 * 1000, // 24 hours

    // Reset attempts after successful login
    resetOnSuccess: true,
};

// ============ SESSION/TOKEN BLACKLIST ============
// For token revocation (implement if needed)
export const tokenBlacklistConfig = {
    enabled: false, // Enable this for logout/revocation support
    storage: 'memory', // 'memory' or 'redis'
    ttl: 7 * 24 * 60 * 60, // 7 days (match JWT expiry)
};

// ============ AUDIT LOGGING ============
export const auditConfig = {
    // Log authentication events
    logAuthEvents: true,

    // Log admin actions
    logAdminActions: true,

    // Log failed requests
    logFailedRequests: true,

    // Fields to redact from logs
    redactedFields: ['password', 'token', 'secret', 'authorization'],
};

// ============ FEATURE FLAGS ============
export const securityFeatures = {
    // Enable rate limiting
    rateLimiting: true,

    // Enable input validation
    inputValidation: true,

    // Enable security headers
    securityHeaders: true,

    // Enable MongoDB NoSQL injection protection
    mongoSanitization: true,

    // Enable HTTP Parameter Pollution protection
    hppProtection: true,

    // Enable Swagger docs (disable in production)
    swaggerDocs: !isProduction,

    // Enable debug mode (disable in production)
    debugMode: isDevelopment,
};

export default {
    rateLimitConfig,
    corsConfig,
    jwtConfig,
    passwordPolicy,
    inputLimits,
    requestLimits,
    securityHeadersConfig,
    loginAttemptConfig,
    tokenBlacklistConfig,
    auditConfig,
    securityFeatures,
    isProduction,
    isDevelopment,
};
