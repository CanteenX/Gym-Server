import express from "express";
import {
  checkIn,
  checkOut,
  getToday,
  listAttendance,
  updateSessionLength,
} from "../../controllers/v1/attendance.controller.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  getFootfall,
  getInGymNow,
  getNotCheckedIn,
} from "../../controllers/v1/attendanceStaff.controller.js";

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
router.post("/member-portal/attendance/check-out", requireMember, checkOut);
router.get("/member-portal/attendance/today", requireMember, getToday);
router.get("/member-portal/attendance", requireMember, listAttendance);

// Lives here rather than with the auth profile routes because the only thing
// this setting affects is the attendance auto-close.
router.put("/member-portal/session-length", requireMember, updateSessionLength);

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
 *           Open sessions started within the longest possible session length,
 *           plus a count of stale open sessions awaiting auto-close.
 */
// Polled by the admin panel every 30-60s: the API is a serverless function and
// cannot hold a WebSocket (plan.md D2a), so the feed is a small, cheap GET.
router.get("/attendance/live", ...staffRead, getInGymNow);

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

export default router;
