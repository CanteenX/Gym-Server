import mongoose from "mongoose";

/**
 * The durable cash-flow ledger.
 *
 * WHY THIS EXISTS SEPARATELY FROM Member.payments:
 * a member's `payments` array is the CURRENT PERIOD balance and is deliberately
 * cleared on renewal. That makes it useless as a financial record — the moment
 * someone renews, their history would vanish from any report. This collection
 * is append-only in spirit: nothing in the app clears it, so monthly totals and
 * charts stay correct forever.
 *
 * Both incoming (member fees) and outgoing (expenses) rows live here, separated
 * by `direction`, so a single query can produce a net cash-flow view.
 */
const TransactionSchema = new mongoose.Schema(
  {
    direction: {
      type: String,
      enum: ["IN", "OUT"],
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    /** When the money actually moved — not when the row was created. */
    transactionDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },

    mode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank Transfer", "Cheque", "Other"],
      default: "Cash",
    },

    /**
     * Which branch the money belongs to.
     *
     * "Common" is for costs that belong to the business rather than to either
     * floor — shared rent, software, the accountant, the owner's own salary.
     * Splitting those arbitrarily across two branches would distort each
     * branch's profit, so they sit in their own bucket: visible to a super
     * admin, excluded from a single branch's P&L.
     *
     * Income is never "Common" — a member pays at a branch. Only expenses use it.
     *
     * The enum moved to the Branch master (models/Branch.js) so opening a
     * third gym is a data change, not a schema change; "Common" is now a row
     * there flagged isPhysical: false. Still a STRING, not a branchId
     * reference: every historical receipt keeps its "Vasna"/"Gotri"/"Common"
     * value untouched, which is what keeps past P&L reports stable.
     * Transaction/expense pickers read the FULL branch list (no
     * physicalOnly filter) so "Common" stays selectable for shared costs.
     */
    branch: {
      type: String,
      default: "Vasna",
      index: true,
    },

    // ===== Incoming only =====
    /**
     * Sequential receipt number, e.g. MCG/2026-27/00001. INCOME ROWS ONLY.
     *
     * No `default` on purpose: an empty-string default would make every expense
     * row store "", and a unique index treats each "" as a real value — so the
     * second expense would collide with the first. Leaving it undefined keeps
     * expenses out of the index entirely.
     */
    receiptNo: {
      type: String,
      trim: true,
    },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
    /**
     * Denormalised so a receipt still prints correctly if the member is later
     * renamed or deleted — a financial record must not change retroactively.
     */
    memberName: {
      type: String,
      trim: true,
      default: "",
    },
    memberMobile: {
      type: String,
      trim: true,
      default: "",
    },
    planCode: {
      type: String,
      trim: true,
      default: "",
    },
    /** What the payment covers, for the receipt body. */
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    // ===== Outgoing only =====
    category: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    paidTo: {
      type: String,
      trim: true,
      default: "",
    },
    billNo: {
      type: String,
      trim: true,
      default: "",
    },

    // ===== Common =====
    note: {
      type: String,
      trim: true,
      default: "",
    },
    /** Where the row came from: manual entry, a member payment, or a renewal. */
    source: {
      type: String,
      enum: ["MANUAL", "MEMBER_PAYMENT", "MEMBER_RENEWAL", "MEMBER_JOINING"],
      default: "MANUAL",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// The reports page always filters by a date window, usually with a direction.
TransactionSchema.index({ transactionDate: -1, direction: 1 });

/**
 * Receipt numbers must be unique, but only where one actually exists.
 *
 * A partial index is used rather than `sparse`, because sparse only skips
 * documents MISSING the field — it still indexes empty strings, which is how
 * expense rows previously collided with each other. The partial filter makes
 * the rule explicit: enforce uniqueness on non-empty receipt numbers only.
 */
TransactionSchema.index(
  { receiptNo: 1 },
  {
    unique: true,
    partialFilterExpression: {
      receiptNo: { $exists: true, $gt: "" },
    },
  },
);

export default mongoose.model("Transaction", TransactionSchema);
