import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";
import {
  getMyPlan,
  getTodayLog,
  listWorkoutLogs,
  saveLog,
  listWorkoutPlans,
  getWorkoutPlanById,
  createWorkoutPlan,
  updateWorkoutPlan,
  deleteWorkoutPlan,
  assignMemberWorkoutPlan,
} from "../../controllers/v1/workout.controller.js";

const router = express.Router();

/**
 * Member-portal workout routes.
 *
 * Behind requireMember — a log is a claim about what a specific person lifted,
 * so the member is identified by their token and never by a path or body param.
 */
router.get("/member-portal/workout/plan", requireMember, getMyPlan);
router.get("/member-portal/workout/today", requireMember, getTodayLog);
// Ranged sibling of /today: feeds the attendance calendar's per-day exercise
// icons, so it takes the same month / from-to parameters as the attendance list.
router.get("/member-portal/workout/logs", requireMember, listWorkoutLogs);
router.post("/member-portal/workout/log", requireMember, saveLog);

/**
 * Staff-side plan management. Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other gym routes.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/workout-plans",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listWorkoutPlans,
);
router.get(
  "/workout-plans/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getWorkoutPlanById,
);
router.post(
  "/workout-plans",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  createWorkoutPlan,
);
router.put(
  "/workout-plans/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateWorkoutPlan,
);
router.delete(
  "/workout-plans/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteWorkoutPlan,
);

// Lives here rather than in members.routes.js because the thing being edited is
// the workout assignment, not the member's profile.
router.put(
  "/members/:id/workout-plan",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  assignMemberWorkoutPlan,
);

export default router;
