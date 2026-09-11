import mongoose from "mongoose";

const EmailForSchema = new mongoose.Schema(
  {
    emailFor: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // === RBAC OWNERSHIP FILTER START ===
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    // === RBAC OWNERSHIP FILTER END ===
  },
  { timestamps: true },
);

export default mongoose.model("EmailFor", EmailForSchema);
