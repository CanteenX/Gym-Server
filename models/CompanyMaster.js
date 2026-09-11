import mongoose from "mongoose";

const CompanyMasterSchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true,
    },
    gstNumber: {
      type: String,
      required: true,
      trim: true,
    },
    countryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Country",
      required: true,
    },
    stateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "State",
      required: true,
    },
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
      required: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
    },
    logo: {
      type: String,
      trim: true,
      default: "",
    },
    favicon: {
      type: String,
      trim: true,
      default: "",
    },
    loginBanner: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      required: true,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },
    sidebarBgColor: {
      type: String,
      default: "#224c99",
    },
    addButtonColor: {
      type: String,
      default: "#0ab39c",
    },
    removeButtonColor: {
      type: String,
      default: "#f06548",
    },
    addButtonTextColor: {
      type: String,
      default: "",
    },
    removeButtonTextColor: {
      type: String,
      default: "",
    },
    buttonStyle: {
      borderRadius: {
        type: String,
        default: "8px",
      },
      themeType: {
        type: String,
        default: "gradient",
      },
      buttonType: {
        type: String,
        default: "contained", // can be "contained", "outline", "soft", or "animated"
      },
    },
    enableSearchMenu: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model("CompanyMaster", CompanyMasterSchema);
