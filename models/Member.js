import mongoose from "mongoose";

/**
 * A single payment against a membership. Kept as a subdocument so a member's
 * full payment history travels with the record and the outstanding balance can
 * be derived without a second query.
 */
const PaymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    paidOn: {
      type: Date,
      required: true,
      default: Date.now,
    },
    mode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank Transfer", "Other"],
      default: "Cash",
    },
    receiptNo: {
      type: String,
      trim: true,
      default: "",
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

/** Plan catalogue. `months` drives the auto-calculated end date. */
export const MEMBERSHIP_PLANS = [
  { code: "MONTHLY", label: "Monthly", months: 1, defaultFee: 1200 },
  { code: "QUARTERLY", label: "Quarterly", months: 3, defaultFee: 3000 },
  { code: "HALF_YEARLY", label: "Half Yearly", months: 6, defaultFee: 5000 },
  { code: "ANNUAL_12_2", label: "12 + 2 Months", months: 14, defaultFee: 6500 },
  {
    code: "PERSONAL_TRAINING",
    label: "Personal Training",
    months: 1,
    defaultFee: 5000,
  },
];

const MemberSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", ""],
      default: "",
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    emergencyContactName: {
      type: String,
      trim: true,
      default: "",
    },
    emergencyContactNumber: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    branch: {
      type: String,
      enum: ["Vasna", "Gotri"],
      default: "Vasna",
    },

    // The single source of truth for the trainer↔member relationship. The
    // trainer's roster is derived from this field, never stored separately.
    trainerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trainer",
      default: null,
    },

    // ===== Membership period =====
    planCode: {
      type: String,
      enum: MEMBERSHIP_PLANS.map((p) => p.code),
      required: true,
      default: "MONTHLY",
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },

    // ===== Money =====
    // totalFee is what the member owes for the current period; the paid amount
    // is derived from `payments` so the two can never drift apart.
    totalFee: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    payments: {
      type: [PaymentSchema],
      default: [],
    },

    // ===== Files =====
    photo: {
      type: String,
      trim: true,
      default: "",
    },
    idProof: {
      type: String,
      trim: true,
      default: "",
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// The dashboard queries by expiry window and active flag constantly.
MemberSchema.index({ endDate: 1, isActive: 1 });
MemberSchema.index({ trainerId: 1 });
MemberSchema.index({ mobileNumber: 1 }, { unique: true });

/** Total actually received for the current membership period. */
MemberSchema.virtual("paidAmount").get(function () {
  return (this.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
});

/** What the member still owes. Never negative. */
MemberSchema.virtual("balanceAmount").get(function () {
  return Math.max(0, (this.totalFee || 0) - this.paidAmount);
});

MemberSchema.set("toJSON", { virtuals: true });
MemberSchema.set("toObject", { virtuals: true });

export default mongoose.model("Member", MemberSchema);
