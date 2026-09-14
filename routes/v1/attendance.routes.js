import express from "express";
import {
  checkIn,
  checkOut,
  getToday,
  listAttendance,
  updateSessionLength,
} from "../../controllers/v1/attendance.controller.js";
import {
  requireMember,
  requirePortalUser,
} from "../../controllers/v1/memberAuth.controller.js";
import {
  scanCheckIn,
  getBranchQr,
} from "../../controllers/v1/attendanceScan.controller.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import { userRateLimiter } from "../../middlewares/rateLimiter.js";
import {
  getFootfall,
  getInGymNow,
  getNotCheckedIn,
} from "../../controllers/v1/attendanceStaff.controller.js";
import { markAttendanceAllowed } from "../../controllers/v1/attendanceOverride.controller.js";

const router = express.Router();

/**
 * Attendance, both halves of it.
 *
 * MEMBER PORTAL (/member-portal/attendance/*) — JWT, the member's own rows.
 * STAFF PANEL   (/attendance/*)               — session cookie, branch-scoped.
 *
 * The two live in one file because they are one feature, the way site.routes.js
 * carries both the public reads and the admin writes for the website. They
 * share no middleware: a member is identified by a bearer token and a staff
 * user by an express-session cookie, and mixing those up is the one mistake
 * this codebase is most careful about (see the two-auth-systems section of
 * CLAUDE.md).
 */

// ============ MEMBER PORTAL (JWT) ============

/**
 * Every route here is behind requireMember — a check-in is a claim about where
 * a person physically is, so the member must be identified by their token and
 * never by a path or body param.
 */
router.post("/member-portal/attendance/check-in", requireMember, checkIn);
/**
 * requirePortalUser, not requireMember — a trainer's shift is an Attendance
 * row too (same reasoning as /scan below), and without this a trainer's own
 * checkout tap is rejected before checkOut() ever runs, so every shift closes
 * only on the 480-minute auto-close sweep (docs/todo.md item 1).
 *
 * checkOut() itself decides what "own" means from req.portalUser — never from
 * req.member — so a trainer can close only a TRAINER row carrying their own
 * trainerId, and a member only a MEMBER row carrying their own memberId. See
 * the comment on checkOut() in attendance.controller.js for why that matters.
 */
router.post(
  "/member-portal/attendance/check-out",
  requirePortalUser,
  checkOut,
);
router.get("/member-portal/attendance/today", requireMember, getToday);
router.get("/member-portal/attendance", requireMember, listAttendance);

// Lives here rather than with the auth profile routes because the only thing
// this setting affects is the attendance auto-close.
router.put("/member-portal/session-length", requireMember, updateSessionLength);

/**
 * @swagger
 * /member-portal/attendance/scan:
 *   post:
 *     summary: QR check-in with an explicit ALLOW / DENY verdict
 *     tags: [Attendance - Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               branch: { type: string, description: The branch the QR carried }
 *               source: { type: string, enum: [QR, SELF], default: QR }
 *     responses:
 *       200:
 *         description: >
 *           { verdict, reason, branch, attendanceId }. The attempt is recorded
 *           either way. A DENY informs the member and flags the front desk; it
 *           is NOT a door and nothing here is proof of presence.
 *
 * ============================================================================
 * THE ONE ROUTE IN THIS FILE THAT A TRAINER MAY REACH.
 * ============================================================================
 * requirePortalUser, not requireMember, because a trainer's shift is an
 * Attendance row too (plan.md D3/D4). Nothing else on the member-portal side
 * was widened: the routes above stay requireMember, so a trainer's token — a
 * validly signed token, since both are signed with MEMBER_JWT_SECRET_KEY —
 * still cannot read a member's history, weight log, workout plan or profile.
 * The separation is the subjectType CLAIM, checked inside each guard; the
 * signature alone proves only "some portal user".
 */
/**
 * Rate limited even though it is authenticated. The endpoint WRITES on every
 * call - an allowed scan opens a session, a denied one records the refusal -
 * so a client looping it is writing rows, not just reading. keyGenerator is
 * IP:userId, so one abusive account cannot spend another member's budget, and
 * 200/15min is far above anything a person walking through a door produces.
 *
 * userRateLimiter has existed unused since before this phase; this is its
 * first real consumer.
 */
router.post(
  "/member-portal/attendance/scan",
  requirePortalUser,
  userRateLimiter,
  scanCheckIn,
);

// ============ STAFF PANEL (session + permission) ============

/**
 * checkPermission IS applied here, unlike the older gym routes
 * (members/trainers/transactions), because the /attendance-overview MenuMaster
 * row is seeded by scripts/seedInsightsMenus.js.
 *
 * RUN THAT SEED BEFORE DEPLOYING. checkPermission resolves a menu BY URL and
 * 403s with "Menu '/attendance-overview' not found" when the row is absent —
 * it does not fall back. Super admins are unaffected either way (ADMIN returns
 * next() immediately), so a missing seed looks fine to the owner and broken to
 * everybody else.
 */
const staffRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/attendance-overview", "read"),
];

/**
 * The write half. Same menu, "edit" instead of "read" — overriding a refusal is
 * changing a record in a member's favour, possibly with money behind it, so it
 * is not something everyone who can LOOK at the attendance screen may do.
 */
const staffEdit = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/attendance-overview", "edit"),
];

/**
 * @swagger
 * /attendance/footfall:
 *   get:
 *     summary: Check-ins per branch per day
 *     tags: [Attendance - Staff]
 *     parameters:
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *         description: >
 *           Narrows a super admin's view. Ignored for a branch admin, whose
 *           own branch always wins.
 *     responses:
 *       200:
 *         description: >
 *           Per-day rows plus per-branch totals. Counts SELF-REPORTED check-ins,
 *           not verified visits.
 *       400:
 *         description: Bad or oversized date range
 */
router.get("/attendance/footfall", ...staffRead, getFootfall);

/**
 * @swagger
 * /attendance/live:
 *   get:
 *     summary: Members currently inside (open sessions)
 *     tags: [Attendance - Staff]
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: >
 *           Return only arrivals after this instant. Pass back the `serverTime`
 *           from the previous poll.
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           `{ denials, deniedNew, deniedToday, inGymNow, sessions,
 *           staleOpenSessions }`. Denials come FIRST because they are the only
 *           rows staff must act on (plan.md D2); they are NOT counted in
 *           inGymNow. The denial list is cursored on `updatedAt`, not
 *           `checkInAt`, because a repeat refusal updates today's row in place
 *           — see attendanceStaff.controller.js.
 */
// Polled by the admin panel every 30-60s: the API is a serverless function and
// cannot hold a WebSocket (plan.md D2a), so the feed is a small, cheap GET.
router.get("/attendance/live", ...staffRead, getInGymNow);

/**
 * @swagger
 * /attendance/{id}/mark-allowed:
 *   post:
 *     summary: Override a refusal — mark a denied check-in as allowed
 *     tags: [Attendance - Staff]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The denied Attendance row's _id, from /attendance/live.
 *       - in: query
 *         name: subjectType
 *         schema: { type: string, enum: [MEMBER, TRAINER, ALL], default: MEMBER }
 *         description: >
 *           Defaults to MEMBER, like every other query over this collection. A
 *           trainer's refused shift has to be asked for by name.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, maxLength: 300, description: "e.g. paid at desk, receipt 1042" }
 *     responses:
 *       200:
 *         description: >
 *           Overridden, or already overridden (`alreadyOverridden: true`, no
 *           second write). `sessionOpened` says whether a live session was
 *           opened — true for a refusal from today, false for an older one.
 *       400:
 *         description: Bad attendance id or note
 *       404:
 *         description: No such row, OR it belongs to another branch — the same
 *           answer on purpose, so an id cannot be probed across branches
 *       409:
 *         description: That check-in was never refused
 *
 * Writes an AuditLog row through the global mongoose plugin: this is a staff
 * override of a system decision in a member's favour, which is the case the
 * audit log was built for.
 */
router.post("/attendance/:id/mark-allowed", ...staffEdit, markAttendanceAllowed);

/**
 * @swagger
 * /attendance/not-checked-in:
 *   get:
 *     summary: Members with no logged check-in for N days (default 14)
 *     tags: [Attendance - Staff]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 14 }
 *       - in: query
 *         name: skip
 *         schema: { type: integer }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer }
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           "NOT CHECKED IN", not "not visited". Check-in is unattended and
 *           self-reported, so this measures logging behaviour: a member can
 *           train without logging and can log without attending. A prompt for a
 *           phone call, not evidence.
 */
router.get("/attendance/not-checked-in", ...staffRead, getNotCheckedIn);

/**
 * @swagger
 * /attendance/qr/{branch}:
 *   get:
 *     summary: The printable QR payload for one branch
 *     tags: [Attendance - Staff]
 *     parameters:
 *       - in: path
 *         name: branch
 *         required: true
 *         schema: { type: string }
 *         description: A physical branch name from the Branch master.
 *     responses:
 *       200:
 *         description: >
 *           { branch, url, path, configured }. The deep link to encode on the
 *           sticker; the admin panel renders the image. `configured` is false
 *           when PUBLIC_SITE_ORIGIN is unset, in which case the link is
 *           relative and must not be printed.
 *       403:
 *         description: A branch admin asked for another branch's QR
 *       404:
 *         description: No such branch
 *
 * Behind the SAME /attendance-overview permission as the views above: printing
 * the sticker is part of running the attendance feature, and the payload
 * carries no member data at all.
 */
router.get("/attendance/qr/:branch", ...staffRead, getBranchQr);

export default router;
