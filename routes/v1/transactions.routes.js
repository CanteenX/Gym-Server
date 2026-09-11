import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import {
  recordIncome,
  recordExpense,
  updateTransaction,
  deleteTransaction,
  listTransactionsByParams,
  getCashFlowSummary,
  getReceipt,
} from "../../controllers/v1/transaction.controller.js";

const router = express.Router();

/**
 * Staff-side transactions. Every route requires an authenticated staff
 * session (ADMIN or EMPLOYEE).
 *
 * checkPermission is deliberately NOT applied yet — it resolves a menu by URL
 * and 403s when the menu row is missing from MenuMaster, which would break
 * screens whose menuUrl is not registered. Per-menu authorization is a
 * separate, later change.
 */
router.get(
  "/transactions-summary",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getCashFlowSummary,
);
router.post(
  "/transactions-by-params",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  listTransactionsByParams,
);
router.post(
  "/transactions-income",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  recordIncome,
);
router.post(
  "/transactions-expense",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  recordExpense,
);
router.get(
  "/transactions/:id/receipt",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getReceipt,
);
router.put(
  "/transactions/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  updateTransaction,
);
router.delete(
  "/transactions/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  deleteTransaction,
);

export default router;
