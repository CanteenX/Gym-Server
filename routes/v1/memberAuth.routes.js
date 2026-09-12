import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { authRateLimiter } from "../../middlewares/rateLimiter.js";
import {
  memberLogin,
  getMemberProfile,
  changeMemberPassword,
  setMemberPassword,
  revokeMemberPortalAccess,
  requireMember,
} from "../../controllers/v1/memberAuth.controller.js";

const router = express.Router();

/**
 * ===== Public (member portal) =====
 *
 * Rate limited for the same reason the staff logins are: this endpoint takes a
 * mobile number and a password, and mobile numbers are guessable in a way that
 * email addresses are not — an attacker can walk the local number range. It was
 * previously the only unthrottled credential check in the system.
 *
 * skipSuccessfulRequests is on (see rateLimiter.js), so a member signing in
 * repeatedly never burns the budget; only failures count.
 */
router.post("/member-auth/login", authRateLimiter, memberLogin);

// ===== Authenticated member =====
router.get("/member-auth/me", requireMember, getMemberProfile);
router.post(
  "/member-auth/change-password",
  requireMember,
  changeMemberPassword,
);

/**
 * ===== Staff-side portal access management =====
 *
 * Mounted here rather than in members.routes.js so every credential-touching
 * handler lives in one file.
 *
 * BOTH REQUIRE A STAFF SESSION. They previously had no guard at all, which
 * meant anyone who could reach the server and guess (or enumerate) a member's
 * _id could set that member's portal password and then log in as them — a full
 * account takeover with no credential needed. These are the most sensitive
 * routes in the file precisely because they WRITE credentials, so they get the
 * same authMiddleware the rest of the gym domain uses.
 */
router.put(
  "/members/:id/set-password",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  setMemberPassword,
);
router.delete(
  "/members/:id/portal-access",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  revokeMemberPortalAccess,
);

export default router;
