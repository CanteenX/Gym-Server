import mongoose from "mongoose";

const EmployeeRolesSchema = new mongoose.Schema(
  {
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoleMaster",
      required: true,
    },
    roles: {
      type: [
        {
          menuId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "MenuMaster",
            required: false,
            default: null,
          },
          menuGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "MenuGroupMaster",
            required: false,
            default: null,
          },
          read: {
            type: Boolean,
            default: false,
          },
          write: {
            type: Boolean,
            default: false,
          },
          delete: {
            type: Boolean,
            default: false,
          },
          edit: {
            type: Boolean,
            default: false,
          },
          print: {
            type: Boolean,
            default: false,
          },
          mail: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model("EmployeeRoles", EmployeeRolesSchema);
