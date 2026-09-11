import mongoose from "mongoose";

/**
 * Membership Plan Master.
 *
 * Replaces the hardcoded MEMBERSHIP_PLANS array that used to live in
 * models/Member.js. `code` is the stable identifier stored on Member.planCode,
 * `months` drives the auto-calculated end date, and `requiresTrainer` tells the
 * member form whether a trainer must be picked for this plan.
 */
const MembershipPlanSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    months: {
      type: Number,
      required: true,
      min: 1,
    },
    defaultFee: {
      type: Number,
      required: true,
      min: 0,
    },
    // Plans like Personal Training need a dedicated coach assigned.
    requiresTrainer: {
      type: Boolean,
      default: false,
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

// Dropdowns always read active plans in display order.
MembershipPlanSchema.index({ isActive: 1, sequence: 1 });

export default mongoose.model("MembershipPlan", MembershipPlanSchema);
