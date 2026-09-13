import mongoose from "mongoose";

/**
 * A gym trainer. Deliberately minimal — name, contact, branch.
 *
 * NOTE ON THE RELATIONSHIP: a trainer does NOT hold a list of its members.
 * The link lives in exactly one place, `Member.trainerId`, and a trainer's
 * roster is derived by querying members. Storing both sides would let the two
 * copies disagree, which is a permanent source of reconciliation bugs.
 */
const TrainerSchema = new mongoose.Schema(
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
    // The enum moved to the Branch master (models/Branch.js) so opening a third
    // gym is a data change, not a schema change. Still a STRING, not a
    // branchId reference: existing trainers keep their "Vasna"/"Gotri" value
    // untouched and branchScope.js compares it literally. Trainer pickers must
    // read physical branches only (?physicalOnly=true).
    branch: {
      type: String,
      default: "Vasna",
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

    // ========================================================================
    // ===== Portal login (Phase 3 / plan.md D4) ==============================
    // ========================================================================
    // A trainer had no credentials and no auth route at all, so there was
    // nothing for an Attendance row with subjectType: "TRAINER" to attach to.
    // These fields MIRROR Member's deliberately — same names, same semantics,
    // same select:false on the hash — so one login handler and one guard serve
    // both, and a reader who knows one knows the other.
    //
    // Still the MEMBER_JWT_SECRET_KEY key set, never the staff session. A
    // trainer is a portal user, not staff: they get a bearer token that can
    // check in and read their own shifts, and nothing on the admin side. The
    // two key sets stay distinct precisely so a leak here cannot forge an
    // admin session (see the two-auth-systems section of CLAUDE.md).

    /**
     * Optional custom portal login ID. Blank means "sign in with the mobile
     * number", which is what every existing trainer will do.
     */
    loginId: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    /** bcrypt hash. Empty string means no portal access has been granted. */
    passwordHash: {
      type: String,
      default: "",
      // Never sent to a client — stripped in toJSON below as well.
      select: false,
    },

    /** Staff set the first password; the trainer is forced to change it. */
    mustChangePassword: {
      type: Boolean,
      default: true,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    /**
     * Whether portal credentials exist. Stored, not derived, for the same
     * reason as on Member: `passwordHash` is select:false, so a virtual reading
     * it would report false on every normal query and tell staff "no access"
     * for trainers who can in fact log in.
     */
    hasPortalAccess: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

TrainerSchema.index({ mobileNumber: 1 }, { unique: true });

// Unique only among trainers who actually have a custom ID — a plain unique
// index would treat every null as a value and reject the second trainer
// without one. Same partial-index shape as Member.loginId.
TrainerSchema.index(
  { loginId: 1 },
  {
    unique: true,
    partialFilterExpression: { loginId: { $type: "string" } },
  },
);

TrainerSchema.pre("save", function (next) {
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

TrainerSchema.set("toJSON", { transform: stripSecrets });
TrainerSchema.set("toObject", { transform: stripSecrets });

export default mongoose.model("Trainer", TrainerSchema);
