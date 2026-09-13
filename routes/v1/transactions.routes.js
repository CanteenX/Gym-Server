import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
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
 * checkPermission IS NOW APPLIED. It was deferred because it resolves a menu
 * BY URL and 403s when the row is missing from MenuMaster; the /cash-flow row
 * now exists and is active, so the precondition that blocked it is met.
 *
 * The gap this closes was measured, not theoretical: a Branch Staff account
 * holds no financial menu at all, yet POST /transactions-by-params returned
 * the branch's entire ledger and /transactions-summary its totals. The sidebar
 * hid Cash Flow while the API served it to anyone with a session — a hidden
 * screen is not an access control.
 *
 * Read and write are separated on purpose. Recording income or an expense, or
 * editing and cancelling a ledger row, is a different act from reading a
 * number, and `delete` is its own flag so cancelling a transaction cannot ride
 * in on an edit grant.
 */
const ledgerRead = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/cash-flow", "read"),
];
const ledgerWrite = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/cash-flow", "write"),
];
const ledgerEdit = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/cash-flow", "edit"),
];
const ledgerDelete = [
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/cash-flow", "delete"),
];
router.get(
  "/transactions-summary",
  ...ledgerRead,
  getCashFlowSummary,
);
router.post(
  "/transactions-by-params",
  ...ledgerRead,
  listTransactionsByParams,
);
router.post(
  "/transactions-income",
  ...ledgerWrite,
  recordIncome,
);
router.post(
  "/transactions-expense",
  ...ledgerWrite,
  recordExpense,
);
router.get(
  "/transactions/:id/receipt",
  ...ledgerRead,
  getReceipt,
);
router.put(
  "/transactions/:id",
  ...ledgerEdit,
  updateTransaction,
);
router.delete(
  "/transactions/:id",
  ...ledgerDelete,
  deleteTransaction,
);

export default router;
