import EmployeeModels from "../../models/Employee.js";
import CompanyMaster from "../../models/CompanyMaster.js";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import authService from "../../services/authService.js";

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
    } = req.body;

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
      createdBy: req.user.role === "EMPLOYEE" ? req.user.id : null,
    });

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
    } = req.body;

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
    req.session.user = {
      id: employee._id.toString(),
      role: "EMPLOYEE",
      email: employee.emailOffice,
      name: employee.employeeName,
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
