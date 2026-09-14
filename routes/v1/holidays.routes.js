import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";
import {
  listHolidaysByParams,
  getHolidayCalendar,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  getUpcomingHolidaysForMember,
} from "../../controllers/v1/holiday.controller.js";

const router = express.Router();

/**
 * Holiday Master — gym closure days.
 *
 * ONE MENU ROW, `/holiday-master`, covers the master screen (list + CRUD) and
 * the calendar widget both — they are the same data viewed two ways, the
 * exact reasoning classes.routes.js gives for the diary and the roster
 * sharing `/class-sessions`.
 *
 * ============================================================================
 * EDIT RIGHTS: SUPER ADMIN + BRANCH ADMINS ONLY. EMPLOYEES HOLD read AND
 * NOTHING ELSE — the owner's own words, "basically it's just checkbox
 * unchecked".
 * ============================================================================
 * That is encoded in scripts/repairRbac.js's TIER_BASELINES, not here: the
 * `admin` tier gets read+write+edit+delete on `/holiday-master`, the `staff`
 * tier gets read only. This file just gates each route behind the right
 * ACTION; which tier holds which action is the seed's job.
 *
 * checkPermission resolves a menu BY URL — scripts/seedHolidayMenu.js MUST be
 * run before this is reachable by anyone but the super admin, same trap every
 * other gated route in this codebase carries (see classes.routes.js's header,
 * seedClassMenus.js's header).
 *
 * Mounted flat under /api/v1, paths written out in full, exactly like every
 * other route file here.
 */

const staffRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/holiday-master", "read"),
];

/**
 * @swagger
 * /holidays-by-params:
 *   post:
 *     summary: Paged list of holidays (staff)
 *     tags: [Holidays - Admin]
 *     responses:
 *       200: { description: "{ count, data } — branch-scoped (own branch + all-branches)" }
 */
router.post("/holidays-by-params", ...staffRead, listHolidaysByParams);

/**
 * @swagger
 * /holidays/calendar:
 *   get:
 *     summary: One month's holidays, for the calendar widget
 *     tags: [Holidays - Admin]
 *     parameters:
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *     responses:
 *       200: { description: "{ year, month, from, to, holidays } — branch-scoped" }
 */
router.get("/holidays/calendar", ...staffRead, getHolidayCalendar);

router.post(
  "/holidays",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/holiday-master", "write"),
  createHoliday,
);
router.put(
  "/holidays/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/holiday-master", "edit"),
  updateHoliday,
);
router.delete(
  "/holidays/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/holiday-master", "delete"),
  deleteHoliday,
);

// ============ MEMBER PORTAL (JWT) — read-only ============

/**
 * requireMember, not requirePortalUser: the owner's brief is specifically a
 * MEMBER dashboard widget ("closed today" / "closed this week"). Nothing
 * asked for a trainer-facing equivalent, and requirePortalUser exists to widen
 * a guard BY NAME when a route genuinely serves both audiences (see its doc
 * comment in memberAuth.controller.js) — not as a default. This stays narrow
 * until a trainer screen actually needs it; widening later is a one-line,
 * deliberate change, not a side effect of copying this route.
 *
 * Identity and branch come ONLY from the verified token (req.member.id),
 * looked up server-side in the controller — no memberId/branch query param is
 * read anywhere on this path.
 *
 * GET /api/v1/member-portal/holidays/upcoming
 */
router.get(
  "/member-portal/holidays/upcoming",
  requireMember,
  getUpcomingHolidaysForMember,
);

export default router;
