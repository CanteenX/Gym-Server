import express from "express";
import { createSecureUpload } from "../../middlewares/secureUpload.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createGuide,
  updateGuide,
  deleteGuide,
  listGuidesByParams,
} from "../../controllers/v1/guide.controller.js";

const router = express.Router();

const guideUpload = createSecureUpload({
  destination: "uploads/guides",
  fieldName: "file",
  maxSize: 50 * 1024 * 1024, // 50MB maximum for videos
  allowedMimes: [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ],
  allowedExts: [
    ".mp4",
    ".webm",
    ".ogg",
    ".mov",
    ".pdf",
    ".doc",
    ".docx"
  ]
});

/**
 * Staff-side Guide master (CMS). Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other masters.
 *
 * Auth runs BEFORE `guideUpload` so an unauthenticated request is rejected
 * before multer writes any file to disk. That ordering matters most here: this
 * uploader accepts videos up to 50MB, so an open route is also an
 * unauthenticated disk-fill vector.
 *
 * There is no public consumer of these endpoints: the marketing site renders
 * its content from static constants and the member portal authenticates with a
 * member bearer token, so nothing here needs to stay open.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.post(
  "/guides",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  guideUpload,
  createGuide,
);
router.put(
  "/guides/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  guideUpload,
  updateGuide,
);
router.delete("/guides/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), deleteGuide);
router.post(
  "/guides/list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listGuidesByParams,
);

export default router;
