import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import { authRateLimiter, uploadRateLimiter } from "../../middlewares/rateLimiter.js";
import { createLeadValidation } from "../../middlewares/inputValidator.js";
import { createSecureImageUpload } from "../../middlewares/secureUpload.js";
import { ensureLocalDir } from "../../config/runtime.js";
import {
  getPublicSiteContent,
  listSiteContentByParams,
  createSiteContent,
  updateSiteContent,
  uploadSiteContentImage,
  deleteSiteContent,
} from "../../controllers/v1/siteContent.controller.js";
import {
  getPublicAds,
  listAdsByParams,
  createAd,
  updateAd,
  deleteAd,
} from "../../controllers/v1/advertisement.controller.js";
import {
  createPublicLead,
  listLeadsByParams,
  updateLead,
} from "../../controllers/v1/lead.controller.js";

const router = express.Router();

/**
 * Public website surface: editable marketing copy (SiteContent), banner adverts
 * (Advertisement) and inbound enquiries (Lead).
 *
 * Three collections share one route file because they share one URL namespace
 * (/site/...) and one admin area ("Website"), the same way emails.routes.js
 * carries four email masters. Mounted flat under /api/v1 like every other route
 * file — paths are written in full here, not derived from a router prefix.
 *
 * SECURITY SHAPE, and it is not uniform across this file:
 *
 *   - THREE endpoints are public and unauthenticated by design — the two reads
 *     the marketing site renders from, and the contact form POST. They are the
 *     only unauthenticated endpoints here and each is commented individually.
 *   - EVERY write is behind a staff session AND checkPermission. Unlike the
 *     older gym routes (members/trainers/transactions), checkPermission IS
 *     applied here, because the three MenuMaster rows it resolves are seeded by
 *     scripts/seedWebsiteMenus.js. Run that seed before deploying, or every
 *     admin write 403s with "Menu '/website-pages' not found".
 */

// ============ SECURE FILE UPLOAD CONFIGURATION ============
const advertUploadDir = "uploads/cms/adverts";

// No-op on the read-only serverless filesystem; uploads go to Blob there.
ensureLocalDir(advertUploadDir);

/**
 * ONE multer instance for the advert creative, used on both create and update.
 *
 * It must stay a single instance per route: multer consumes the multipart
 * stream, so chaining a second uploader on the same route leaves the second one
 * reading an already-drained body and silently seeing no file (documented in
 * routes/v1/members.routes.js).
 *
 * Compression is ON and safe here, unlike the member ID-proof uploader: this
 * field accepts images only (ALLOWED_MIMES.images), never a PDF, so the shared
 * WebP conversion cannot corrupt anything.
 */
const secureAdvertUpload = createSecureImageUpload({
  destination: advertUploadDir,
  fieldName: "image",
  maxSize: 5 * 1024 * 1024, // 5MB — banner creatives, not photography originals
  compress: true,
  quality: 85,
});

const contentImageUploadDir = "uploads/cms/site-content";
ensureLocalDir(contentImageUploadDir);

/**
 * A SECOND instance, for a different destination folder — and it is only safe
 * because the two never appear on the same route. One multer per route is the
 * rule (it drains the multipart stream); one multer per folder is fine.
 */
const secureContentImageUpload = createSecureImageUpload({
  destination: contentImageUploadDir,
  fieldName: "image",
  maxSize: 5 * 1024 * 1024,
  compress: true,
  quality: 85,
});

// ============ PUBLIC ENDPOINTS (NO AUTH — DELIBERATE) ============

/**
 * @swagger
 * /site/content:
 *   get:
 *     summary: Public marketing copy for the website (active blocks only)
 *     tags: [Website]
 *     parameters:
 *       - in: query
 *         name: pageKey
 *         schema:
 *           type: string
 *         description: e.g. home, about, programs, contact
 *     responses:
 *       200:
 *         description: Active site content blocks, sorted by sortOrder
 */
