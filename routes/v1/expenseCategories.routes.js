import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  listAllExpenseCategories,
  listExpenseCategoriesByParams,
} from "../../controllers/v1/expenseCategory.controller.js";

const router = express.Router();

/**
 * Staff-side expense category management. Every route requires an
 * authenticated staff session (ADMIN or EMPLOYEE).
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/expense-categories-list",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listAllExpenseCategories,
);
router.post(
  "/expense-categories-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listExpenseCategoriesByParams,
);
router.post(
  "/expense-categories",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  createExpenseCategory,
);
router.put(
  "/expense-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateExpenseCategory,
);
router.delete(
  "/expense-categories/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteExpenseCategory,
);

export default router;
