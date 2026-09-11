import mongoose from "mongoose";

const EmployeeSchema = new mongoose.Schema(
  {
    employeeName: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional on purpose. A gym branch admin is a login, not an HR record —
    // they have no department, and forcing one just to create an account
    // invents data nobody maintains. Kept on the schema because the wider
    // employee directory still uses it.
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: false,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoleMaster",
      required: true,
    },
    emailOffice: {
      type: String,
      required: true,
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: false,
      trim: true,
    },
    // Country/state/city/address are optional for the same reason as
    // departmentId: a branch admin account needs an email and a password, not a
    // postal address. Requiring them turned "add a branch admin" into a
    // five-dropdown data-entry exercise with nothing real behind it.
    countryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Country",
      required: false,
    },
    stateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "State",
      required: false,
    },
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
      required: false,
    },
    address: {
      type: String,
      required: false,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      trim: true,
    },
    /**
     * Which branch this person may see. `null` means ALL branches.
     *
     * WHY THIS LIVES ON THE EMPLOYEE AND NOT ON THE ROLE:
     * the role answers "what may this person do?" (read/write/edit/delete/
     * print/mail per menu, in EmployeeRoles). Branch answers "whose data?" —
     * a different question about a different thing. They are independent: a
     * Receptionist at Vasna and a Receptionist at Gotri share one role and one
     * permission set, but must never see each other's members. Putting branch
     * on the role would force a duplicate "Vasna Receptionist" /
     * "Gotri Receptionist" role for every role that exists, and the two copies
     * would drift apart the first time someone edited only one of them.
     * Branch is a property of the PERSON, so it is stored on the person.
     *
     * `null` = super admin, i.e. no branch restriction. It is deliberately the
     * default-less absence of a value rather than a magic string like "All",
     * because scopeFilter() turns it straight into an empty Mongo filter.
     */
    branch: {
      type: String,
      enum: ["Vasna", "Gotri"],
      default: null,
    },
    /**
     * Full access: may see both branches and create/manage other super admins.
     *
     * This mirrors the long-standing `isSuperAdmin` flag on CompanyMaster, so
     * requireSuperAdmin.js keeps working unchanged for either kind of login —
     * it only ever reads req.session.user.isSuperAdmin.
     */
    isSuperAdmin: {
      type: Boolean,
      default: false,
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
  { timestamps: true },
);

export default mongoose.model("Employee", EmployeeSchema);
