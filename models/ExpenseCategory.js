import mongoose from "mongoose";

/**
 * Editable expense categories, managed from Master → Expense Categories.
 *
 * Seeded with a sensible gym set, but editable so the categories match how this
 * business actually thinks about its costs. Expense rows store the category
 * NAME rather than a reference, so a category can be deactivated without
 * orphaning historical ledger entries.
 */
const ExpenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    sequence: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

ExpenseCategorySchema.index({ isActive: 1, sequence: 1 });

/** Seed set — the usual running costs of a two-branch gym. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: "Rent", sequence: 1 },
  { name: "Trainer Salary", sequence: 2 },
  { name: "Staff Salary", sequence: 3 },
  { name: "Electricity", sequence: 4 },
  { name: "Water", sequence: 5 },
  { name: "Equipment Purchase", sequence: 6 },
  { name: "Equipment Repair", sequence: 7 },
  { name: "Cleaning & Housekeeping", sequence: 8 },
  { name: "Marketing", sequence: 9 },
  { name: "Miscellaneous", sequence: 10 },
];

export default mongoose.model("ExpenseCategory", ExpenseCategorySchema);
