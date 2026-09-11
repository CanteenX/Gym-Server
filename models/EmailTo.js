import mongoose from "mongoose";

const EmailToSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
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

export default mongoose.model("EmailTo", EmailToSchema);
