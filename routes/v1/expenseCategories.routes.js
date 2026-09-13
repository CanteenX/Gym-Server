import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
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
 * checkPermission IS NOW APPLIED — the /expense-categories menu row exists
 * and is active, which is the precondition that had deferred it.
 *
 * Branch Staff hold no financial menu, yet this endpoint was serving them the
 * full category list. The list is read-only detail about how a branch spends
 * money; it belongs behind the same grant as the ledger it categorises.
 */
const expenseRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/expense-categories", "read"),
];
const expenseWrite = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/expense-categories", "write"),
];
const expenseEdit = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/expense-categories", "edit"),
];
const expenseDelete = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/expense-categories", "delete"),
];
router.get(
  "/expense-categories-list",
  ...expenseRead,
  listAllExpenseCategories,
);
router.post(
  "/expense-categories-by-params",
  ...expenseRead,
  listExpenseCategoriesByParams,
);
router.post(
  "/expense-categories",
  ...expenseWrite,
  createExpenseCategory,
);
router.put(
  "/expense-categories/:id",
  ...expenseEdit,
  updateExpenseCategory,
);
router.delete(
  "/expense-categories/:id",
  ...expenseDelete,
  deleteExpenseCategory,
);

export default router;
