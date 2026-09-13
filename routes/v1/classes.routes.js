import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import { authRateLimiter, userRateLimiter } from "../../middlewares/rateLimiter.js";
import { createBookingValidation } from "../../middlewares/inputValidator.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";
import {
  getPublicUpcomingSessions,
  listSessionsByParams,
  createSession,
  updateSession,
  deleteSession,
  getSessionRoster,
} from "../../controllers/v1/classSession.controller.js";
import {
  createPublicBooking,
  createMemberBooking,
  listMyBookings,
  cancelMyBooking,
  listBookingsByParams,
  updateBookingStatus,
} from "../../controllers/v1/booking.controller.js";

const router = express.Router();

/**
 * Class booking — all three audiences in one file, the way attendance.routes.js
 * carries both the member portal and the staff panel for one feature.
 *
 *   PUBLIC (no auth)      the marketing site's timetable and free-trial form
 *   MEMBER PORTAL (JWT)   a signed-in member booking and cancelling
 *   ADMIN (session)       scheduling classes and working the roster
 *
 * They share no middleware. A visitor is anonymous, a member is identified by a
 * bearer token signed with MEMBER_JWT_SECRET_KEY, and a staff user by an
 * express-session cookie — mixing those up is the one mistake this codebase is
 * most careful about (see the two-auth-systems section of CLAUDE.md).
 *
 * Mounted flat under /api/v1 like every other route file: paths are written in
 * full here, not derived from a router prefix.
 *
 * ============================================================================
 * checkPermission IS APPLIED to every admin route here, and that means
 * scripts/seedClassMenus.js MUST BE RUN BEFORE DEPLOYING.
 * ============================================================================
 * checkPermission resolves a menu BY URL; a missing MenuMaster row is a 403
 * ("Menu '/class-sessions' not found"), not a fallback. The failure is
 * asymmetric and therefore easy to miss: ADMIN returns next() immediately, so
 * the owner sees a working screen while every employee gets 403.
 *
 * ONE MENU ROW, `/class-sessions`, COVERS BOTH THE DIARY AND THE ROSTER.
 * Scheduling a class and marking who turned up are the same job done by the
 * same person at the same desk, and the roster is rendered inside the session
 * screen. A second row would mean a second permission to grant per role and a
 * receptionist who can open a class but mysteriously not tick anybody off it.
 * (Same reasoning site.routes.js gives for SiteItems sharing /website-pages.)
 */

// ============ PUBLIC ENDPOINTS (NO AUTH — DELIBERATE) ============

/**
 * @swagger
 * /classes/upcoming:
 *   get:
 *     summary: Upcoming bookable classes, with remaining capacity
 *     tags: [Classes]
 *     parameters:
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *         description: Narrows to one physical branch. An unknown branch returns [].
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 14, maximum: 90 }
 *     responses:
 *       200:
 *         description: >
 *           Active sessions that have not yet started, soonest first, each with
 *           `remainingCapacity`. Staff-internal fields are not included.
 */
// PUBLIC: this is the timetable printed on midcitygym.in beside the "Book a
// free trial" button. Requiring auth would mean the marketing site could not
// render it — same reasoning as GET /site/items.
//
// REGISTERED BEFORE /classes/:id/roster, and it cannot be shadowed by it in any
// case: "upcoming" is two segments and the roster is three.
router.get("/classes/upcoming", getPublicUpcomingSessions);

/**
 * @swagger
 * /classes/{id}/book:
 *   post:
 *     summary: Book a place (public — a prospect with no account)
 *     tags: [Classes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
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
 *               website: { type: string, description: "Honeypot — must be empty" }
 *     responses:
 *       201: { description: Place booked }
 *       400: { description: Validation error }
 *       403: { description: Members-only class }
 *       409: { description: "Class full (code FULL) or already booked (ALREADY_BOOKED)" }
 *       429: { description: Rate limited }
 */
/**
 * PUBLIC WRITE. Three layers guard it, exactly as POST /site/leads:
 *
 *   1. authRateLimiter — the strictest limiter available (5/15 min in
 *      production). An unauthenticated INSERT is the shape of endpoint that
 *      fills a database overnight, and this one also CONSUMES SEATS, so a spam
 *      run would show every class as full to real visitors.
 *   2. createBookingValidation — per-field type, length and charset checks plus
 *      sanitisation, since this text is re-rendered on the admin roster and in
 *      a notification email.
 *   3. The `website` honeypot, enforced in the controller BEFORE any seat is
 *      reserved.
 */
router.post(
  "/classes/:id/book",
  authRateLimiter,
  createBookingValidation,
  createPublicBooking,
);

// ============ MEMBER PORTAL (JWT) ============

/**
 * requireMember, not requirePortalUser: a booking belongs to a Member and the
 * handler reads `req.member.id`. A trainer's token is validly signed with the
 * same key, so widening the guard would let a trainer book a member's place —
 * the separation is the subjectType CLAIM, checked inside the guard, and the
 * signature alone proves only "some portal user" (see attendance.routes.js).
 */
router.get("/member-portal/bookings", requireMember, listMyBookings);

/**
 * Rate limited even though it is authenticated, for the same reason the scan
 * endpoint is: it WRITES on every call and it consumes a shared resource.
 * userRateLimiter keys on IP:userId, so one abusive account cannot spend
 * another member's budget.
 */
router.post(
  "/member-portal/classes/:id/book",
  requireMember,
  userRateLimiter,
  createMemberBooking,
);
router.post(
  "/member-portal/bookings/:id/cancel",
  requireMember,
  userRateLimiter,
  cancelMyBooking,
);

// ============ ADMIN — CLASSES AND ROSTER (/class-sessions) ============

const staffRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/class-sessions", "read"),
];

/**
 * @swagger
 * /classes-by-params:
 *   post:
 *     summary: Paged list of class sessions (staff)
 *     tags: [Classes - Admin]
 *     responses:
 *       200: { description: "{ count, data } — branch-scoped" }
 */
router.post("/classes-by-params", ...staffRead, listSessionsByParams);

/**
 * @swagger
 * /classes/{id}/roster:
 *   get:
 *     summary: Who is booked onto one class
 *     tags: [Classes - Admin]
 *     responses:
 *       200: { description: "Session, counts by status, and every booking" }
 *       404: { description: "Not found, or not this admin's branch" }
 */
router.get("/classes/:id/roster", ...staffRead, getSessionRoster);

router.post(
  "/classes",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/class-sessions", "write"),
  createSession,
);
router.put(
  "/classes/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/class-sessions", "edit"),
  updateSession,
);
router.delete(
  "/classes/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/class-sessions", "delete"),
  deleteSession,
);

/**
 * Bookings are listed and marked under the SAME menu row as the sessions —
 * see the file header for why there is no second row.
 *
 * Marking somebody ATTENDED is an "edit", not a "write": nothing new is
 * created, an existing row's status changes. Creating a booking from the admin
 * panel is deliberately not offered here at all — staff booking somebody in is
 * the member-portal or public path with that person's own details, and a third
 * creation path would be a third place the atomic reservation could be got wrong.
 */
router.post("/class-bookings-by-params", ...staffRead, listBookingsByParams);
router.put(
  "/class-bookings/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/class-sessions", "edit"),
  updateBookingStatus,
);

export default router;
