# Security Implementation Guide

This document outlines the security measures implemented in the Demo-Admin application following OWASP best practices.

## Table of Contents
1. [Rate Limiting](#rate-limiting)
2. [Input Validation & Sanitization](#input-validation--sanitization)
3. [Security Headers](#security-headers)
4. [Secure File Uploads](#secure-file-uploads)
5. [API Key & Secret Management](#api-key--secret-management)
6. [Authentication Security](#authentication-security)
7. [Security Checklist](#security-checklist)

---

## Rate Limiting

Rate limiting prevents abuse, brute force attacks, and DDoS attacks by limiting the number of requests from a single source.

### Implemented Rate Limiters

| Limiter | Window | Max Requests | Description |
|---------|--------|--------------|-------------|
| General API | 15 min | 100 | Default for all endpoints |
| Auth (Login) | 15 min | 5 | Strict limit for login attempts |
| Password Reset | 1 hour | 3 | Very strict for security-sensitive operations |
| Search/Heavy | 1 min | 30 | For database-intensive operations |
| File Upload | 1 hour | 10 | Prevents upload abuse |

### Response Format (429 Too Many Requests)
```json
{
  "isOk": false,
  "status": 429,
  "error": "Too Many Requests",
  "message": "You have exceeded the rate limit. Please try again later.",
  "retryAfter": 300,
  "retryAfterDate": "2024-01-05T10:00:00.000Z"
}
```

---

## Input Validation & Sanitization

All user inputs are validated and sanitized to prevent injection attacks and ensure data integrity.

### Validation Features

1. **Schema-Based Validation**: Using `express-validator` for declarative validation
2. **Type Checking**: All inputs are type-verified
3. **Length Limits**: Enforced on all string fields
4. **Field Whitelisting**: Unexpected fields are rejected
5. **NoSQL Injection Prevention**: Using `express-mongo-sanitize`
6. **HPP Protection**: HTTP Parameter Pollution prevention using `hpp`

### Field Limits

| Field Type | Min Length | Max Length |
|------------|------------|------------|
| Email | - | 254 (RFC 5321) |
| Password | 6 | 128 |
| Name | 1 | 100 |
| Short Text | - | 255 |
| Phone | - | 20 |

---

## Security Headers

Security headers are implemented using Helmet.js:

| Header | Purpose |
|--------|---------|
| `Content-Security-Policy` | Prevents XSS and data injection |
| `X-Content-Type-Options` | Prevents MIME type sniffing |
| `X-Frame-Options` | Prevents clickjacking |
| `Strict-Transport-Security` | Forces HTTPS |
| `Referrer-Policy` | Controls referrer information |

---

## Secure File Uploads

File uploads are secured with multiple layers of protection following OWASP File Upload Cheat Sheet.

### Security Features

| Feature | Description |
|---------|-------------|
| **Magic Byte Validation** | Verifies actual file content using `file-type` library |
| **Double Extension Prevention** | Blocks files like `image.jpg.php` |
| **MIME Type Validation** | Validates client-reported MIME types |
| **Secure Filenames** | UUID-based random filenames prevent path traversal |
| **File Size Limits** | Configurable per endpoint (default 5MB) |
| **Image Compression** | Automatic WebP conversion reduces file sizes |
| **Rate Limiting** | 10 uploads per hour per IP |

### Blocked Extensions
```
.php, .php\d, .phtml, .exe, .sh, .bash, .pl, .py, .js, .jsp, 
.asp, .aspx, .bat, .cmd, .vbs, .wsf, .cgi, .com, .dll, .msi, .scr
```

### Upload Process Flow
```
1. Rate limit check (10/hour)
2. File size validation
3. Extension whitelist check
4. MIME type validation
5. Double extension attack detection
6. Magic byte verification (file signature)
7. Image compression to WebP (optional)
8. UUID filename generation
9. Secure file storage
```

### Middleware Usage
```javascript
import { createSecureImageUpload, createSecureDocumentUpload } from './middlewares/secureUpload.js';

// For image uploads (with compression)
const imageUpload = createSecureImageUpload({
  destination: 'uploads/images',
  fieldName: 'image',
  maxSize: 5 * 1024 * 1024, // 5MB
  compress: true,
  quality: 85,
});

// For document uploads (PDF)
const docUpload = createSecureDocumentUpload({
  destination: 'uploads/documents',
  fieldName: 'document',
  maxSize: 10 * 1024 * 1024, // 10MB
});
```

---

## API Key & Secret Management

### Best Practices

1. **Environment Variables**: All secrets stored in `.env` file
2. **Never Committed**: `.env` is in `.gitignore`
3. **Template Provided**: `.env.example` shows required variables
4. **Strong Secrets**: JWT keys are 256+ characters

### Generating Strong Secrets
```bash
node -e "console.log(require('crypto').randomBytes(256).toString('base64'))"
```

---

## Authentication Security

### Login Protection

1. **Rate Limiting**: 5 attempts per 15 minutes per IP
2. **Account Lockout**: After 3 failed attempts (24-hour lockout)
3. **Input Validation**: Email and password validated
4. **Field Whitelisting**: Only expected fields accepted

### Password Requirements

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number

---

## Security Checklist

### Before Deployment

- [ ] Set `NODE_ENV=production`
- [ ] Use strong, unique JWT secrets
- [ ] Configure allowed CORS origins
- [ ] Verify `.env` is not committed
- [ ] Enable HTTPS/TLS
- [ ] Review rate limit settings
- [ ] Disable Swagger in production

### Regular Maintenance

- [ ] Rotate JWT secrets (every 3-6 months)
- [ ] Review and update dependencies
- [ ] Audit login attempt logs
- [ ] Check error logs for anomalies

---

## File Locations

| File | Purpose |
|------|---------|
| `middlewares/rateLimiter.js` | Rate limiting configuration |
| `middlewares/inputValidator.js` | Input validation rules |
| `middlewares/securityHeaders.js` | Security headers setup |
| `middlewares/secureUpload.js` | Secure file upload middleware |
| `config/security.config.js` | Centralized security settings |
| `.env.example` | Environment variable template |

---

## References

- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
