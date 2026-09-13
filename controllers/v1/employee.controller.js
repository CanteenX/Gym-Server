import EmployeeModels from "../../models/Employee.js";
import CompanyMaster from "../../models/CompanyMaster.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import authService from "../../services/authService.js";
import { scopedBranch, isSuperAdmin } from "../../middlewares/branchScope.js";

/**
 * Guards who may create or edit whom.
 *
 * Enforced HERE, in the controller, rather than only in the admin UI: hiding
 * the "All Branches" option in a dropdown stops an honest mistake, not a
 * crafted POST. Without this check a Gotri admin could create themselves a
 * super admin account by adding two fields to the request body.
 *
 * Rules:
 *   - a super admin may create anything;
 *   - a branch admin may only create staff pinned to their OWN branch, and may
 *     never mint a super admin or an all-branches account.
 *
 * Returns an error string when the request must be refused, or null when it is
 * allowed. `branch` is the requested branch (undefined/"" meaning all).
 */
const branchAssignmentError = (req, { branch, isSuperAdmin: wantsSuperAdmin }) => {
  if (isSuperAdmin(req)) return null;

  const own = scopedBranch(req);
  /**
   * No branch and not a super admin is a MISCONFIGURED account, not a
   * privileged one — so it must grant less, never more.
   *
   * This used to `return null`, which skipped every check below it, including
   * the super-admin guard six lines down: an account with `branch: null` could
   * therefore create a super admin and hand itself the whole system. Exactly
   * that shape existed in production (`test@gmail.com`, since deactivated),
   * and `scopedBranch()` already reads a null branch as "all branches"
   * elsewhere, so the same misconfiguration was widening reads too.
   */
  if (!own) {
    return (
      "This account is not assigned to a branch, so it cannot create or " +
      "modify staff. A super admin must assign it a branch first."
    );
  }

  if (wantsSuperAdmin === true || wantsSuperAdmin === "true") {
    return "You do not have permission to create or modify a super admin account.";
  }
  /**
   * An OMITTED branch is no longer refused, it is PINNED — see
   * resolveAssignedBranch() below. For a branch admin the branch is not a
   * choice made on a form, it is a fact about who is logged in, and the
   * owner's requirement is that they "have control over their department and
   * employees". Refusing instead meant Setup -> Employee failed with "You may
   * only create staff for your own branch, not for all branches" whenever the
   * branch select had not been touched — including on every EDIT, where the
   * form does not always resend it.
   *
   * Naming a DIFFERENT branch is still refused: that is an attempt to widen,
   * not an omission.
   */
  if (branch && branch !== own) {
    return `You may only create staff for the ${own} branch.`;
  }
  return null;
};

/**
 * The branch a staff row must actually LAND IN, given who is creating it.
 *
 * A super admin gets what they asked for ("" / undefined normalising to null,
 * the "all branches" sentinel). A branch admin ALWAYS gets their own branch,
 * never the request body: branchAssignmentError() has already refused any
 * attempt to name a different one, so the only cases left here are "mine" and
 * "unspecified", and both must resolve to mine. Deriving it from the session
 * rather than echoing req.body is what makes "a branch admin cannot create
 * staff in the other branch" true of the STORED ROW, and not merely of the
 * validation that ran just before it.
 */
const resolveAssignedBranch = (req, branch) => {
  if (isSuperAdmin(req)) return branch || null;
  return scopedBranch(req);
};

/**
 * The branch filter for STAFF listings. Fail-closed, unlike scopeFilter().
 *
 * scopeFilter() answers `{}` for a super admin AND for an account that has no
 * branch and is not a super admin, because `branch: null` is precisely how
 * "all branches" is recorded and the helper cannot tell the two apart. For a
 * misconfigured staff account that conflation would hand over the entire staff
 * directory — and, through the by-id routes, the ability to manage every admin
 * in the business. So that case matches NOTHING here instead. Same reasoning
 * as branchAssignmentError()'s `if (!own)` arm: a misconfiguration must grant
 * less, never more.
 *
 * Returns a filter fragment to spread LAST, same contract as scopeFilter().
 */
