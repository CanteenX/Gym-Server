import express from "express";
import { createSecureMultiUpload } from "../../middlewares/secureUpload.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { ensureLocalDir } from "../../config/runtime.js";
import {
  createMember,
  updateMember,
  deleteMember,
  getMemberById,
  listMembersByParams,
  getMemberDashboardStats,
  getMemberPlans,
  renewMembership,
  addPayment,
} from "../../controllers/v1/member.controller.js";

const router = express.Router();

// ============ SECURE FILE UPLOAD CONFIGURATION ============
const memberUploadFolder = "uploads/members";

// No-op on the read-only serverless filesystem; uploads go to Blob there.
ensureLocalDir(memberUploadFolder);

const TWO_MB = 2 * 1024 * 1024;

/**
 * Photo and ID proof are handled by ONE middleware pass.
 *
 * Multer consumes the multipart stream, so chaining two instances on the same
 * route leaves the second with nothing to parse and it rejects the request.
 * Both fields therefore go through a single `fields()` call.
 *
 * Compression is OFF because this field set accepts PDFs (members routinely
 * upload a PDF of an Aadhaar or licence) and the shared uploader converts every
 * file to WebP when compression is on, which would corrupt them. Images are
 * optimised afterwards in the controller, where the file type is known.
 *
 * The 2MB cap applies to what the user uploads; after WebP conversion the
 * stored image is typically a fraction of that.
 */
const memberUpload = createSecureMultiUpload({
  destination: memberUploadFolder,
  fields: [
    { name: "photo", maxCount: 1 },
    { name: "idProof", maxCount: 1 },
  ],
  maxSize: TWO_MB,
  allowedMimes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  allowedExts: [".jpg", ".jpeg", ".png", ".webp", ".pdf"],
  compress: false,
});

/**
 * Staff-side member management. Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE).
 *
 * Auth runs BEFORE memberUpload so an unauthenticated request is rejected
 * before multer parses any file to disk.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/member-plans",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getMemberPlans,
);
router.get(
  "/members-dashboard-stats",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getMemberDashboardStats,
);
router.post(
  "/members-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listMembersByParams,
);
router.post(
  "/members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  memberUpload,
  createMember,
);
router.get(
  "/members/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getMemberById,
);
router.put(
  "/members/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  memberUpload,
  updateMember,
);
router.delete(
  "/members/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteMember,
);
router.post(
  "/members/:id/renew",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  renewMembership,
);
router.post(
  "/members/:id/payments",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  addPayment,
);

export default router;
