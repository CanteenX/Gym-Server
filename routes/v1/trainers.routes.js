import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createTrainer,
  updateTrainer,
  deleteTrainer,
  listAllTrainers,
  listTrainersByParams,
  getTrainerMembers,
  assignMembers,
  unassignMember,
  listUnassignedMembers,
} from "../../controllers/v1/trainer.controller.js";

const router = express.Router();

/**
 * Staff-side trainer management. Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE).
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/trainers-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllTrainers,
);
router.post(
  "/trainers-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listTrainersByParams,
);
router.post(
  "/trainers-unassigned-members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listUnassignedMembers,
);
router.post("/trainers", authMiddleware(["ADMIN", "EMPLOYEE"]), createTrainer);
router.put(
  "/trainers/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateTrainer,
);
router.delete(
  "/trainers/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteTrainer,
);
router.get(
  "/trainers/:id/members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getTrainerMembers,
);
router.post(
  "/trainers/:id/assign-members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  assignMembers,
);
router.delete(
  "/trainers/:id/members/:memberId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  unassignMember,
);

export default router;
