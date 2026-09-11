import mongoose from "mongoose";

const RoleMasterSchema = new mongoose.Schema(
  {
    roleName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

RoleMasterSchema.statics.findAdminCreatedRoles = function() {
  return this.find({
    isActive: true,
    createdBy: null,
  });
};

RoleMasterSchema.statics.findEmployeeCreatedRoles = function() {
  return this.find({
    isActive: true,
    createdBy: { $ne: null },
  }).populate("createdBy", "employeeName");
};

export default mongoose.model("RoleMaster", RoleMasterSchema);
