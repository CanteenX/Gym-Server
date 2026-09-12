import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createBlogCategory,
  updateBlogCategory,
  getBlogCategoryById,
  deleteBlogCategory,
  listAllBlogCategories,
  listBlogCategoriesByParams,
} from "../../controllers/v1/blogCategory.controller.js";

const router = express.Router();

/**
 * Staff-side Blog Category master (CMS). Every route requires an authenticated
 * staff session (ADMIN or EMPLOYEE), applied per-route to match the other
 * masters.
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
router.post(
  "/blog-categories",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  createBlogCategory,
);
router.put(
  "/blog-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateBlogCategory,
);
router.get(
  "/blog-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getBlogCategoryById,
);
router.delete(
  "/blog-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteBlogCategory,
);
router.get(
  "/blog-categories-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllBlogCategories,
);
router.post(
  "/blog-categories-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listBlogCategoriesByParams,
);

export default router;
