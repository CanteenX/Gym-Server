import express from "express";
import {
  checkIn,
  checkOut,
  getToday,
  listAttendance,
  updateSessionLength,
} from "../../controllers/v1/attendance.controller.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";

const router = express.Router();

/**
 * Member-portal attendance.
 *
 * Every route is behind requireMember — a check-in is a claim about where a
 * person physically is, so the member must be identified by their token and
 * never by a path or body param.
 */
router.post("/member-portal/attendance/check-in", requireMember, checkIn);
router.post("/member-portal/attendance/check-out", requireMember, checkOut);
router.get("/member-portal/attendance/today", requireMember, getToday);
router.get("/member-portal/attendance", requireMember, listAttendance);

// Lives here rather than with the auth profile routes because the only thing
// this setting affects is the attendance auto-close.
router.put("/member-portal/session-length", requireMember, updateSessionLength);

export default router;
