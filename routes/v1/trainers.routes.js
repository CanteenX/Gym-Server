import express from "express";
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

router.get("/trainers-list", listAllTrainers);
router.post("/trainers-by-params", listTrainersByParams);
router.post("/trainers-unassigned-members", listUnassignedMembers);
router.post("/trainers", createTrainer);
router.put("/trainers/:id", updateTrainer);
router.delete("/trainers/:id", deleteTrainer);
router.get("/trainers/:id/members", getTrainerMembers);
router.post("/trainers/:id/assign-members", assignMembers);
router.delete("/trainers/:id/members/:memberId", unassignMember);

export default router;
