import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  getCollectionsReport,
  getProfitAndLoss,
} from "../../controllers/v1/report.controller.js";
import {
  getExpiryPipeline,
  getMemberAgeing,
} from "../../controllers/v1/memberReport.controller.js";
import {
  exportTransactions,
  exportMembers,
  exportAttendance,
} from "../../controllers/v1/export.controller.js";

const router = express.Router();

/**
 * Reports and CSV exports. Every route is a read; nothing here writes.
 *
 * Mounted flat under /api/v1 like every other route file — the paths are
 * written out in full below rather than derived from a router prefix.
 *
 * PERMISSIONS: both the reports and the exports resolve the SAME MenuMaster
 * row, `/reports`, seeded by scripts/seedInsightsMenus.js. Run that seed before
 * deploying or every one of these 403s with "Menu '/reports' not found" for
 * anyone who is not a super admin.
 *
 * The two differ in the ACTION they require:
 *   - viewing a report needs "read";
 *   - downloading it needs "print".
 * That is the least-privilege split the permission model already has room for,
 * and it is the meaningful one here: a report on screen stays on screen, while
 * a CSV leaves the building and gets forwarded. A receptionist who should see
 * today's collections does not automatically get a file of every member's
 * contact details.
 *
 * BRANCH SCOPING is enforced in the controllers, from `req.session.user`:
 * `financialScopeFilter` for money (which is what keeps the "Common"
 * shared-cost bucket super-admin-only) and `scopeFilter` for the member-base
 * reports. Both are spread LAST into their filters, so a `?branch=` in the
 * query string can narrow a super admin's view and can never widen a branch
 * admin's.
 */

const reportRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/reports", "read"),
];

const reportExport = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/reports", "print"),
];

// ============ REPORTS ============

/**
 * @swagger
 * /reports/collections:
 *   get:
 *     summary: Money received by month and branch
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: months
 *         schema: { type: integer, default: 12, maximum: 36 }
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           Dense monthly series from the Transaction ledger (direction IN).
 *           Never computed from Member.payments, which is cleared on renewal.
 */
router.get("/reports/collections", ...reportRead, getCollectionsReport);

/**
 * @swagger
 * /reports/profit-loss:
 *   get:
 *     summary: Income, expenses and net per branch, with shared costs kept separate
 *     tags: [Reports]
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
 *     responses:
 *       200:
 *         description: >
 *           `branches[]` never contains "Common". `common` and `consolidated`
 *           are non-null for a super admin only — shared rent, software and the
 *           owner's salary must not appear in a single branch's P&L.
 */
router.get("/reports/profit-loss", ...reportRead, getProfitAndLoss);

/**
 * @swagger
 * /reports/expiry-pipeline:
 *   get:
 *     summary: Active memberships bucketed by how soon they expire
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: perBucket
 *         schema: { type: integer, default: 10, maximum: 50 }
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bucket counts, per-branch counts and a sample call list
 */
router.get("/reports/expiry-pipeline", ...reportRead, getExpiryPipeline);

/**
 * @swagger
 * /reports/member-ageing:
 *   get:
 *     summary: Member tenure cohorts and outstanding-dues ageing
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           Dues are Member.totalFee minus ledger receipts since startDate.
 *           Member.payments[] is never summed — it is cleared on renewal.
 */
router.get("/reports/member-ageing", ...reportRead, getMemberAgeing);

// ============ CSV EXPORTS ============

/**
 * @swagger
 * /exports/transactions:
 *   get:
 *     summary: Cash ledger as CSV (or JSON with ?format=json)
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: direction
 *         schema: { type: string, enum: [IN, OUT] }
 *       - in: query
 *         name: branch
 *         schema: { type: string }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [csv, json] }
 *         description: json returns a capped array for the ExportCSVModal
 *     responses:
 *       200:
 *         description: Streamed text/csv, scoped by financialScopeFilter
 */
router.get("/exports/transactions", ...reportExport, exportTransactions);

/**
 * @swagger
 * /exports/members:
 *   get:
 *     summary: Member list as CSV (or JSON with ?format=json)
 *     tags: [Reports]
 *     responses:
 *       200:
 *         description: >
 *           Streamed text/csv. Excludes portal credentials, ID proofs and
 *           payment subdocuments by design.
 */
router.get("/exports/members", ...reportExport, exportMembers);

/**
 * @swagger
 * /exports/attendance:
 *   get:
 *     summary: Logged check-ins as CSV (or JSON with ?format=json)
 *     tags: [Reports]
 *     responses:
 *       200:
 *         description: Streamed text/csv of self-reported check-ins
 */
router.get("/exports/attendance", ...reportExport, exportAttendance);

export default router;
