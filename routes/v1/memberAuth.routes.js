import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { authRateLimiter } from "../../middlewares/rateLimiter.js";
import {
  memberLogin,
  getMemberProfile,
  getPortalProfile,
  changeMemberPassword,
  setMemberPassword,
  revokeMemberPortalAccess,
  requireMember,
  requireTrainer,
  requirePortalUser,
} from "../../controllers/v1/memberAuth.controller.js";
import {
  setTrainerPassword,
  revokeTrainerPortalAccess,
  changeTrainerPassword,
} from "../../controllers/v1/trainerAuth.controller.js";

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
//
// STILL MEMBER-ONLY, AND DELIBERATELY SO. Phase 3 added trainers to the portal
// but did not widen these: /member-auth/me returns a MEMBER profile (plan,
// dates, fee, balance) and the password change writes to Member. A trainer's
// token is validly signed with the same key, so the only thing keeping it out
// is requireMember's subjectType check. Trainers get the two routes below
// instead.
router.get("/member-auth/me", requireMember, getMemberProfile);
router.post(
  "/member-auth/change-password",
  requireMember,
  changeMemberPassword,
);

// ===== Authenticated portal user (member OR trainer) =====
//
// The portal calls this on boot to restore whoever is signed in. It has to
// accept both or a trainer refreshing the page would be signed out by a 403
// from /member-auth/me. It returns only the caller's OWN record, chosen by the
// subjectType claim — there is no id in the path to tamper with.
router.get("/portal-auth/me", requirePortalUser, getPortalProfile);

// ===== Authenticated trainer =====
router.post(
  "/portal-auth/trainer/change-password",
  requireTrainer,
  changeTrainerPassword,
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

/**
 * ===== Staff-side TRAINER portal access management (plan.md D4) =====
 *
 * The exact mirror of the two routes above, one noun along, and mounted here
 * for the same stated reason: every credential-touching handler lives in one
 * file. They are NOT in trainers.routes.js despite acting on a trainer.
 *
 * A staff session is required on both, no exceptions — these WRITE a password,
 * so an unguarded one is a full account takeover for anyone who can guess an
 * _id. That is not hypothetical: it is exactly what the member equivalents
 * shipped with before it was found.
 */
router.put(
  "/trainers/:id/set-password",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  setTrainerPassword,
);
router.delete(
  "/trainers/:id/portal-access",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  revokeTrainerPortalAccess,
);

export default router;
