import express from "express";
import {
  createFaqCategory,
  updateFaqCategory,
  deleteFaqCategory,
  listAllFaqCategories,
  listFaqCategoriesByParams,
} from "../../controllers/v1/faqCategory.controller.js";

const router = express.Router();

router.post("/faq-categories", createFaqCategory);
router.put("/faq-categories/:id", updateFaqCategory);
router.delete("/faq-categories/:id", deleteFaqCategory);
router.get("/faq-categories-list", listAllFaqCategories);
router.post("/faq-categories-by-params", listFaqCategoriesByParams);

export default router;
