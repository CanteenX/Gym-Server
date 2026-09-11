import mongoose from "mongoose";

const EmailSetupSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
    },
    appPassword: {
      type: String,
      required: true,
    },
    SSL: {
      type: Boolean,
      default: true,
      required: true,
    },
    port: {
      type: Number,
      required: true,
    },
    host: {
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

export default mongoose.model("EmailSetup", EmailSetupSchema);
