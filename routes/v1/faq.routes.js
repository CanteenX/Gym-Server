import express from "express";
import {
  createFaq,
  updateFaq,
  deleteFaq,
  listFaqsByParams,
} from "../../controllers/v1/faq.controller.js";

const router = express.Router();

router.post("/faqs", createFaq);
router.put("/faqs/:id", updateFaq);
router.delete("/faqs/:id", deleteFaq);
router.post("/faqs-by-params", listFaqsByParams);

export default router;
