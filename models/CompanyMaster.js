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
      // Brand green ($green in the admin SCSS), which is what the Active badge
      // already uses - so buttons and badges finally agree. Was Velzon's teal
      // #0ab39c, which read as off-brand against the navy panel.
      default: "#4b7c5c",
    },
    removeButtonColor: {
      type: String,
      // Brand red ($red), matching the Expired badge. Was Velzon's orange.
      default: "#a83a32",
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
        // Solid fills. This default was served to every client and overrode the
        // admin panel's own defaults entirely, which is why buttons rendered as
        // saturated gradient pills no matter what the front end asked for.
        default: "solid",
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
