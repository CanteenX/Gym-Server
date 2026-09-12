import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createFaq,
  updateFaq,
  deleteFaq,
  listFaqsByParams,
} from "../../controllers/v1/faq.controller.js";

const router = express.Router();

/**
 * Staff-side FAQ master (CMS). Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other masters.
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
router.post("/faqs", authMiddleware(["ADMIN", "EMPLOYEE"]), createFaq);
router.put("/faqs/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), updateFaq);
router.delete("/faqs/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), deleteFaq);
router.post(
  "/faqs-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listFaqsByParams,
);

export default router;
