import express from "express";
import {
  createBlogCategory,
  updateBlogCategory,
  getBlogCategoryById,
  deleteBlogCategory,
  listAllBlogCategories,
  listBlogCategoriesByParams,
} from "../../controllers/v1/blogCategory.controller.js";

const router = express.Router();

router.post("/blog-categories", createBlogCategory);
router.put("/blog-categories/:id", updateBlogCategory);
router.get("/blog-categories/:id", getBlogCategoryById);
router.delete("/blog-categories/:id", deleteBlogCategory);
router.get("/blog-categories-list", listAllBlogCategories);
router.post("/blog-categories-by-params", listBlogCategoriesByParams);

export default router;
