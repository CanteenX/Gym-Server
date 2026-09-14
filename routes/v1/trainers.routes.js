import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
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
 * checkPermission IS applied, as of 2026-09-14. See members.routes.js for the
 * full account of why the "not applied yet" note that used to sit here had
 * expired: the menu row is seeded and active, and leaving it ungated meant
 * any signed-in staff account could hire, edit and delete trainers in its own
 * branch whatever its role said. Measured live as the front desk.
 *
 * The desk holds `read` here and nothing more. Nobody asked the front desk to
 * hire, and assigning members to a trainer is `edit` rather than `write`
 * because it changes an existing trainer rather than creating one.
 *
 * The GET reads are deliberately left alone rather than swept along: they are
 * already behind staff auth and branch scoping, gating them closes no write
 * hole, and each one is a chance to 403 a screen that was working.
 */
router.get(
  "/trainers-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllTrainers,
);
router.post(
  "/trainers-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "read"),
  listTrainersByParams,
);
router.post(
  "/trainers-unassigned-members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "read"),
  listUnassignedMembers,
);
router.post(
  "/trainers",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "write"),
  createTrainer,
);
router.put(
  "/trainers/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "edit"),
  updateTrainer,
);
router.delete(
  "/trainers/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "delete"),
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
  checkPermission("/trainers", "edit"),
  assignMembers,
);
router.delete(
  "/trainers/:id/members/:memberId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/trainers", "edit"),
  unassignMember,
);

export default router;
