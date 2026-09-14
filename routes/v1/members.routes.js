import express from "express";
import { createSecureMultiUpload } from "../../middlewares/secureUpload.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
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
 * checkPermission IS applied, as of 2026-09-14. The note that used to sit here
 * said it was "deliberately not applied yet" because the menu row might be
 * missing from MenuMaster and would 403 a legitimate screen. That was true when
 * it was written and had since stopped being true — the menu row is seeded and
 * active, and both tiers carry flags for it — but the note outlived the
 * condition, which is how a temporary exception quietly becomes permanent.
 *
 * What it was costing, measured live as the front desk (who holds `read` only):
 * DELETE and POST both reached the handler. The panel hid the buttons; the API
 * did not enforce them, so any signed-in staff account could enrol, edit, renew,
 * take payments on and delete records in its own branch whatever its role said.
 *
 * The actions are not uniform. Renew and add-payment ride on `edit`, not
 * `write`: they change an EXISTING member rather than creating one, and a desk
 * that may correct a member's details may certainly record the cash that member
 * just handed over. Gating them on `write` would tie taking payment to the
 * unrelated right to create records.
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
  checkPermission("/members", "read"),
  listMembersByParams,
);
router.post(
  "/members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/members", "write"),
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
  checkPermission("/members", "edit"),
  memberUpload,
  updateMember,
);
router.delete(
  "/members/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/members", "delete"),
  deleteMember,
);
router.post(
  "/members/:id/renew",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/members", "edit"),
  renewMembership,
);
router.post(
  "/members/:id/payments",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/members", "edit"),
  addPayment,
);

export default router;
