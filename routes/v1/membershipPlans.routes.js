import express from "express";
import {
  createPlan,
  updatePlan,
  deletePlan,
  listAllPlans,
  listPlansByParams,
} from "../../controllers/v1/membershipPlan.controller.js";

const router = express.Router();

router.get("/membership-plans-list", listAllPlans);
router.post("/membership-plans-by-params", listPlansByParams);
router.post("/membership-plans", createPlan);
router.put("/membership-plans/:id", updatePlan);
router.delete("/membership-plans/:id", deletePlan);

export default router;
