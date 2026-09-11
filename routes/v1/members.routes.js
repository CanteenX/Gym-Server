import express from "express";
import {
  createMember,
  updateMember,
  deleteMember,
  getMemberById,
  listMembersByParams,
  getMemberDashboardStats,
  getMemberPlans,
  renewMembership,
  addPayment,
} from "../../controllers/v1/member.controller.js";

const router = express.Router();

router.get("/member-plans", getMemberPlans);
router.get("/members-dashboard-stats", getMemberDashboardStats);
router.post("/members-by-params", listMembersByParams);
router.post("/members", createMember);
router.get("/members/:id", getMemberById);
router.put("/members/:id", updateMember);
router.delete("/members/:id", deleteMember);
router.post("/members/:id/renew", renewMembership);
router.post("/members/:id/payments", addPayment);

export default router;
