import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createPlan,
  updatePlan,
  deletePlan,
  listAllPlans,
  listPlansByParams,
} from "../../controllers/v1/membershipPlan.controller.js";

const router = express.Router();

/**
 * Staff-side membership plan management. Every route requires an authenticated
 * staff session (ADMIN or EMPLOYEE).
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/membership-plans-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllPlans,
);
router.post(
  "/membership-plans-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listPlansByParams,
);
router.post(
  "/membership-plans",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  createPlan,
);
router.put(
  "/membership-plans/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updatePlan,
);
router.delete(
  "/membership-plans/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deletePlan,
);

export default router;
