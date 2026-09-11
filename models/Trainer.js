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
    branch: {
      type: String,
      enum: ["Vasna", "Gotri"],
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
