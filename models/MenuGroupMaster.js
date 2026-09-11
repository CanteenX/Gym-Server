import mongoose from "mongoose";

const MenuGroupMasterSchema = new mongoose.Schema(
  {
    menuGroupName: {
      type: String,
      required: true,
    },
    sequence: {
      type: Number,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
    isLink: {
      type: Boolean,
      default: false,
    },
    menuUrl: {
      type: String,
      default: "#",
    },
    icon: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

export default mongoose.model("MenuGroupMaster", MenuGroupMasterSchema);
