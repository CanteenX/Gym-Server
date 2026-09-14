import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  cmsPermission,
  siteContentListTargets,
  siteContentCreateTargets,
  siteContentDocTargets,
  siteItemListTargets,
  siteItemCreateTargets,
  siteItemDocTargets,
  siteNoticeListTargets,
  siteNoticeCreateTargets,
  siteNoticeDocTargets,
} from "../../middlewares/cmsPermission.js";
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
  getPublicNotices,
  listSiteNoticesByParams,
  createSiteNotice,
  updateSiteNotice,
  uploadSiteNoticeImage,
  deleteSiteNotice,
} from "../../controllers/v1/siteNotice.controller.js";
import {
  createPublicLead,
  listLeadsByParams,
  updateLead,
} from "../../controllers/v1/lead.controller.js";
import {
  getPublicSeoMeta,
  listSeoByParams,
  createSeoMeta,
  updateSeoMeta,
  deleteSeoMeta,
} from "../../controllers/v1/seoMeta.controller.js";
import {
  getPublicSiteItems,
  listSiteItemsByParams,
  createSiteItem,
  updateSiteItem,
  uploadSiteItemImage,
  deleteSiteItem,
} from "../../controllers/v1/siteItem.controller.js";

const router = express.Router();

/**
 * Public website surface: editable marketing copy (SiteContent), repeating
 * structured records (SiteItem), announcements and promotional banners
 * (SiteNotice), third-party adverts (Advertisement), inbound enquiries (Lead)
 * and per-route SEO metadata (SeoMeta).
 *
 * SiteNotice IS NOT Advertisement, and the distinction is the reason it exists:
 * an advert is a paying third party and renders under a "Sponsored" heading; an
 * announcement is the gym telling its own members the place is shut on
 * Thursday; a banner is the gym promoting itself. The owner once posted a
 * holiday closure as an advert, and the site dutifully labelled the closure
 * "Sponsored". Right pipeline, wrong vehicle.
 *
 * Six collections share one route file because they share one URL namespace
 * (/site/...) and one admin area ("Website"), the same way emails.routes.js
 * carries four email masters. Mounted flat under /api/v1 like every other route
 * file — paths are written in full here, not derived from a router prefix.
 *
 * SECURITY SHAPE, and it is not uniform across this file:
 *
 *   - SIX endpoints are public and unauthenticated by design — the five reads
 *     the marketing site renders from (copy, list items, notices, adverts, SEO
 *     metadata), and the contact form POST. They are the only unauthenticated
 *     endpoints here and each is commented individually.
 *   - EVERY write is behind a staff session AND a permission check. Unlike the
 *     older gym routes (members/trainers/transactions), permissions ARE
 *     applied here, because the MenuMaster rows they resolve are seeded by
 *     scripts/seedWebsiteMenus.js and scripts/seedCmsMenus.js. Run those seeds
 *     before deploying, or every admin write 403s.
 *   - The CMS routes (SiteContent, SiteItem) use cmsPermission, NOT
 *     checkPermission: they check the permission of the PAGE being edited
 *     (/cms/faqs, /cms/pricing, …) with /website-pages as the "all CMS pages"
 *     grant. Adverts, leads and SEO keep their single fixed permission.
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

const itemImageUploadDir = "uploads/cms/site-items";
ensureLocalDir(itemImageUploadDir);

/**
 * A THIRD instance, again for its own folder and again safe only because it
 * never shares a route with another one. Its own folder rather than reusing
 * site-content's: trainer portraits and before/after photos are a different
 * retention question from a hero image, and a folder is the cheapest way to
 * keep that answerable.
 *
 * Compression is ON and safe: this field accepts images only
 * (ALLOWED_MIMES.images), never a PDF, so the shared WebP conversion cannot
 * corrupt anything — the member ID-proof rule does not apply here.
 */
const secureItemImageUpload = createSecureImageUpload({
  destination: itemImageUploadDir,
  fieldName: "image",
  maxSize: 5 * 1024 * 1024,
  compress: true,
  quality: 85,
});

const noticeImageUploadDir = "uploads/cms/notices";
ensureLocalDir(noticeImageUploadDir);

/**
 * A FOURTH instance, and the same two rules apply: its own folder, and it never
 * shares a route with another uploader.
 *
 * Only BANNERS use it — an announcement is a line of text and the controller
 * refuses an image on one. Compression is ON and safe: this field accepts
 * images only (ALLOWED_MIMES.images), never a PDF, so the shared WebP
 * conversion cannot corrupt anything — the member ID-proof rule does not apply.
 */
