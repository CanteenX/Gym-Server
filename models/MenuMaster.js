import mongoose from "mongoose";

const MenuMasterSchema = new mongoose.Schema(
  {
    menuName: {
      type: String,
      required: true,
    },
    menuGroup: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuGroupMaster",
      required: true,
    },
    menuUrl: {
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
    isParent: {
      type: Boolean,
      default: false,
    },
    parentMenu: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuMaster",
      default: null,
    },
    icon: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

export default mongoose.model("MenuMaster", MenuMasterSchema);
