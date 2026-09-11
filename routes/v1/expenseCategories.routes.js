import express from "express";
import {
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  listAllExpenseCategories,
  listExpenseCategoriesByParams,
} from "../../controllers/v1/expenseCategory.controller.js";

const router = express.Router();

router.get("/expense-categories-list", listAllExpenseCategories);
router.post("/expense-categories-by-params", listExpenseCategoriesByParams);
router.post("/expense-categories", createExpenseCategory);
router.put("/expense-categories/:id", updateExpenseCategory);
router.delete("/expense-categories/:id", deleteExpenseCategory);

export default router;
