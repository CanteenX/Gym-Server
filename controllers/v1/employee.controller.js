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
  if (!own) return null;

  if (wantsSuperAdmin === true || wantsSuperAdmin === "true") {
    return "You do not have permission to create or modify a super admin account.";
  }
  if (!branch) {
    return "You may only create staff for your own branch, not for all branches.";
  }
  if (branch !== own) {
    return `You may only create staff for the ${own} branch.`;
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
      // Normalised to null rather than "" so it matches the "all branches"
      // sentinel the scope helpers expect.
      branch: branch || null,
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
    const ownBranch = scopedBranch(req);
    if (ownBranch && (employee.isSuperAdmin || employee.branch !== ownBranch)) {
      return res.status(403).json({
        isOk: false,
        message: "You may only manage staff belonging to your own branch.",
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
    const employees = await EmployeeModels.find({
      isActive: true,
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

    // Employee can see:
    // 1. His own record
    // 2. Employees created by him
    if (req.user.role === "EMPLOYEE") {
      matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
    }

    // Branch scope, derived from the session — never from req.body. Applied
    // after the client's own conditions so it cannot be widened by the request.
    const ownBranch = scopedBranch(req);
    if (ownBranch) matchCondition.branch = ownBranch;

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

    const employees = await EmployeeModels.find({
      departmentId,
      isActive: true,
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
    const ipAddress =
      req.ip ||
      req.headers["x-forwarded-for"] ||
      req.connection?.remoteAddress ||
      "unknown";

    const employee = await EmployeeModels.findOne({ emailOffice: safeEmail })
      .populate("departmentId")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .populate("roleId")
      .exec();

    if (!employee) {
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
        ipAddress,
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

    const dataToSend = {
      _id: user._id,
      employeeName: user.employeeName,
      emailOffice: user.emailOffice,
      role: role,
      isActive: user.isActive,
      departmentId: user.departmentId,
      roleId: user.roleId,
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
