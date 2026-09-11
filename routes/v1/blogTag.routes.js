import express from "express";
import {
  createBlogTag,
  updateBlogTag,
  deleteBlogTag,
  listAllBlogTags,
  listBlogTagsByParams,
} from "../../controllers/v1/blogTag.controller.js";

const router = express.Router();

router.post("/blog-tags", createBlogTag);
router.put("/blog-tags/:id", updateBlogTag);
router.delete("/blog-tags/:id", deleteBlogTag);
router.get("/blog-tags-list", listAllBlogTags);
router.post("/blog-tags-by-params", listBlogTagsByParams);

export default router;
