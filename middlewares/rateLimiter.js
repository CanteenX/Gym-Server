/**
 * Rate Limiting Middleware
 * Implements OWASP best practices for rate limiting to prevent:
 * - Brute force attacks
 * - DDoS attacks
 * - API abuse
 * 
 * Features:
 * - IP-based rate limiting for public endpoints
 * - User-based rate limiting for authenticated endpoints
 * - Separate limits for auth endpoints (stricter)
 * - Graceful 429 responses with retry-after headers
 */

import rateLimit from 'express-rate-limit';

/**
 * Limits are environment-aware.
 *
 * WHY: the production defaults below are deliberately strict — 5 login attempts
 * per 15 minutes is what stops a brute-force run. But a developer working on the
 * admin panel hits those same numbers in minutes: the panel fetches menus,
 * permissions, members, trainers, plans and dashboard stats on every page load,
 * so a 100-request general budget disappears in a handful of navigations and
 * locks the operator out of their own tool.
 *
 * Raising the hardcoded numbers would have weakened production too, so each
 * limit reads from the environment instead, falling back to a generous value in
 * development and the strict one in production. Override any of them in .env
 * (e.g. RATE_LIMIT_AUTH_MAX=20) without touching this file.
 */
const isProduction = process.env.NODE_ENV === 'production';

/** Reads a positive integer from the environment, else the environment default. */
const limitFrom = (envVar, prodDefault, devDefault) => {
    const raw = Number(process.env[envVar]);
    if (Number.isInteger(raw) && raw > 0) return raw;
    return isProduction ? prodDefault : devDefault;
};

/**
 * Get client IP address from request
 * Handles various proxy configurations
 * @param {Object} req - Express request object
 * @returns {string} Client IP address
 */
const getClientIP = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.ip ||
        req.connection?.remoteAddress ||
        'unknown';
};

/**
 * Custom key generator for rate limiting
 * Uses both IP and user ID when available for more precise limiting
 * @param {Object} req - Express request object
 * @returns {string} Rate limit key
 */
const keyGenerator = (req) => {
    const ip = getClientIP(req);
    const userId = req.user?.id || 'anonymous';
    return `${ip}:${userId}`;
};

/**
 * Custom handler for rate limit exceeded
 * Returns OWASP-compliant 429 response with helpful headers
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const rateLimitHandler = (req, res) => {
    const retryAfter = Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000);

    res.set({
        'Retry-After': retryAfter,
        'X-RateLimit-Limit': req.rateLimit.limit,
        'X-RateLimit-Remaining': 0,
        'X-RateLimit-Reset': new Date(req.rateLimit.resetTime).toISOString(),
    });

    return res.status(429).json({
        isOk: false,
        status: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit. Please try again later.',
        retryAfter: retryAfter,
        retryAfterDate: new Date(req.rateLimit.resetTime).toISOString(),
    });
};

/**
 * Skip rate limiting for certain conditions
 * @param {Object} req - Express request object
 * @returns {boolean} Whether to skip rate limiting
 */
const skipIfHealthCheck = (req) => {
    // Skip rate limiting for health check endpoints
    return req.path === '/api' || req.path === '/health';
};

// ============ RATE LIMITERS ============

/**
 * General API Rate Limiter
 * Default: 100 requests per 15 minutes per IP
 * Applied to all API endpoints
 */
export const generalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // 100 in production; 5000 in development, where one admin page load costs
    // a dozen requests.
    max: limitFrom('RATE_LIMIT_GENERAL_MAX', 100, 5000),
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers (use standardHeaders instead)
    keyGenerator: (req) => getClientIP(req),
    handler: rateLimitHandler,
    skip: skipIfHealthCheck,
});

/**
 * Strict Auth Rate Limiter
 * Stricter limits for authentication endpoints to prevent brute force
 * Default: 5 login attempts per 15 minutes per IP
 */
export const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // 5 in production — enough to stop a brute-force run. 100 in development,
    // where logging in and out repeatedly is normal work.
    max: limitFrom('RATE_LIMIT_AUTH_MAX', 5, 100),
    message: 'Too many login attempts from this IP, please try again after 15 minutes',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIP(req),
    handler: (req, res) => {
        const retryAfter = Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000);

        res.set({
            'Retry-After': retryAfter,
            'X-RateLimit-Limit': req.rateLimit.limit,
            'X-RateLimit-Remaining': 0,
            'X-RateLimit-Reset': new Date(req.rateLimit.resetTime).toISOString(),
        });

        return res.status(429).json({
            isOk: false,
            status: 429,
            error: 'Too Many Login Attempts',
            message: 'Too many login attempts. Please wait before trying again.',
            retryAfter: retryAfter,
            retryAfterDate: new Date(req.rateLimit.resetTime).toISOString(),
        });
    },
    /**
     * Successful logins no longer consume the budget.
     *
     * Counting them meant a legitimate operator signing in five times across a
     * working day was locked out for fifteen minutes, while the attack this
     * limiter exists to stop — repeated FAILED guesses — was measured with the
     * same five slots. Only failures count now, which makes the limit strictly
     * better at its actual job.
     */
    skipSuccessfulRequests: true,
});

/**
 * Password Reset Rate Limiter
 * Very strict limits for password reset/OTP endpoints
 * Default: 3 requests per hour per IP
 */
export const passwordResetRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: limitFrom('RATE_LIMIT_PASSWORD_RESET_MAX', 3, 50),
    message: 'Too many password reset requests from this IP, please try again after an hour',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIP(req),
    handler: (req, res) => {
        const retryAfter = Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000);

        return res.status(429).json({
            isOk: false,
            status: 429,
            error: 'Too Many Requests',
            message: 'Too many password reset attempts. Please try again later.',
            retryAfter: retryAfter,
        });
    },
});

/**
 * User-based Rate Limiter (for authenticated routes)
 * Limits requests per user, not just IP
 * Default: 200 requests per 15 minutes per user
 */
export const userRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: limitFrom('RATE_LIMIT_USER_MAX', 200, 5000),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyGenerator, // Uses IP:userId combination
    handler: rateLimitHandler,
});

/**
 * Search/Heavy Operations Rate Limiter
 * For endpoints that perform heavy database operations
 * Default: 30 requests per minute per IP
 */
export const searchRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: limitFrom('RATE_LIMIT_SEARCH_MAX', 30, 600),
    message: 'Too many search requests, please slow down',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIP(req),
    handler: rateLimitHandler,
});

/**
 * File Upload Rate Limiter
 * Limits file uploads to prevent abuse
 * Default: 10 uploads per hour per IP
 */
export const uploadRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: limitFrom('RATE_LIMIT_UPLOAD_MAX', 10, 500),
    message: 'Too many file uploads, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIP(req),
    handler: rateLimitHandler,
});

export default {
    generalRateLimiter,
    authRateLimiter,
    passwordResetRateLimiter,
    userRateLimiter,
    searchRateLimiter,
    uploadRateLimiter,
};