const staffScopeFilter = (req) => {
  const own = scopedBranch(req);
  if (own) return { branch: own };
  if (isSuperAdmin(req)) return {};
  // _id is always set on a persisted document, so this can never match.
  return { _id: null };
};

/**
 * Guards reaching one SPECIFIC staff row by id (read, edit, delete, password
 * reset).
 *
 * ============================================================================
 * THIS IS THE ACTUAL SECURITY BOUNDARY — NOT THE LIST FILTER.
 * ============================================================================
 *
 * Filtering a list is cosmetic on its own: if GET/PUT/DELETE /employees/:id
 * still answer for a row from the other branch when the id is typed directly,
 * a Gotri admin reads and edits Vasna's staff with one curl. Ids are not
 * secrets — they travel in URLs, exports, screenshots and the admin panel's
 * own network tab. Every by-id handler in this file therefore re-checks the
 * row it just loaded, rather than trusting that the caller could only have
 * learned the id from a list they were allowed to see.
 *
 * Super admins are off-limits to a branch admin regardless of branch. A super
 * admin row carries `branch: null`, so the branch comparison alone would
 * already refuse it, but stating it explicitly keeps the rule true if that
 * sentinel ever changes: editing or resetting the owner's account is a
 * takeover of the whole system, not merely a cross-branch read.
 *
 * Returns an error string to refuse with, or null to allow.
 */
