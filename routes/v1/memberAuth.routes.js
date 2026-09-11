import express from "express";
import {
  memberLogin,
  getMemberProfile,
  changeMemberPassword,
  setMemberPassword,
  revokeMemberPortalAccess,
  requireMember,
} from "../../controllers/v1/memberAuth.controller.js";

const router = express.Router();

// ===== Public (member portal) =====
router.post("/member-auth/login", memberLogin);

// ===== Authenticated member =====
router.get("/member-auth/me", requireMember, getMemberProfile);
router.post(
  "/member-auth/change-password",
  requireMember,
  changeMemberPassword,
);

// ===== Staff-side portal access management =====
// Mounted here rather than in members.routes.js so every credential-touching
// handler lives in one file.
router.put("/members/:id/set-password", setMemberPassword);
router.delete("/members/:id/portal-access", revokeMemberPortalAccess);

export default router;
