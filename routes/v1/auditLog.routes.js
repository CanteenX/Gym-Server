import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  listAuditLogsByParams,
  getAuditLogById,
  getAuditLogFilters,
} from "../../controllers/v1/auditLog.controller.js";

const router = express.Router();

/**
 * The audit log viewer. READ-ONLY, on purpose.
 *
 * There is deliberately no POST/PUT/DELETE here. Rows are written by the global
 * mongoose plugin in services/auditLog.js and by nothing else; an audit trail
 * with an edit endpoint is not an audit trail. If a row is wrong, the fix is to
 * fix the plugin, not the row.
 *
 * Permission: /audit-log, seeded by scripts/seedInsightsMenus.js. Grants are
 * opt-in per role — this screen shows who changed what across the branch, which
 * is a supervisory view, not a general one.
 *
 * Branch scoping lives in the controller (scopeFilter, spread last). Note the
 * consequence documented there: rows with `branch: null` — changes to
 * business-wide masters like menus, plans and website copy — are visible to a
 * super admin only.
 */

const auditRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/audit-log", "read"),
];

/**
 * @swagger
 * /audit-logs-by-params:
 *   post:
 *     summary: Paged audit trail
 *     tags: [Audit Log]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               skip: { type: integer }
 *               per_page: { type: integer, maximum: 200 }
 *               sorton: { type: string }
 *               sortdir: { type: string, enum: [asc, desc] }
 *               match: { type: string, description: Free text over actor, collection, label and path }
 *               action: { type: string, enum: [CREATE, UPDATE, DELETE, CREATE_MANY, UPDATE_MANY, DELETE_MANY] }
 *               collectionName: { type: string }
 *               documentId: { type: string }
 *               actorId: { type: string }
 *               fromDate: { type: string, format: date }
 *               toDate: { type: string, format: date }
 *               branch: { type: string, description: Super admin only; ignored for a branch admin }
 *     responses:
 *       200:
 *         description: Audit rows, newest first, scoped to the caller's branch
 */
router.post("/audit-logs-by-params", ...auditRead, listAuditLogsByParams);

/**
 * @swagger
 * /audit-logs-filters:
 *   get:
 *     summary: Distinct collections, actions and actors for the viewer's dropdowns
 *     tags: [Audit Log]
 *     responses:
 *       200:
 *         description: Scoped the same way as the list
 */
// Spelled "/audit-logs-filters", not "/audit-logs/filters", so it is a
// DIFFERENT path shape from /audit-logs/:id rather than a literal competing
// with a param segment. The param route would otherwise match "filters" as an
// id — the classic shadowing bug — and the fix would depend on registration
// order staying exactly as written.
router.get("/audit-logs-filters", ...auditRead, getAuditLogFilters);

/**
 * @swagger
 * /audit-logs/{id}:
 *   get:
 *     summary: One audit entry with its full before/after diff
 *     tags: [Audit Log]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The entry
 *       404:
 *         description: >
 *           Not found, or outside the caller's branch — an id is not an
 *           authorisation, so the two are deliberately indistinguishable.
 */
router.get("/audit-logs/:id", ...auditRead, getAuditLogById);

export default router;
