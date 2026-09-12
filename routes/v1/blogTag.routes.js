import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createBlogTag,
  updateBlogTag,
  deleteBlogTag,
  listAllBlogTags,
  listBlogTagsByParams,
} from "../../controllers/v1/blogTag.controller.js";

const router = express.Router();

/**
 * Staff-side Blog Tag master (CMS). Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other masters.
 *
 * There is no public consumer of these endpoints: the marketing site renders
 * its content from static constants and the member portal authenticates with a
 * member bearer token, so nothing here needs to stay open.
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.post("/blog-tags", authMiddleware(["ADMIN", "EMPLOYEE"]), createBlogTag);
router.put(
  "/blog-tags/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateBlogTag,
);
router.delete(
  "/blog-tags/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteBlogTag,
);
router.get(
  "/blog-tags-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllBlogTags,
);
router.post(
  "/blog-tags-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listBlogTagsByParams,
);

export default router;
