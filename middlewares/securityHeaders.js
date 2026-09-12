/**
 * Security Headers Middleware
 * Implements OWASP security headers best practices:
 * - Helmet for standard security headers
 * - CORS configuration
 * - Content Security Policy
 * - Additional XSS, Clickjacking protection
 * 
 * OWASP Security Headers:
 * https://owasp.org/www-project-secure-headers/
 */

import helmet from 'helmet';

/**
 * Configure Helmet security headers
 * @returns {Function} Helmet middleware with custom configuration
 */
export const securityHeaders = helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'http:', 'https:'],
            connectSrc: ["'self'", 'http:', 'https:', 'https://api.ipify.org'],
            fontSrc: ["'self'", 'https:', 'data:'],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },

    // X-Content-Type-Options: Prevent MIME type sniffing
    noSniff: true,

    // X-Frame-Options: Prevent clickjacking
    frameguard: {
        action: 'deny',
    },

    // Strict-Transport-Security: Force HTTPS
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
    },

    // X-XSS-Protection: Additional XSS protection
    xssFilter: true,

    // Referrer-Policy: Control referrer information
    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
    },

    // X-Permitted-Cross-Domain-Policies: Prevent Adobe Flash/Acrobat cross-domain
    permittedCrossDomainPolicies: {
        permittedPolicies: 'none',
    },

    // X-Download-Options: Prevent IE from executing downloads
    ieNoOpen: true,

    // X-DNS-Prefetch-Control: Control DNS prefetching
    dnsPrefetchControl: {
        allow: false,
    },

    // Remove X-Powered-By header
    hidePoweredBy: true,
});

/**
 * Additional security headers not covered by Helmet
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const additionalSecurityHeaders = (req, res, next) => {
    // Permissions-Policy: Control browser features
    res.setHeader('Permissions-Policy',
        'accelerometer=(), camera=(), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
    );

    // Cache-Control: Prevent caching of sensitive data
    if (req.path.includes('/auth/') || req.path.includes('/admin/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
};

/**
 * CORS configuration for production
 * @param {string[]} allowedOrigins - Array of allowed origins
 * @returns {Object} CORS configuration object
 */
export const getCorsConfig = (allowedOrigins = []) => {
    const defaultOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:7002',
        'https://demo-test.barodaweb.net.in',
    ];

    // ALLOWED_ORIGINS is passed in by the caller (see server.js), so it is not
    // re-read here.
    //
    // The single-domain deployment serves the admin panel from the SAME host as
    // this API, and browsers send `Origin: <that host>` on every state-changing
    // request even when it is same-origin. Blocking it rejected every admin
    // login. Vercel injects both of these; the production one is stable, the
    // other is the per-deployment URL.
    const selfOrigins = [
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL,
    ]
        .filter(Boolean)
        .map((host) => (host.startsWith('http') ? host : `https://${host}`));

    const origins = new Set([
        ...defaultOrigins,
        ...selfOrigins,
        ...allowedOrigins,
    ]);

    return {
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, curl, etc.)
            if (!origin) return callback(null, true);

            if (origins.has(origin)) {
                return callback(null, true);
            }

            // In development, allow all origins
            if (process.env.NODE_ENV === 'development') {
                return callback(null, true);
            }

            console.warn(`[CORS] Blocked request from origin: ${origin}`);
            return callback(new Error('Not allowed by CORS'), false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
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
        exposedHeaders: [
            'RateLimit-Limit',
            'RateLimit-Remaining',
            'RateLimit-Reset',
            'Retry-After',
        ],
        maxAge: 86400, // Cache preflight for 24 hours
    };
};

/**
 * Request body size limiter middleware
 * Prevents large payload attacks
 * @param {number} limit - Size limit in bytes
 * @returns {Function} Express middleware
 */
export const bodySizeLimit = (limit = 1024 * 1024) => { // Default 1MB
    return (req, res, next) => {
        const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);

        if (contentLength > limit) {
            return res.status(413).json({
                isOk: false,
                status: 413,
                error: 'Payload Too Large',
                message: `Request body exceeds ${limit / 1024}KB limit`,
            });
        }

        next();
    };
};

/**
 * Sanitize error messages to prevent information leakage
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const sanitizeErrors = (err, req, res, next) => {
    // Log the full error for debugging
    console.error('[ERROR]', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
    });

    // Don't expose internal error details in production
    const isProduction = process.env.NODE_ENV === 'production';

    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            isOk: false,
            status: 400,
            error: 'Validation Error',
            message: isProduction ? 'Invalid input data' : err.message,
        });
    }

    if (err.name === 'MongoServerError' && err.code === 11000) {
        return res.status(409).json({
            isOk: false,
            status: 409,
            error: 'Duplicate Entry',
            message: 'A record with this information already exists',
        });
    }

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            isOk: false,
            status: 401,
            error: 'Authentication Error',
            message: 'Invalid or expired token',
        });
    }

    // Generic error response
    res.status(err.status || 500).json({
        isOk: false,
        status: err.status || 500,
        error: isProduction ? 'Internal Server Error' : err.name,
        message: isProduction ? 'An unexpected error occurred' : err.message,
    });
};

export default {
    securityHeaders,
    additionalSecurityHeaders,
    getCorsConfig,
    bodySizeLimit,
    sanitizeErrors,
};