// PUBLIC: this is the copy printed on midcitygym.in. Requiring auth would mean
// the marketing site could not render. Only isActive rows are returned.
router.get("/site/content", getPublicSiteContent);

/**
 * @swagger
 * /site/ads:
 *   get:
 *     summary: Currently-live adverts for the public website
 *     tags: [Website]
 *     parameters:
 *       - in: query
 *         name: placement
 *         schema:
 *           type: string
 *           enum: [HOME_HERO, HOME_MID, SIDEBAR, FOOTER]
 *     responses:
 *       200:
 *         description: Adverts that are active and inside their date window
 */
// PUBLIC: same reasoning. Scheduled and expired adverts are filtered out in the
// controller so an ISR-cached page can never keep serving one.
router.get("/site/ads", getPublicAds);

/**
 * @swagger
 * /site/leads:
 *   post:
 *     summary: Submit a website enquiry (public contact form)
 *     tags: [Website]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, phone]
 *             properties:
 *               name: { type: string }
 *               phone: { type: string }
 *               email: { type: string, format: email }
 *               message: { type: string }
 *               source: { type: string, enum: [WEBSITE, CONTACT_FORM, BOOKING] }
 *               branch: { type: string }
 *               website: { type: string, description: "Honeypot — must be empty" }
 *     responses:
 *       201:
 *         description: Enquiry received
 *       400:
 *         description: Validation error
 *       429:
 *         description: Rate limited
 */
/**
 * PUBLIC WRITE — the only one in this file, and the only endpoint here that an
 * anonymous caller can use to create a row. Three layers guard it:
 *
 *   1. authRateLimiter — the strictest limiter available (5/15min in
 *      production), because an unauthenticated INSERT is exactly the shape of
 *      endpoint that fills a database overnight. Note its
 *      `skipSuccessfulRequests: true` means a genuine visitor who submits once
 *      does not consume budget, while a script that trips validation does.
 *   2. createLeadValidation — per-field type, length and charset checks, plus
 *      sanitisation, since this text is re-rendered in the admin panel and in a
 *      notification email.
 *   3. The `website` honeypot, enforced in the controller.
 */
router.post("/site/leads", authRateLimiter, createLeadValidation, createPublicLead);

// ============ ADMIN — SITE CONTENT (/website-pages) ============

router.post(
  "/site/content-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-pages", "read"),
  listSiteContentByParams,
);
router.post(
  "/site/content",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-pages", "write"),
  createSiteContent,
);
router.put(
  "/site/content/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-pages", "edit"),
  updateSiteContent,
);
/**
 * ADDITIVE to the Phase 1 contract, which gave content no upload endpoint and
 * left imageUrl as free text. Free text still works unchanged — this is the
 * option, not the replacement. Auth and permission run before the uploader, as
 * everywhere else, so multer never writes bytes for a request that will 401.
 */
router.post(
  "/site/content/:id/image",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-pages", "edit"),
  uploadRateLimiter,
  secureContentImageUpload,
  uploadSiteContentImage,
);
router.delete(
  "/site/content/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-pages", "delete"),
  deleteSiteContent,
);

// ============ ADMIN — ADVERTS (/website-adverts) ============

router.post(
  "/site/ads-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-adverts", "read"),
  listAdsByParams,
);
// Auth and permission run BEFORE the uploader on purpose: multer writes bytes
// (to disk or Blob) as soon as it runs, so an unauthenticated request must be
// rejected while it is still just headers.
router.post(
  "/site/ads",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-adverts", "write"),
  uploadRateLimiter,
  secureAdvertUpload,
  createAd,
);
router.put(
  "/site/ads/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-adverts", "edit"),
  uploadRateLimiter,
  secureAdvertUpload,
  updateAd,
);
router.delete(
  "/site/ads/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-adverts", "delete"),
  deleteAd,
);

// ============ ADMIN — LEADS (/website-leads) ============

router.post(
  "/site/leads-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-leads", "read"),
  listLeadsByParams,
);
router.put(
  "/site/leads/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/website-leads", "edit"),
  updateLead,
);

export default router;
