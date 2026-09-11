import express from "express";
import {
  recordWeight,
  listWeights,
  deleteWeight,
} from "../../controllers/v1/bodyMetrics.controller.js";
import { requireMember } from "../../controllers/v1/memberAuth.controller.js";

const router = express.Router();

/**
 * Member-portal body metrics.
 *
 * Every route is behind requireMember — these are the member's own records,
 * and the member is identified by the token, never by a path or body param.
 */
router.post("/member-portal/weight", requireMember, recordWeight);
router.get("/member-portal/weight", requireMember, listWeights);
router.delete("/member-portal/weight/:id", requireMember, deleteWeight);

export default router;
