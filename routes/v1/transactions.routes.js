import express from "express";
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

router.get("/transactions-summary", getCashFlowSummary);
router.post("/transactions-by-params", listTransactionsByParams);
router.post("/transactions-income", recordIncome);
router.post("/transactions-expense", recordExpense);
router.get("/transactions/:id/receipt", getReceipt);
router.put("/transactions/:id", updateTransaction);
router.delete("/transactions/:id", deleteTransaction);

export default router;
