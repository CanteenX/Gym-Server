import mongoose from "mongoose";

/**
 * Branch Master.
 *
 * Replaces the hardcoded `enum: ["Vasna", "Gotri"]` that used to sit on the
 * `branch` field of Member, Trainer, Attendance, Employee and Transaction.
 * Opening a third gym previously meant editing five schemas; now it is a row
 * in this collection.
 *
 * IMPORTANT — BRANCH IS STILL STORED AS A STRING ON THOSE MODELS.
 * This master is deliberately NOT a foreign key. Member.branch, Trainer.branch,
 * Transaction.branch, Attendance.branch and Employee.branch all keep their
 * plain "Vasna"/"Gotri" string exactly as written. Only the enum constraint was
 * removed. That means:
 *   - zero migration: every historical record is already correct;
 *   - middlewares/branchScope.js keeps working untouched, because it compares
 *     `req.session.user.branch` (a string) against `branch` (a string);
 *   - this collection is the source of truth for DROPDOWNS, not for joins.
 */
const BranchSchema = new mongoose.Schema(
  {
    /**
     * The branch name, e.g. "Vasna".
     *
     * This is not a label — it IS the key. The exact characters here are what
     * gets written into Member.branch, Transaction.branch, and so on. Because
     * those are stored as strings rather than references, renaming a branch
     * here would orphan every record still carrying the old spelling, so the
     * controller refuses a rename once ANY record references the name. It is
     * deliberately not casually editable free text; a genuine rename needs a
     * bulk update across all five collections.
     */
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    /** Optional longer label for the UI, e.g. "Vasna Branch". Cosmetic only. */
    displayName: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Whether this row is a real gym with a floor, or a bookkeeping bucket.
     *
     * `false` applies to exactly one row today: "Common". "Common" is not a
     * gym — it is where costs that belong to the business rather than to
     * either floor are parked: shared rent, software subscriptions, the
     * accountant, the owner's own salary. Splitting those arbitrarily across
     * the physical branches would distort each branch's profit, so they sit in
     * their own bucket (see the comment on Transaction.branch).
     *
     * CONSEQUENCES OF isPhysical: false — a non-physical branch:
     *   - can NEVER have members, trainers or staff assigned to it. Nobody
     *     trains at "Common" and nobody is employed there.
     *   - MUST be excluded from the member / trainer / employee branch
     *     pickers. Call `GET /branches-list?physicalOnly=true` for those
     *     screens; the plain list (which includes Common) is for expense and
     *     transaction pickers only.
     * Treat this flag as the single switch that decides which pickers a branch
     * appears in, rather than special-casing the literal string "Common"
     * anywhere in the UI.
     */
    isPhysical: {
      type: Boolean,
      default: true,
    },
    /** Optional — handy for printing a branch address on a receipt. */
    address: {
      type: String,
      trim: true,
      default: "",
    },
    /** Optional — contact number, also useful on receipts. */
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    /** Dropdown ordering. "Common" is seeded at 99 so it sorts last. */
    sequence: {
      type: Number,
      default: 0,
    },
    /**
     * Branches are DEACTIVATED, never deleted.
     *
     * There is no delete endpoint by design. Because branch is stored as a
     * string on members, trainers, attendance, staff and every past receipt,
     * removing the master row would not remove those strings — it would just
     * leave records pointing at a branch that no longer exists in any
     * dropdown, and reports/receipts referencing a name nothing can explain.
     * Deactivating hides a closed branch from new entry while every historical
     * record keeps its meaning.
     */
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// `name` is the value matched against in every branch-bearing collection and
// the field the uniqueness check reads, so it is indexed — via `unique: true`
// on the field above, which already creates that index. Declaring
// `.index({ name: 1 })` here as well would be the same index twice and makes
// Mongoose log a duplicate-index warning on boot.

// Dropdowns always read branches in display order.
BranchSchema.index({ isActive: 1, sequence: 1 });

/** Seed set — the two gyms plus the shared-cost bucket. */
export const DEFAULT_BRANCHES = [
  { name: "Vasna", displayName: "Vasna Branch", sequence: 1, isPhysical: true },
  { name: "Gotri", displayName: "Gotri Branch", sequence: 2, isPhysical: true },
  {
    name: "Common",
    displayName: "Common / Shared Costs",
    sequence: 99,
    isPhysical: false,
  },
];

export default mongoose.model("Branch", BranchSchema);
