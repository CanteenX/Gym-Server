import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createFaqCategory,
  updateFaqCategory,
  deleteFaqCategory,
  listAllFaqCategories,
  listFaqCategoriesByParams,
} from "../../controllers/v1/faqCategory.controller.js";

const router = express.Router();

/**
 * Staff-side FAQ Category master (CMS). Every route requires an authenticated
 * staff session (ADMIN or EMPLOYEE), applied per-route to match the other
 * masters.
 *
 * There is no public consumer of these endpoints: the marketing site's FAQ
 * accordion renders from a static array in its own source, not from this API,
 * and the member portal authenticates with a member bearer token.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.post(
  "/faq-categories",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  createFaqCategory,
);
router.put(
  "/faq-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateFaqCategory,
);
router.delete(
  "/faq-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteFaqCategory,
);
router.get(
  "/faq-categories-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllFaqCategories,
);
router.post(
  "/faq-categories-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listFaqCategoriesByParams,
);

export default router;
