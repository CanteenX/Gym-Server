import express from "express";
import fs from "node:fs";
import { createSecureMultiUpload } from "../../middlewares/secureUpload.js";
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

if (!fs.existsSync(memberUploadFolder)) {
  fs.mkdirSync(memberUploadFolder, { recursive: true });
}

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

router.get("/member-plans", getMemberPlans);
router.get("/members-dashboard-stats", getMemberDashboardStats);
router.post("/members-by-params", listMembersByParams);
router.post("/members", memberUpload, createMember);
router.get("/members/:id", getMemberById);
router.put("/members/:id", memberUpload, updateMember);
router.delete("/members/:id", deleteMember);
router.post("/members/:id/renew", renewMembership);
router.post("/members/:id/payments", addPayment);

export default router;
