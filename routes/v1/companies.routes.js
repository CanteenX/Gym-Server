import express from "express";
import {
  createCompanyMaster,
  updateCompanyMaster,
  loginCompany,
  getCurrentUserDetails,
  getAdminList,
  getPublicCompanyDetails,
  deleteCompanyMaster,
  getCompanyById,
} from "../../controllers/v1/company.controller.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin.js";
// ============ SECURITY IMPORTS ============
import { authRateLimiter, uploadRateLimiter } from "../../middlewares/rateLimiter.js";
import {
  loginValidation,
  createCompanyValidation,
  allowOnlyFields,
  allowedLoginFields,
  allowedCompanyFields
} from "../../middlewares/inputValidator.js";
import { createSecureMultiUpload } from "../../middlewares/secureUpload.js";
import { ensureLocalDir } from "../../config/runtime.js";

const router = express.Router();

// ============ SECURE FILE UPLOAD CONFIGURATION ============
const logoUploadFolder = "uploads/companyMaster";

// No-op on the read-only serverless filesystem; uploads go to Blob there.
ensureLocalDir(logoUploadFolder);

/**
 * Secure upload middleware for company logo and favicon
 * Features:
 * - Magic byte validation (file-type library)
 * - Double extension attack prevention
 * - WebP compression for smaller file sizes
 * - UUID-based secure filenames
 * - File size limits (5MB per file)
 */
const secureCompanyUpload = createSecureMultiUpload({
  destination: logoUploadFolder,
  fields: [
    { name: 'logo', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
    { name: 'loginBanner', maxCount: 1 },
  ],
  maxSize: 5 * 1024 * 1024, // 5MB
  compress: true,
  quality: 85,
});

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Create a new company
 *     tags: [Companies]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               companyName:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               phone:
 *                 type: string
 *               address:
 *                 type: string
 *               logo:
 *                 type: string
 *                 format: binary
 *               favicon:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Company created successfully
 *       400:
 *         description: Validation error or invalid file type
 *       429:
 *         description: Upload rate limit exceeded
 */
// SECURITY: Rate limit + secure upload with validation
router.post(
  "/companies",
  authMiddleware(["ADMIN"]),
  requireSuperAdmin,
  uploadRateLimiter,       // Rate limit uploads (10/hour)
  secureCompanyUpload,      // Secure file validation & compression (parses multipart fields)
  allowOnlyFields(allowedCompanyFields),
  createCompanyValidation,
  createCompanyMaster,
);

router.get(                                // ← new route
  "/companies",
  authMiddleware(["ADMIN"]),
  requireSuperAdmin,
  getAdminList,
);

/**
 * @swagger
 * /companies/{id}:
 *   put:
 *     summary: Update company
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Company ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               companyName:
 *                 type: string
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               address:
 *                 type: string
 *               logo:
 *                 type: string
 *                 format: binary
 *               favicon:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Company updated successfully
 *       404:
 *         description: Company not found
 *       400:
 *         description: Validation error or invalid file type
 */
// Public endpoint for company logo & favicon (to display on Login Page before logging in)
router.get("/companies/public", getPublicCompanyDetails);

// SECURITY: Auth + rate limit + secure upload
router.put(
  "/companies/:id",
  authMiddleware(["ADMIN"]),
  /**
   * The same allowlist POST uses. Without it the handler's updateFields
   * loop is the only thing deciding what a body may set, and anything
   * added to that list later becomes writable here silently.
   */
  allowOnlyFields(allowedCompanyFields),
  /**
   * requireSuperAdmin, and it was the ONLY company route without it —
   * POST, DELETE and GET all carried it.
   *
   * updateCompanyMaster re-hashes req.body.password onto the row and
   * accepts isActive, and it never checked whose row :id names. So any
   * CompanyMaster login could POST a new password onto the super admin's
   * record and take the system over, or set isActive:false and lock
   * everyone out permanently — findUserByEmail filters on isActive.
   * An active takeover path, not merely a lockout.
   */
  requireSuperAdmin,
  uploadRateLimiter,         // Rate limit uploads
  secureCompanyUpload,       // Secure file validation & compression
  updateCompanyMaster,
);

/**
 * @swagger
 * /companies/getCompanyDetails:
 *   get:
 *     summary: Get current user details using session
 *     tags: [Companies]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Current user details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Unauthorized - session invalid
 *       404:
 *         description: User not found
 */
/**
 * Deliberately NOT behind checkPermission("/company-details", "read").
 *
 * Despite the path, this returns the CURRENT USER — AuthContext calls it on
 * every page load via getCurrentUserDetails() to populate adminData. Gating it
 * on the "Company Details" menu meant any role without that screen (a Branch
 * Admin, by design) got a 403; AuthContext treats 401/403 as a dead session,
 * cleared its state and redirected to login. The sidebar never rendered,
 * because the app had already thrown itself out before MenuContext ran.
 *
 * Reading your own identity is not a privileged act. authMiddleware still
 * applies, and every company-WRITE route above keeps its permission gate.
 */
router.get(
  "/companies/getCompanyDetails",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getCurrentUserDetails,
);

/**
 * @swagger
 * /auth/company/login:
 *   post:
 *     summary: Company/Admin login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many login attempts
 */
// SECURITY: Rate limit + field whitelist + input validation on login
router.post(
  "/auth/company/login",
  authRateLimiter,                          // Strict rate limiting (5 attempts/15 min)
  allowOnlyFields(allowedLoginFields),      // Reject unexpected fields
  loginValidation,                          // Validate & sanitize input
  loginCompany
);

router.delete(
  "/companies/:id",
  authMiddleware(["ADMIN"]),
  requireSuperAdmin,
  deleteCompanyMaster
);

router.get(
  "/companies/:id",
  authMiddleware(["ADMIN"]),
  requireSuperAdmin,
  getCompanyById
);

export default router;
