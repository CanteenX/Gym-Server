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
    /**
     * bcrypt hash of the staff password. NEVER leaves the server.
     *
     * `select: false`, matching CompanyMaster.password. A handler that answers
     * with the whole row therefore has nothing to leak, which is what made
     * this a real leak rather than a theoretical one: GET /employees returned
     * every staff row, hash included, to any branch admin.
     *
     * Exactly one query opts back in — the findOne in loginEmployee, which
     * needs it for bcrypt.compare. The two resetPassword paths only ASSIGN the
     * field, which works fine on an unselected path.
     *
     * This is the first of three layers; the toJSON/toObject transform below
     * and middlewares/stripResponseSecrets.js are the other two. Any one of
     * them stops the leak, and the tests fail if one is removed.
     */
    password: {
      type: String,
      required: true,
      trim: true,
      select: false,
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
     *
     * The enum moved to the Branch master (models/Branch.js) so opening a
     * third gym is a data change, not a schema change. Still a STRING, not a
     * branchId reference: existing staff accounts keep their "Vasna"/"Gotri"
     * value untouched, and branchScope.js compares that string literally
     * against the branch on every member/trainer/transaction row. Staff
     * pickers must read physical branches only (?physicalOnly=true) — nobody
     * is employed by the "Common" cost bucket.
     */
    branch: {
      type: String,
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

/**
 * The password hash must never survive serialisation to a client.
 *
 * This is the ONLY thing standing between a browser and every staff bcrypt
 * hash: /auth/employee/login answers with `data: employee` — the whole
 * document — and so do getEmployeeById, listAllEmployees and
 * listAllEmployeesByDepartment. Rather than remember to `.select("-password")`
 * on each of them (and on the next one somebody writes), the document itself
 * refuses to serialise the field. Same pattern as Member.passwordHash and
 * Trainer.passwordHash.
 *
 * toObject as well as toJSON: several handlers build their response with
 * .toObject() and res.json() then never sees a Mongoose document.
 *
 * This does NOT cover .aggregate() or .lean(), which return plain objects the
 * schema never touches — middlewares/stripResponseSecrets.js is the net for
 * those.
 */
const stripSecrets = (_doc, ret) => {
  delete ret.password;
  return ret;
};

EmployeeSchema.set("toJSON", { transform: stripSecrets });
EmployeeSchema.set("toObject", { transform: stripSecrets });

export default mongoose.model("Employee", EmployeeSchema);