const employeeAccessError = (req, employee) => {
  const own = scopedBranch(req);
  if (!own) {
    // Unrestricted only if that null means "super admin". A branchless
    // non-super-admin is misconfigured; see staffScopeFilter().
    return isSuperAdmin(req)
      ? null
      : "This account is not assigned to a branch, so it cannot manage staff. " +
          "A super admin must assign it a branch first.";
  }
  if (employee.isSuperAdmin === true || employee.branch !== own) {
    return "You may only manage staff belonging to your own branch.";
  }
  return null;
};

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createEmployee = async (req, res) => {
  try {
    const {
      employeeName,
      departmentId,
      roleId,
      emailOffice,
      mobileNumber,
      countryId,
      stateId,
      cityId,
      address,
      password,
      isActive,
      branch,
      isSuperAdmin: wantsSuperAdmin,
    } = req.body;

    const guardError = branchAssignmentError(req, {
      branch,
      isSuperAdmin: wantsSuperAdmin,
    });
    if (guardError) {
      return res.status(403).json({
        isOk: false,
        message: guardError,
        status: 403,
      });
    }

    if (typeof emailOffice !== "string") {
      return res.status(400).json({
        isOk: false,
        message: "Invalid email address",
        status: 400,
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const safeEmailOffice = typeof emailOffice === "string" ? emailOffice.trim() : "";

    const existingEmployee = await EmployeeModels.findOne({
      emailOffice: safeEmailOffice,
    });

    if (existingEmployee) {
      return res
        .status(400)
        .json({ isOk: false, message: "Employee already exists" });
    }

    const employee = new EmployeeModels({
      employeeName,
      departmentId,
      roleId,
      emailOffice,
      mobileNumber,
      countryId,
      stateId,
      cityId,
      address,
      password: hashedPassword,
      isActive,
      // Derived from the SESSION, not echoed from req.body — a branch admin's
      // new staff always land in their own branch. Normalised to null rather
      // than "" so it matches the "all branches" sentinel the scope helpers
      // expect.
      branch: resolveAssignedBranch(req, branch),
      isSuperAdmin: wantsSuperAdmin === true || wantsSuperAdmin === "true",
      createdBy: req.user.role === "EMPLOYEE" ? req.user.id : null,
    });

    // TODO: the founding super admin (websupport@barodaweb.net) still has to be
    // created — deliberately NOT seeded here, because the password for that
    // account has not been supplied. When it is, create that Employee (or
    // CompanyMaster) once with branch: null and isSuperAdmin: true. Until then
    // an existing super admin must create the first branch admins.

    await employee.save();

    return res.status(201).json({
      isOk: true,
      message: "Employee created successfully",
      status: 201,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const { employeeId } = req.params;

    const {
      employeeName,
      departmentId,
      roleId,
      emailOffice,
      mobileNumber,
      countryId,
      stateId,
      cityId,
      address,
      isActive,
      branch,
      isSuperAdmin: wantsSuperAdmin,
    } = req.body;

    const guardError = branchAssignmentError(req, {
      branch,
      isSuperAdmin: wantsSuperAdmin,
    });
    if (guardError) {
      return res.status(403).json({
        isOk: false,
        message: guardError,
        status: 403,
      });
    }

    const safeEmployeeId = typeof employeeId === "string" ? employeeId.trim() : "";
    const safeEmailOffice = typeof emailOffice === "string" ? emailOffice.trim() : "";

    const employee = await EmployeeModels.findById(safeEmployeeId);

    if (!employee) {
      return res.status(400).json({
        isOk: false,
        message: "Employee not found",
        status: 400,
      });
    }

    // A branch admin must not be able to reach ACROSS branches to edit someone
    // else's staff — or to edit a super admin and take over the account.
    const accessError = employeeAccessError(req, employee);
    if (accessError) {
      return res.status(403).json({
        isOk: false,
        message: accessError,
        status: 403,
      });
    }

    const existingEmployee = await EmployeeModels.findOne({
      emailOffice: safeEmailOffice,
      _id: { $ne: safeEmployeeId },
    });

    if (existingEmployee) {
      return res.status(400).json({
        isOk: false,
        message: "Email already exists",
        status: 400,
      });
    }

    employee.employeeName = employeeName;
    employee.departmentId = departmentId;
    employee.roleId = roleId;
    employee.emailOffice = emailOffice;
    employee.mobileNumber = mobileNumber;
    employee.countryId = countryId;
    employee.stateId = stateId;
    employee.cityId = cityId;
    employee.address = address;
    employee.isActive = isActive;
    // Only a super admin may move someone between branches or change super-admin
    // status; for a branch admin the guard above has already pinned `branch` to
    // their own, so these are left untouched rather than silently rewritten.
    if (isSuperAdmin(req)) {
      if (branch !== undefined) employee.branch = branch || null;
      if (wantsSuperAdmin !== undefined) {
        employee.isSuperAdmin =
          wantsSuperAdmin === true || wantsSuperAdmin === "true";
      }
    }

    await employee.save();

    return res.status(200).json({
      isOk: true,
      message: "Employee updated successfully",
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const { employeeId } = req.params;

    const employee = await EmployeeModels.findById(employeeId);

    if (!employee) {
      return res.status(404).json({
        isOk: false,
        message: "Employee not found",
        status: 404,
      });
    }

    // Load-then-check, not a scoped delete query: a scoped
    // findOneAndDelete({_id, branch}) would report "not found" for a row that
    // exists in the other branch, which is indistinguishable from a genuine
    // 404 and hides a real attempt to cross the boundary. Refusing explicitly
    // keeps the two apart. See employeeAccessError().
    const accessError = employeeAccessError(req, employee);
    if (accessError) {
      return res.status(403).json({
        isOk: false,
        message: accessError,
        status: 403,
      });
    }

    await EmployeeModels.findByIdAndDelete(employeeId).exec();

    return res.status(200).json({
      isOk: true,
      message: "Employee deleted successfully",
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getEmployeeById = async (req, res) => {
  try {
    const { employeeId } = req.params;

    const employee = await EmployeeModels.findById(employeeId)
      .populate("departmentId")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .populate("roleId");

    if (!employee) {
      return res.status(404).json({
        isOk: false,
        message: "Employee not found",
        status: 404,
      });
    }

    // The list being filtered does not make this row unreachable — the id is
    // all anyone needs, and this handler is what the Edit screen calls.
    const accessError = employeeAccessError(req, employee);
    if (accessError) {
      return res.status(403).json({
        isOk: false,
        message: accessError,
        status: 403,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: employee,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listAllEmployees = async (req, res) => {
  try {
    // Spread LAST so it is authoritative. Without it this endpoint returned
    // the WHOLE staff directory to every branch admin, quietly undoing the
    // scoping on /employees/search next to it.
    const employees = await EmployeeModels.find({
      isActive: true,
      ...staffScopeFilter(req),
    })
      .populate("departmentId")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .populate("roleId");

    return res.status(200).json({
      isOk: true,
      data: employees,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listEmployeesByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 10;

    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    // Build the initial match condition
    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }

    /**
     * ========================================================================
     * WHY THERE IS NO LONGER A createdBy FILTER HERE.
     * ========================================================================
     *
     * This used to read:
     *
     *     if (req.user.role === "EMPLOYEE") {
     *       matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
     *     }
     *
     * — a per-creator hierarchy: you may see the staff YOU created. Every
     * branch admin is an Employee login, and branch admins are created BY the
     * super admin, so they had created nobody and this endpoint answered with
     * an empty list. Measured against production: the super admin saw 6-7
     * staff across both gyms, the Vasna admin saw ZERO and could not manage
     * their own reception desk at all. The bug was invisible — an empty table
     * reads as "no staff yet", not as "you were filtered out".
     *
     * Ownership is also the wrong model for the owner's requirement: staff
     * belong to a BRANCH, not to whoever happened to type them in. Two Vasna
     * admins must both see the Vasna desk; neither may see Gotri's. So the
     * hierarchy is replaced by the branch scope, which is what every other
     * list in this codebase already uses.
     *
     * Derived from the SESSION, never from req.body, and spread LAST so a
     * client-supplied branch can narrow a super admin but can never widen a
     * branch admin. Fail-closed for a branchless non-super-admin — see
     * staffScopeFilter().
     */
    matchCondition = { ...matchCondition, ...staffScopeFilter(req) };

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const pipeline = [
      {
        $sort: {
          [sorton && typeof sorton === "string" ? sorton : "createdAt"]: sortdir === "desc" ? -1 : 1
        }
      },
      ...(safeMatch
        ? (() => {
            let searchConditions = {
              $or: [
                { employeeName: { $regex: escapeRegex(safeMatch), $options: "i" } },
                { emailOffice: { $regex: escapeRegex(safeMatch), $options: "i" } },
                { mobileNumber: { $regex: escapeRegex(safeMatch), $options: "i" } },
                {
                  "department.departmentName": {
                    $regex: escapeRegex(safeMatch),
                    $options: "i",
                  },
                },
              ],
            };

            if (mongoose.Types.ObjectId.isValid(safeMatch)) {
              searchConditions.$or.push(
                { departmentId: new mongoose.Types.ObjectId(safeMatch) },
                { roleId: new mongoose.Types.ObjectId(safeMatch) },
              );
            }
            return [{ $match: searchConditions }];
          })()
        : []),
      {
        $match: matchCondition,
      },
      {
        $lookup: {
          from: "departments",
          localField: "departmentId",
          foreignField: "_id",
          as: "department",
        },
      },
      {
        $unwind: {
          path: "$department",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "rolemasters",
          localField: "roleId",
          foreignField: "_id",
          as: "role",
        },
      },
      {
        $unwind: {
          path: "$role",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "employees",
          localField: "createdBy",
          foreignField: "_id",
          as: "createdByEmployee",
        },
      },
      {
        $unwind: {
          path: "$createdByEmployee",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $facet: {
          stage1: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
              },
            },
          ],
          stage2: [{ $skip: safeSkip }, { $limit: safePerPage }],
        },
      },
      {
        $unwind: "$stage1",
      },
      {
        $project: {
          count: "$stage1.count",
          data: "$stage2",
        },
      },
    ];

    const list = await EmployeeModels.aggregate(pipeline);

    return res.status(200).json({
      data: list,
      status: 200,
    });
  } catch (error) {
    console.error("Error in listEmployeesByParams:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listAllEmployeesByDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;

    // Same boundary as every other staff read: a department is not a branch,
    // and one department can span both gyms.
    const employees = await EmployeeModels.find({
      departmentId,
      isActive: true,
      ...staffScopeFilter(req),
    });

    return res.status(200).json({
      isOk: true,
      data: employees,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const loginEmployee = async (req, res) => {
  try {
    const { email, password } = req.body;
    const safeEmail = typeof email === "string" ? email.trim() : "";

    const employee = await EmployeeModels.findOne({ emailOffice: safeEmail })
      // The ONE authorised place that asks for the hash. Employee.password is
      // `select: false`, so without this bcrypt.compare gets undefined and
      // every staff login fails. Nothing else in the codebase compares it -
      // the two resetPassword paths only assign.
      .select("+password")
      .populate("departmentId")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .populate("roleId")
      .exec();

    /**
     * A deactivated account must not be able to sign in.
     *
     * This check did not exist. `isActive: false` was set by the admin screen,
     * reported by every listing, and honoured by nothing at login — so
     * "deactivating" a staff member removed them from view while leaving their
     * password working. It was found by retiring a second super admin nobody
     * had documented, then testing the login rather than assuming the flag did
     * something: it answered "Login successful".
     *
     * Deliberately the same 401 and the same message as an unknown address.
     * Saying "this account is disabled" would confirm the address exists and
     * tell an attacker which accounts are worth pursuing elsewhere.
     */
    if (!employee || employee.isActive === false) {
      return res.status(401).json({
        isOk: false,
        message: "Invalid credentials",
        status: 401,
      });
    }

    // Check if account is locked BEFORE password verification
    const isLocked = await authService.isAccountLocked(employee._id, email);
    if (isLocked) {
      const status = await authService.getLoginAttemptStatus(
        employee._id,
        email,
      );
      return res.status(423).json({
        isOk: false,
        message: "Account locked due to multiple failed login attempts",
        error: "Account locked",
        lockedUntil: status.lockUntil,
        remainingTimeMs: status.remainingTime,
        status: 423,
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, employee.password);

    if (!isPasswordValid) {
      // Record failed attempt
      const attemptResult = await authService.recordFailedAttempt(
        employee._id,
        email,
      );

      // Check if account just got locked
      if (attemptResult.isLocked) {
        return res.status(423).json({
          isOk: false,
          message: "Account locked due to multiple failed login attempts",
          error: "Account locked",
          lockedUntil: attemptResult.lockUntil,
          remainingTimeMs: 24 * 60 * 60 * 1000, // 24 hours
          status: 423,
        });
      }

      // Return 401 with remaining attempts
      const warningMessage =
        attemptResult.attemptsRemaining <= 1
          ? "Warning: One more failed attempt will lock your account"
          : null;

      return res.status(401).json({
        isOk: false,
        message: "Invalid credentials",
        error: "Invalid credentials",
        attemptsRemaining: attemptResult.attemptsRemaining,
        warning: warningMessage,
        status: 401,
      });
    }

    // Successful login - record it and reset attempt count
    await authService.recordSuccessfulLogin(employee._id, email);

    // Store user data in express session (in-memory)
    //
    // This MUST carry the same fields as the loginCompany path in
    // company.controller.js. It previously wrote only {id, role, email, name},
    // which meant an employee who logged in here had no roleId and no
    // permissions on their session — so checkPermission had nothing to check
    // against, and (once branch scoping landed) scopeFilter would have read an
    // undefined branch and handed every branch admin the whole gym.
    const employeeRole = await EmployeeRoles.findOne({
      roleId: employee.roleId?._id || employee.roleId,
      isActive: true,
    }).select("roles updatedAt");

    req.session.user = {
      id: employee._id.toString(),
      role: "EMPLOYEE",
      email: employee.emailOffice,
      name: employee.employeeName,
      roleId:
        employee.roleId?._id?.toString() ||
        employee.roleId?.toString() ||
        null,
      permissions:
        employeeRole?.roles?.map((r) => ({
          menuId: r.menuId?.toString(),
          menuGroupId: r.menuGroupId?.toString(),
          read: r.read,
          write: r.write,
          delete: r.delete,
          edit: r.edit,
          print: r.print,
          mail: r.mail,
        })) || [],
      permissionsUpdatedAt: employeeRole?.updatedAt || null,
      // Branch scope travels on the session because that is the only place a
      // request cannot tamper with it. null = all branches.
      branch: employee.branch || null,
      isSuperAdmin: employee.isSuperAdmin === true,
    };

    return res.status(200).json({
      isOk: true,
      message: "Login successful",
      data: employee,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getCurrentUser = async (req, res) => {
  try {
    // The user ID is available in req.user.id from the auth middleware
    const userId = req.user.id;
    let role = null;

    if (!userId) {
      return res.status(400).json({
        isOk: false,
        message: "User ID not found in request",
      });
    }

    let user = null;
    // Fetch the employee details using the correct model variable name
    user = await EmployeeModels.findById(userId);
    if (user) {
      role = "EMPLOYEE";
    }

    if (!user) {
      user = await CompanyMaster.findById(userId);
      if (user) {
        role = "ADMIN";
      }
    }

    if (!user) {
      return res.status(404).json({
        isOk: false,
        message: "User not found",
      });
    }

    /**
     * This is a hand-built whitelist, so any field omitted here is invisible to
     * the entire admin app no matter what the database holds.
     *
     * `branch` and `isSuperAdmin` were missing, which broke two things at once:
     * MenuContext could not tell that an Employee was a super admin (so it fell
     * through to the per-menu path and rendered an empty sidebar), and nothing
     * client-side could tell which branch the user belonged to. Both are read
     * on every page load — they are not optional extras.
     */
    const dataToSend = {
      _id: user._id,
      employeeName: user.employeeName,
      emailOffice: user.emailOffice,
      role: role,
      isActive: user.isActive,
      departmentId: user.departmentId,
      roleId: user.roleId,
      branch: user.branch ?? null,
      isSuperAdmin: user.isSuperAdmin === true,
    };

    const company = await CompanyMaster.findOne({ isSuperAdmin: false });

    if (role === "EMPLOYEE") {
      dataToSend.companyName = company ? company.companyName : "";
    }

    // Return essential user information
    return res.status(200).json({
      isOk: true,
      message: "User details retrieved successfully",
      data: dataToSend,
    });
  } catch (error) {
    console.error("Error fetching current user:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message || "Error retrieving user details",
    });
  }
};
export const logoutUser = async (req, res) => {
  try {
    // Destroy the express session
    req.session.destroy((err) => {
      if (err) {
        console.error("Error destroying session:", err);
        return res.status(500).json({
          isOk: false,
          message: "Logout failed",
          status: 500,
        });
      }

      // Clear the session cookie
      res.clearCookie("sessionId");

      return res.status(200).json({
        isOk: true,
        message: "Logged out successfully",
        status: 200,
      });
    });
  } catch (error) {
    console.error("Error during logout:", error);
    return res.status(500).json({
      isOk: false,
      message: "Logout failed",
      status: 500,
    });
  }
};

/**
 * Verify session - lightweight endpoint to check if session is valid
 * Returns only the user role, no sensitive data
 */
export const verifySession = async (req, res) => {
  // If we reach here, authMiddleware has already validated the session
  return res.status(200).json({
    isOk: true,
    data: { role: req.user.role },
  });
};

export const resetPassword = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { password } = req.body;

    const employee = await EmployeeModels.findById(employeeId);

    if (!employee) {
      return res.status(400).json({
        isOk: false,
        message: "Employee not found",
        status: 400,
      });
    }

    // Setting someone's password IS taking over their account, so this needs
    // the same boundary as edit and delete — arguably more. The route is
    // authMiddleware(["ADMIN"]) today, which keeps Employee logins out but
    // does NOT keep out a second, non-super CompanyMaster admin; role is which
    // table you logged in from, not how much you may do. See
    // middlewares/superAdmin.js.
    const accessError = employeeAccessError(req, employee);
    if (accessError) {
      return res.status(403).json({
        isOk: false,
        message: accessError,
        status: 403,
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    employee.password = hashedPassword;

    await employee.save();

    return res.status(200).json({
      isOk: true,
      message: "Password reset successfully",
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};
