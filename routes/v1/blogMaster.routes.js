import express from "express";
import multer from "multer";
import path from "node:path";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { ensureLocalDir } from "../../config/runtime.js";
import {
  createBlog,
  updateBlog,
  getBlogById,
  deleteBlog,
  toggleBlogStatus,
  listBlogsByParams,
  getBlogStats,
} from "../../controllers/v1/blogMaster.controller.js";

const router = express.Router();

const uploadDir = "uploads/blogs";
ensureLocalDir(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `blog-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

/**
 * Staff-side Blog Master (CMS). Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE), applied per-route to match the other masters.
 *
 * Auth runs BEFORE `upload` so an unauthenticated request is rejected before
 * multer writes any file to disk.
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
  "/blogs",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  upload.single("featuredImage"),
  createBlog,
);
router.put(
  "/blogs/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  upload.single("featuredImage"),
  updateBlog,
);
router.get("/blogs/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), getBlogById);
router.delete("/blogs/:id", authMiddleware(["ADMIN", "EMPLOYEE"]), deleteBlog);
router.patch(
  "/blogs/:id/status",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  toggleBlogStatus,
);
router.post(
  "/blogs-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listBlogsByParams,
);
router.get("/blogs-stats", authMiddleware(["ADMIN", "EMPLOYEE"]), getBlogStats);

export default router;
