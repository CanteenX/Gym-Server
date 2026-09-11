import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createEmailSetup,
  updateEmailSetup,
  getEmailSetupById,
  listAllEmailSetup,
  deleteEmailSetup,
  listEmailSetupByParams,
} from "../../controllers/v1/emailSetup.controller.js";
import {
  createEmailFor,
  updateEmailFor,
  getEmailForById,
  listAllEmailFor,
  deleteEmailFor,
  listEmailForByParams,
} from "../../controllers/v1/emailFor.controller.js";
import {
  createEmailTemplate,
  updateEmailTemplate,
  getEmailTemplateById,
  deleteEmailTemplate,
  listEmailTemplateByParams,
  listAllEmailTemplates,
} from "../../controllers/v1/emailTemplate.controller.js";
import {
  createEmailTo,
  updateEmailTo,
  getEmailToById,
  listAllEmailTo,
  deleteEmailTo,
  listEmailToByParams,
} from "../../controllers/v1/emailTo.controller.js";
import fs from "node:fs";
// ============ SECURITY IMPORTS ============
import { uploadRateLimiter } from "../../middlewares/rateLimiter.js";
import { createSecureImageUpload } from "../../middlewares/secureUpload.js";

const router = express.Router();

// ============ SECURE FILE UPLOAD CONFIGURATION ============
const descriptionUploadDir = "uploads/cms/email-template/signature";

// Ensure upload directory exists
if (!fs.existsSync(descriptionUploadDir)) {
  fs.mkdirSync(descriptionUploadDir, { recursive: true });
}

/**
 * Secure upload middleware for signature images
 * Features:
 * - Magic byte validation (file-type library)
 * - Double extension attack prevention
 * - WebP compression for smaller file sizes
 * - UUID-based secure filenames
 * - File size limits (2MB)
 */
const secureSignatureUpload = createSecureImageUpload({
  destination: descriptionUploadDir,
  fieldName: 'signatureImage',
  maxSize: 2 * 1024 * 1024, // 2MB
  compress: true,
  quality: 85,
});

// ============ EMAIL SETUP ENDPOINTS ============

/**
 * @swagger
 * /email-setups:
 *   post:
 *     summary: Create a new email setup
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailSetup'
 *     responses:
 *       200:
 *         description: Email setup created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.post(
  "/email-setups",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "write"),
  createEmailSetup,
);

/**
 * @swagger
 * /email-setups:
 *   get:
 *     summary: Get all email setups
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of email setups
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.get(
  "/email-setups",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  listAllEmailSetup,
);

/**
 * @swagger
 * /email-setups/{emailSetupId}:
 *   get:
 *     summary: Get email setup by ID
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailSetupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email setup ID
 *     responses:
 *       200:
 *         description: Email setup details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Email setup not found
 */
router.get(
  "/email-setups/:emailSetupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  getEmailSetupById,
);

/**
 * @swagger
 * /email-setups/{emailSetupId}:
 *   put:
 *     summary: Update email setup
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailSetupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email setup ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailSetup'
 *     responses:
 *       200:
 *         description: Email setup updated successfully
 *       404:
 *         description: Email setup not found
 */
router.put(
  "/email-setups/:emailSetupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "edit"),
  updateEmailSetup,
);

/**
 * @swagger
 * /email-setups/{emailSetupId}:
 *   delete:
 *     summary: Delete email setup
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailSetupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email setup ID
 *     responses:
 *       200:
 *         description: Email setup deleted successfully
 *       404:
 *         description: Email setup not found
 */
router.delete(
  "/email-setups/:emailSetupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "delete"),
  deleteEmailSetup,
);

/**
 * @swagger
 * /email-setups/search:
 *   post:
 *     summary: Search email setups
 *     tags: [Email Setup]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SearchRequest'
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/email-setups/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  listEmailSetupByParams,
);

// ============ EMAIL FOR ENDPOINTS ============

/**
 * @swagger
 * /email-for:
 *   post:
 *     summary: Create a new email for entry
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailFor'
 *     responses:
 *       200:
 *         description: Email for created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.post(
  "/email-for",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "write"),
  createEmailFor,
);

/**
 * @swagger
 * /email-for:
 *   get:
 *     summary: Get all email for entries
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of email for entries
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.get(
  "/email-for",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "read"),
  listAllEmailFor,
);

/**
 * @swagger
 * /email-for/{emailForId}:
 *   get:
 *     summary: Get email for by ID
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailForId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email for ID
 *     responses:
 *       200:
 *         description: Email for details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Email for not found
 */
router.get(
  "/email-for/:emailForId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "read"),
  getEmailForById,
);