const secureNoticeImageUpload = createSecureImageUpload({
  destination: noticeImageUploadDir,
  fieldName: "image",
  maxSize: 5 * 1024 * 1024, // 5MB — banner creatives, not photography originals
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
 * /site/items:
 *   get:
 *     summary: Public repeating records for the website (active rows only)
 *     tags: [Website]
 *     parameters:
 *       - in: query
 *         name: collectionKey
 *         schema:
 *           type: string
 *           enum: [programs, plans, faqs, trainers, classes, testimonials, transformations]
 *         description: Which list to fetch. Omit for every active row.
 *       - in: query
 *         name: branch
 *         schema:
 *           type: string
 *         description: >
 *           Narrows to rows tagged with this branch PLUS every untagged row,
 *           which belongs to the whole gym.
 *     responses:
 *       200:
 *         description: Active rows, sorted by sortOrder
 */
// PUBLIC: these are the programme cards, prices, trainers, timetable, FAQs,
// testimonials and transformations printed on midcitygym.in. Requiring auth
// would mean the marketing site could not render. Only isActive rows are
// returned.
router.get("/site/items", getPublicSiteItems);

/**
 * @swagger
 * /site/notices:
 *   get:
 *     summary: Currently-live announcements and banners for the public website
 *     tags: [Website]
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *           enum: [ANNOUNCEMENT, BANNER]
 *         description: >
 *           ANNOUNCEMENT is the gym talking to its members (a closure, a timing
 *           change) and is site-wide. BANNER is a promotional slab placed in a
 *           slot. Omit to get every live notice of both kinds.
 *       - in: query
 *         name: placement
 *         schema:
 *           type: string
 *           enum: [HOME_TOP, HOME_MID, PROGRAMS_TOP, CONTACT_TOP]
 *         description: >
 *           BANNER only. Announcements carry no placement, so combining this
 *           with kind=ANNOUNCEMENT correctly returns an empty list.
 *     responses:
 *       200:
 *         description: Notices that are active and inside their date window
 */
// PUBLIC: this is the closure notice and the offer banner printed on
// midcitygym.in. Requiring auth would mean the marketing site could not render
// them. Scheduled and expired notices are filtered out in the controller, using
// the SAME liveWindowFilter() the advert endpoint uses, so an ISR-cached page
// can never keep serving a notice past its end date.
router.get("/site/notices", getPublicNotices);

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
 * /site/seo:
 *   get:
 *     summary: Per-route SEO metadata for the public site (active rows only)
 *     tags: [Website]
 *     parameters:
 *       - in: query
 *         name: slug
 *         schema:
 *           type: string
 *         description: >
 *           A route path such as "/" or "/programs". Normalised server-side
 *           (leading slash enforced, trailing slash and case stripped).
 *     responses:
 *       200:
 *         description: >
 *           WITH `slug`: `data` is that single row, or `null` when no row
 *           exists — callers must fall back to their own defaults rather than
 *           rendering an empty title. WITHOUT `slug`: `data` is the array of
 *           every active row, which is what the sitemap builder reads.
 *       400:
 *         description: The slug was not a usable route path
 */
// PUBLIC: this is the <head> of midcitygym.in — generateMetadata() and
// sitemap.xml both read it during a prerender, before any user exists. Only
// isActive rows are returned, so retiring a row really does retire it. noIndex
// rows ARE returned: the frontend needs the flag to emit robots: noindex.
router.get("/site/seo", getPublicSeoMeta);

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

// ============ ADMIN — SITE CONTENT (/cms/<page>, /website-pages) ============

/**
 * PERMISSION FOLLOWS THE PAGE. Each of these resolves the menu row for the
 * pageKey the request actually touches — /cms/home, /cms/faqs, /cms/footer —
 * and falls back to /website-pages, which is now the "all CMS pages" grant.
 * The mapping lives in config/cmsMenus.js, which is also what
 * scripts/seedCmsMenus.js builds the sidebar from, so the row the admin panel
 * gates the SCREEN on and the row the server gates the SAVE on cannot drift.
 *
 * On the `:id` routes the pageKey is not in the request, so the middleware
 * reads the row first — one extra projected findById on a write path, spelled
 * out in middlewares/cmsPermission.js.
 */
router.post(
  "/site/content-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("read", siteContentListTargets),
  listSiteContentByParams,
);
router.post(
  "/site/content",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("write", siteContentCreateTargets),
  createSiteContent,
);
router.put(
  "/site/content/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("edit", siteContentDocTargets),
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
  cmsPermission("edit", siteContentDocTargets),
  uploadRateLimiter,
  secureContentImageUpload,
  uploadSiteContentImage,
);
router.delete(
  "/site/content/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("delete", siteContentDocTargets),
  deleteSiteContent,
);

// ============ ADMIN — SITE ITEMS (/cms/<list>, /website-pages) ============

/**
 * SUPERSEDES the earlier "NO FIFTH MENU ROW" decision, and says why.
 *
 * These used to share one /website-pages permission with the page copy above,
 * on the argument that editing the six programme cards is the same job with the
 * same blast radius as editing the hero above them. That held while there was
 * one CMS screen. The sidebar now lists a screen per page, and the owner's
 * reason for wanting that is precisely the distinction the old decision denied:
 * letting somebody maintain the FAQ list without also handing them the pricing
 * table. So each list resolves its own menu — /cms/faqs, /cms/pricing,
 * /cms/trainers … — via config/cmsMenus.js.
 *
 * Nothing that works today stops working: /website-pages remains a valid grant
 * and now means "all CMS pages", so every existing role keeps exactly the
 * access it has, including before scripts/seedCmsMenus.js has been run.
 *
 * Note `plans` maps to /cms/pricing (the records are "plans", the screen is
 * "Pricing"), and `transformations` has no screen of its own, so it resolves to
 * the /website-pages fallback — i.e. unchanged behaviour.
 */
router.post(
  "/site/items-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("read", siteItemListTargets),
  listSiteItemsByParams,
);
router.post(
  "/site/items",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("write", siteItemCreateTargets),
  createSiteItem,
);
/**
 * A row may be MOVED between collections here (updateSiteItem supports it), so
 * the middleware requires `edit` on BOTH the list it is leaving and the list it
 * is joining. Without that, "edit a FAQ" would be a way to write into `plans`.
 */
router.put(
  "/site/items/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("edit", siteItemDocTargets),
  updateSiteItem,
);
/**
 * Auth and permission run BEFORE the uploader, as everywhere else in this file:
 * multer writes bytes (to disk or Blob) as soon as it runs, so a request that
 * will 401 must be rejected while it is still just headers.
 *
 * `?slot=beforeImage` targets a declared image field inside `fields` instead of
 * `imageUrl` — a transformation has two photos and neither is "the" image.
 */
router.post(
  "/site/items/:id/image",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("edit", siteItemDocTargets),
  uploadRateLimiter,
  secureItemImageUpload,
  uploadSiteItemImage,
);
router.delete(
  "/site/items/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("delete", siteItemDocTargets),
  deleteSiteItem,
);

// ============ ADMIN — NOTICES (/cms/announcements, /cms/banners) ============

/**
 * PERMISSION FOLLOWS THE KIND, the same way the CMS routes above follow the
 * page: an announcement resolves /cms/announcements and a banner /cms/banners,
 * with /website-pages as the all-CMS fallback. The mapping lives in
 * config/cmsMenus.js (CMS_NOTICE_MENUS) next to the tree scripts/seedCmsMenus.js
 * builds the sidebar from, so the row the panel gates the SCREEN on and the row
 * the server gates the SAVE on cannot drift.
 *
 * WHY TWO SCREENS AND NOT ONE: "tell members the gym is shut on Thursday" is an
 * operational job somebody at the desk should be able to do today; "run a
 * 20%-off campaign" is marketing and changes what the gym charges. One shared
 * permission would make the first imply the second.
 *
 * On the `:id` routes the kind is not in the request, so the middleware reads
 * the row first — one extra projected findById on a write path, spelled out in
 * middlewares/cmsPermission.js.
 */
router.post(
  "/site/notices-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("read", siteNoticeListTargets),
  listSiteNoticesByParams,
);
/**
 * CREATE IS JSON, NOT MULTIPART — the one deliberate shape difference from
 * POST /site/ads, and it is a permission decision as much as a modelling one.
 * The uploader must run AFTER the permission check (so no bytes are written for
 * a request that will 401), which means on a multipart create `req.body` is
 * still unparsed and `kind` cannot be read — so such a request could only ever
 * be checked against the all-pages grant, never against /cms/banners. Creating
 * from JSON and attaching the creative afterwards keeps the narrow grants real.
 */
router.post(
  "/site/notices",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("write", siteNoticeCreateTargets),
  createSiteNotice,
);
router.put(
  "/site/notices/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("edit", siteNoticeDocTargets),
  updateSiteNotice,
);
/**
 * Auth and permission run BEFORE the uploader, as everywhere else in this file:
 * multer writes bytes (to disk or Blob) as soon as it runs, so a request that
 * will 401 must be rejected while it is still just headers.
 *
 * BANNERS ONLY — the controller 400s on an announcement, which has no image
 * slot to render one in.
 */
router.post(
  "/site/notices/:id/image",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("edit", siteNoticeDocTargets),
  uploadRateLimiter,
  secureNoticeImageUpload,
  uploadSiteNoticeImage,
);
router.delete(
  "/site/notices/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  cmsPermission("delete", siteNoticeDocTargets),
  deleteSiteNotice,
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

// ============ ADMIN — SEO MANAGER (/seo-manager) ============

/**
 * Its own MenuMaster row, not a sub-permission of /website-pages: editing the
 * copy on a page and editing what Google is told about it are different jobs
 * with different blast radii — a wrong canonical URL de-indexes a page, which
 * no amount of proofreading the hero text can do. Seeded by
 * scripts/seedWebsiteMenus.js alongside the other three.
 */
router.post(
  "/site/seo-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/seo-manager", "read"),
  listSeoByParams,
);
router.post(
  "/site/seo",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/seo-manager", "write"),
  createSeoMeta,
);
router.put(
  "/site/seo/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/seo-manager", "edit"),
  updateSeoMeta,
);
router.delete(
  "/site/seo/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/seo-manager", "delete"),
  deleteSeoMeta,
);

export default router;
