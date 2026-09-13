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
    /**
     * Optional RBAC role, mirroring Employee.roleId.
     *
     * WHY A COMPANY ROW HAS A ROLE AT ALL. There are two kinds of row in this
     * table: the one super admin (isSuperAdmin: true) and any number of
     * branch-level admins created through Setup → Admin (isSuperAdmin: false).
     * The second kind used to need no role, because the permission gate
     * bypassed on `role === "ADMIN"` and every row here logs in as "ADMIN" —
     * so a branch admin was waved through every check in the system. Now that
     * only the super admin bypasses, a branch-level row is subject to its
     * grants like anybody else, and without a roleId it has no grants to be
     * subject to: ensurePermissionsFresh answers "No permissions found for this
     * role" and the account is locked out of every gated screen.
     *
     * OPTIONAL, and absent on existing rows — including the super admin, who
     * needs no grants by definition. Nothing changes for a row that does not
     * set it. scripts/seedBranchRolePermissions.js is what assigns one.
     */
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoleMaster",
      required: false,
      default: null,
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
      default: "#15803d",
    },
    removeButtonColor: {
      type: String,
      // Brand red ($red), matching the Expired badge. Was Velzon's orange.
      default: "#dc2626",
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
