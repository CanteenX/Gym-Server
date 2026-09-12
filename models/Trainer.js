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
  },
  { timestamps: true },
);

TrainerSchema.index({ mobileNumber: 1 }, { unique: true });

export default mongoose.model("Trainer", TrainerSchema);
