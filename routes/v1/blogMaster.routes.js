import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
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
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

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

router.post("/blogs", upload.single("featuredImage"), createBlog);
router.put("/blogs/:id", upload.single("featuredImage"), updateBlog);
router.get("/blogs/:id", getBlogById);
router.delete("/blogs/:id", deleteBlog);
router.patch("/blogs/:id/status", toggleBlogStatus);
router.post("/blogs-by-params", listBlogsByParams);
router.get("/blogs-stats", getBlogStats);

export default router;