/**
 * @swagger
 * /email-for/{emailForId}:
 *   put:
 *     summary: Update email for
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailForId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email for ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailFor'
 *     responses:
 *       200:
 *         description: Email for updated successfully
 *       404:
 *         description: Email for not found
 */
router.put(
  "/email-for/:emailForId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "edit"),
  updateEmailFor,
);

/**
 * @swagger
 * /email-for/{emailForId}:
 *   delete:
 *     summary: Delete email for
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailForId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email for ID
 *     responses:
 *       200:
 *         description: Email for deleted successfully
 *       404:
 *         description: Email for not found
 */
router.delete(
  "/email-for/:emailForId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "delete"),
  deleteEmailFor,
);

/**
 * @swagger
 * /email-for/search:
 *   post:
 *     summary: Search email for entries
 *     tags: [Email For]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SearchRequest'
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/email-for/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-for", "read"),
  listEmailForByParams,
);

// ============ EMAIL TO ENDPOINTS ============

router.post(
  "/email-to",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "write"),
  createEmailTo,
);

router.get(
  "/email-to",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  listAllEmailTo,
);

router.get(
  "/email-to/:emailToId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  getEmailToById,
);

router.put(
  "/email-to/:emailToId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "edit"),
  updateEmailTo,
);

router.delete(
  "/email-to/:emailToId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "delete"),
  deleteEmailTo,
);

router.post(
  "/email-to/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-setup", "read"),
  listEmailToByParams,
);

// ============ EMAIL TEMPLATE ENDPOINTS ============

/**
 * @swagger
 * /email-templates:
 *   post:
 *     summary: Create a new email template
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailTemplate'
 *     responses:
 *       200:
 *         description: Email template created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.post(
  "/email-templates",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "write"),
  createEmailTemplate,
);

/**
 * @swagger
 * /email-templates:
 *   get:
 *     summary: Get all email templates
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of email templates
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.get(
  "/email-templates",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "read"),
  listAllEmailTemplates,
);

/**
 * @swagger
 * /email-templates/{emailTemplateId}:
 *   get:
 *     summary: Get email template by ID
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailTemplateId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email template ID
 *     responses:
 *       200:
 *         description: Email template details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Email template not found
 */
router.get(
  "/email-templates/:emailTemplateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "read"),
  getEmailTemplateById,
);

/**
 * @swagger
 * /email-templates/{emailTemplateId}:
 *   put:
 *     summary: Update email template
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailTemplateId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email template ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailTemplate'
 *     responses:
 *       200:
 *         description: Email template updated successfully
 *       404:
 *         description: Email template not found
 */
router.put(
  "/email-templates/:emailTemplateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "edit"),
  updateEmailTemplate,
);

/**
 * @swagger
 * /email-templates/{emailTemplateId}:
 *   delete:
 *     summary: Delete email template
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: emailTemplateId
 *         required: true
 *         schema:
 *           type: string
 *         description: Email template ID
 *     responses:
 *       200:
 *         description: Email template deleted successfully
 *       404:
 *         description: Email template not found
 */
router.delete(
  "/email-templates/:emailTemplateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "delete"),
  deleteEmailTemplate,
);

/**
 * @swagger
 * /email-templates/search:
 *   post:
 *     summary: Search email templates
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SearchRequest'
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/email-templates/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "read"),
  listEmailTemplateByParams,
);

/**
 * @swagger
 * /email-templates/upload-signature:
 *   post:
 *     summary: Upload signature image for email template
 *     tags: [Email Templates]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               signatureImage:
 *                 type: string
 *                 format: binary
 *                 description: Signature image file (jpeg, jpg, png)
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isOk:
 *                   type: boolean
 *                 uploaded:
 *                   type: integer
 *                 url:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     link:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: No file uploaded or validation failed
 *       429:
 *         description: Upload rate limit exceeded
 */
// SECURITY: Auth + rate limit + secure upload with validation
router.post(
  "/email-templates/upload-signature",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/email-template", "write"),
  uploadRateLimiter,          // Rate limit uploads (10/hour)
  secureSignatureUpload,      // Secure file validation & compression
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        isOk: false,
        message: "No file uploaded",
      });
    }

    const imageUrl = `${process.env.REACT_APP_API_URL}/uploads/cms/email-template/signature/${req.file.filename}`;

    return res.status(200).json({
      isOk: true,
      uploaded: 1,
      url: imageUrl,
      data: {
        link: imageUrl,
      },
      message: "Signature image uploaded and compressed successfully",
      originalSize: req.file.originalSize,
      compressedSize: req.file.size,
      compressionRatio: req.file.compressionRatio,
    });
  },
);

export default router;
