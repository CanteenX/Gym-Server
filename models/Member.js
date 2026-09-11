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

/**
 * Seed constant only — the live plan catalogue is the MembershipPlan collection
 * (models/MembershipPlan.js), managed from Master → Membership Plans. This array
 * is kept solely so scripts/seedMembershipPlans.js can bootstrap the original
 * five plans into that collection. Nothing at runtime should read it.
 */
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
    // No enum: plan codes are defined dynamically in the MembershipPlan master,
    // so any code that master holds is valid here.
    planCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
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

    /**
     * Optional custom portal login ID — an email, a nickname, anything the
     * front desk prefers. When blank the member signs in with their mobile
     * number, which is why this is nullable rather than required: existing
     * members keep working untouched.
     */
    loginId: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    // ===== Member portal login =====
    // Deliberately separate from the admin's CompanyMaster/Employee auth: that
    // system uses session cookies and locks an account after 3 failed attempts,
    // which would turn a forgotten password mid-workout into a support call.
    // Members authenticate with JWT against these fields instead.
    passwordHash: {
      type: String,
      default: "",
      // Never sent to a client — stripped in toJSON below.
      select: false,
    },
    /** Staff set the first password; the member is forced to change it. */
    mustChangePassword: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },

    /** Needed to compute BMI alongside the logged weight. */
    heightCm: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  { timestamps: true },
);

// The dashboard queries by expiry window and active flag constantly.
MemberSchema.index({ endDate: 1, isActive: 1 });
MemberSchema.index({ trainerId: 1 });
MemberSchema.index({ mobileNumber: 1 }, { unique: true });

// Unique only among members who actually have a custom ID. A plain unique
// index would treat every null as a value and reject the second member without
// one — the same trap the receipt-number index fell into.
MemberSchema.index(
  { loginId: 1 },
  {
    unique: true,
    partialFilterExpression: { loginId: { $type: "string" } },
  },
);

/** Total actually received for the current membership period. */
MemberSchema.virtual("paidAmount").get(function () {
  return (this.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
});

/** What the member still owes. Never negative. */
MemberSchema.virtual("balanceAmount").get(function () {
  return Math.max(0, (this.totalFee || 0) - this.paidAmount);
});

/**
 * Whether portal credentials exist for this member.
 *
 * Stored rather than derived: `passwordHash` is `select: false`, so any normal
 * query leaves it undefined and a virtual reading it would always report false
 * — silently telling staff "no access" for members who can in fact log in.
 * Kept in step by the pre-save hook below.
 */
MemberSchema.add({
  hasPortalAccess: {
    type: Boolean,
    default: false,
  },
});

MemberSchema.pre("save", function (next) {
  if (this.isModified("passwordHash")) {
    this.hasPortalAccess = Boolean(this.passwordHash);
  }
  next();
});

// Belt and braces: even if a query explicitly selects passwordHash, it must
// never survive serialisation to a client.
const stripSecrets = (_doc, ret) => {
  delete ret.passwordHash;
  return ret;
};

MemberSchema.set("toJSON", { virtuals: true, transform: stripSecrets });
MemberSchema.set("toObject", { virtuals: true, transform: stripSecrets });

export default mongoose.model("Member", MemberSchema);
