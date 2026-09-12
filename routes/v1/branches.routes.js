import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  listBranches,
  listBranchesByParams,
  getBranchById,
  createBranch,
  updateBranch,
  deactivateBranch,
  deleteBranch,
} from "../../controllers/v1/branch.controller.js";

const router = express.Router();

/**
 * Staff-side Branch Master. Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other masters.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 *
 * NOTE: there is no real delete. DELETE is wired only so the standard master
 * table gets a clear 400 explaining that branches are deactivated instead.
 */
router.get("/branches-list", authMiddleware(["ADMIN", "EMPLOYEE"]), listBranches);
router.post(
  "/branches-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listBranchesByParams,
);
router.post("/branches", authMiddleware(["ADMIN", "EMPLOYEE"]), createBranch);
router.get("/branches/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), getBranchById);
router.put("/branches/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), updateBranch);
router.put(
  "/branches/:id/deactivate",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deactivateBranch,
);
router.delete(
  "/branches/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteBranch,
);

export default router;
