import CompanyMasterModels from "../../models/CompanyMaster.js";
import EmployeeModels from "../../models/Employee.js";
import bcrypt from "bcrypt";
import fs from "node:fs";
import {
  isAccountLocked,
  recordFailedAttempt,
  recordSuccessfulLogin,
  getLoginAttemptStatus,
} from "../../services/authService.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";

// ✅ Helper: validate consent
const validateConsent = (locationConsent, ipConsent) => {
  return locationConsent && ipConsent;
};

// ✅ Helper: get IP address
const getIpAddress = (req) => {
  return (
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    "unknown"
  );
};

// ✅ Helper: get client location
const getClientLocation = (req, clientLatitude, clientLongitude) => {
  return {
    latitude: clientLatitude || req.headers["x-client-latitude"] || null,
    longitude: clientLongitude || req.headers["x-client-longitude"] || null,
  };
};

// ✅ Helper: find user by email
const findUserByEmail = async (sanitizedEmail) => {
  const safeEmail = typeof sanitizedEmail === "string" ? sanitizedEmail.trim().toLowerCase() : "";

  const companyMaster = await CompanyMasterModels.findOne({
    email: safeEmail,
    isActive: true,
  })
    .populate("countryId")
    .populate("stateId")
    .populate("cityId")
    .exec();

  const employee = await EmployeeModels.findOne({
    emailOffice: safeEmail,
    isActive: true,
  })
    .populate("departmentId")
    .populate("stateId")
    .populate("cityId")
    .exec();

  return { companyMaster, employee };
};

// ✅ Helper: resolve user role
const resolveUserRole = (companyMaster, employee) => {
  if (companyMaster) {
    return {
      user: companyMaster,
      userId: companyMaster._id,
      role: "ADMIN",
    };
  }
  if (employee) {
    return {
      user: employee,
      userId: employee._id,
      role: "EMPLOYEE",
    };
  }
  return null;
};

// ✅ Helper: handle locked account response
const handleLockedAccount = async (res, userId, email) => {
  const status = await getLoginAttemptStatus(userId, email);
  return res.status(423).json({
    isOk: false,
    message: "Account locked due to multiple failed login attempts",
    error: "Account locked",
    lockedUntil: status.lockUntil,
    remainingTimeMs: status.remainingTime,
    status: 423,
  });
};

// ✅ Helper: handle failed password attempt
const handleFailedPassword = async (
  res,
  userId,
  email,
  ipAddress,
  clientLocation
) => {
  const attemptResult = await recordFailedAttempt(
    userId,
    email,
    ipAddress,
    clientLocation
  );

  if (attemptResult.isLocked) {
    return res.status(423).json({
      isOk: false,
      message: "Account locked due to multiple failed login attempts",
      error: "Account locked",
      lockedUntil: attemptResult.lockUntil,
      remainingTimeMs: 24 * 60 * 60 * 1000,
      status: 423,
    });
  }

  return res.status(401).json(buildInvalidLoginResponse(attemptResult));
};

const deleteFileIfExists = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

const getEmployeePermissions = async (employee) => {
  let permissions = [];
  let permissionsUpdatedAt = null;

  const employeeRole = await EmployeeRoles.findOne({
    roleId: employee.roleId?._id || employee.roleId,
    isActive: true,
  });

  if (employeeRole) {
    permissions = employeeRole.roles.map((r) => ({
      menuId: r.menuId?.toString(),
      menuGroupId: r.menuGroupId?.toString(),
      read: r.read,
      write: r.write,
      delete: r.delete,
      edit: r.edit,
      print: r.print,
      mail: r.mail,
    }));

    permissionsUpdatedAt = employeeRole.updatedAt;
  }

  return { permissions, permissionsUpdatedAt };
};

const buildInvalidLoginResponse = (attemptResult) => {
  const warningMessage =
    attemptResult.attemptsRemaining <= 1
      ? "Warning: One more failed attempt will lock your account"
      : null;

  return {
    isOk: false,
    message: "Invalid email or password",
    error: "Invalid credentials",
    attemptsRemaining: attemptResult.attemptsRemaining,
    warning: warningMessage,
    status: 401,
  };
};

export const createCompanyMaster = async (req, res) => {
  try {
    const {
      companyName,
      email,
      password,
      mobileNumber,
      gstNumber,
      countryId,
      stateId,
      cityId,
      address,
      pincode,
      website,
      isActive,
      addButtonTextColor,
      removeButtonTextColor,
    } = req.body;

    const superAdmin = await CompanyMasterModels.findOne({ isSuperAdmin: true }) ||
                       await CompanyMasterModels.findOne({ isSuperAdmin: false });

    const hashedPassword = await bcrypt.hash(password, 10);

    const companyMaster = new CompanyMasterModels({
      companyName,
      email,
      password: hashedPassword,
      mobileNumber: mobileNumber || superAdmin?.mobileNumber || "0000000000",
      gstNumber: gstNumber || superAdmin?.gstNumber || "24ACQFS6351L2AI",
      countryId: countryId || superAdmin?.countryId,
      stateId: stateId || superAdmin?.stateId,
      cityId: cityId || superAdmin?.cityId,
      address: address || superAdmin?.address || "Address",
      pincode: pincode || superAdmin?.pincode || "390001",
      website: website || superAdmin?.website || "www.barodaweb.com",
      isActive: isActive !== undefined ? isActive : true,
      addButtonTextColor: addButtonTextColor || superAdmin?.addButtonTextColor || "",
      removeButtonTextColor: removeButtonTextColor || superAdmin?.removeButtonTextColor || "",
    });

    if (req.files?.logo) {
      companyMaster.logo = req.files.logo[0].path;
    } else if (superAdmin?.logo) {
      companyMaster.logo = superAdmin.logo;
    }

    if (req.files?.favicon) {
      companyMaster.favicon = req.files.favicon[0].path;
    } else if (superAdmin?.favicon) {
      companyMaster.favicon = superAdmin.favicon;
    }

    if (req.files?.loginBanner) {
      companyMaster.loginBanner = req.files.loginBanner[0].path;
    } else if (superAdmin?.loginBanner) {
      companyMaster.loginBanner = superAdmin.loginBanner;
    }

    await companyMaster.save();

    return res.status(201).json({
      isOk: true,
      message: "Company Master created successfully",
    });
  } catch (error) {
    console.error("Error in createCompanyMaster", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

export const updateCompanyMaster = async (req, res) => {
  try {
    const companyId = req.params.id;
    const companyMaster = await CompanyMasterModels.findById(companyId);

    if (!companyMaster) {
      return res.status(404).json({
        isOk: false,
        message: "Company Master not found",
      });
    }

    const updateFields = [
      "companyName",
      "email",
      "contactPersonName",
      "contactNumber",
      "mobileNumber",
      "gstNumber",
      "countryId",
      "stateId",
      "cityId",
      "address",
      "pincode",
      "isActive",
      "loginBanner",
      "sidebarBgColor",
      "addButtonColor",
      "removeButtonColor",
      "addButtonTextColor",
      "removeButtonTextColor",
      "buttonStyle",
      "enableSearchMenu",
      "website",
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        companyMaster[field] = req.body[field];
      }
    });

    if (req.body.password && req.body.password.trim() !== "") {
      companyMaster.password = await bcrypt.hash(req.body.password, 10);
    }

    if (req.files?.logo) {
      deleteFileIfExists(companyMaster.logo);
      companyMaster.logo = req.files.logo[0].path;
    }

    if (req.files?.favicon) {
      deleteFileIfExists(companyMaster.favicon);
      companyMaster.favicon = req.files.favicon[0].path;
    }

    if (req.files?.loginBanner) {
      deleteFileIfExists(companyMaster.loginBanner);
      companyMaster.loginBanner = req.files.loginBanner[0].path;
    }

    await companyMaster.save();

    return res.status(200).json({
      isOk: true,
      message: "Company Master updated successfully",
    });
  } catch (error) {
    console.error("Error in updateCompanyMaster", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

export const loginCompany = async (req, res) => {
  try {
    const {
      email,
      password,
      locationConsent,
      ipConsent,
      clientLatitude,
      clientLongitude,
    } = req.body;

    // ✅ Validate consent
    if (!validateConsent(locationConsent, ipConsent)) {
      return res.status(400).json({
        isOk: false,
        message:
          "Please accept both location and IP address tracking consent to continue",
        error: "Consent required",
        status: 400,
      });
    }

    // ✅ Validate email
    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        isOk: false,
        message: "Invalid email",
        status: 400,
      });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const ipAddress = getIpAddress(req);
    const clientLocation = getClientLocation(req, clientLatitude, clientLongitude);

    console.log("Login attempt received");

    // ✅ Find user
    const { companyMaster, employee } = await findUserByEmail(sanitizedEmail);
    const resolved = resolveUserRole(companyMaster, employee);

    if (!resolved) {
      return res.status(404).json({
        isOk: false,
        message: "User not found",
        status: 404,
      });
    }

    const { user, userId, role } = resolved;

    // ✅ Check account lock
    const isLocked = await isAccountLocked(userId, email);
    if (isLocked) {
      return handleLockedAccount(res, userId, email);
    }

    // ✅ Check password
    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      return handleFailedPassword(res, userId, email, ipAddress, clientLocation);
    }

    // ✅ Successful login
    await recordSuccessfulLogin(userId, email, ipAddress, clientLocation);

    const superAdminCompany = await CompanyMasterModels.findOne({ isSuperAdmin: true }) ||
                              await CompanyMasterModels.findOne({ isSuperAdmin: false });
    const employeeCompany = employee 
      ? (await CompanyMasterModels.findById(employee.companyId) || await CompanyMasterModels.findOne({ isSuperAdmin: false }))
      : null;
    const dataToSend = user.toObject ? user.toObject() : user;

    if (superAdminCompany) {
      if (role === "EMPLOYEE" || (companyMaster && !companyMaster.isSuperAdmin)) {
        dataToSend.sidebarBgColor = superAdminCompany.sidebarBgColor;
        dataToSend.addButtonColor = superAdminCompany.addButtonColor;
        dataToSend.removeButtonColor = superAdminCompany.removeButtonColor;
        dataToSend.addButtonTextColor = superAdminCompany.addButtonTextColor;
        dataToSend.removeButtonTextColor = superAdminCompany.removeButtonTextColor;
        dataToSend.buttonStyle = superAdminCompany.buttonStyle;
        dataToSend.enableSearchMenu = superAdminCompany.enableSearchMenu !== false;
      }
    }

    if (employee && role === "EMPLOYEE" && employeeCompany) {
      dataToSend.companyName = employeeCompany.companyName;
      dataToSend.logo = employeeCompany.logo;
      dataToSend.favicon = employeeCompany.favicon;
      dataToSend.loginBanner = employeeCompany.loginBanner;
    }

    let permissions = [];
    let permissionsUpdatedAt = null;

    if (role === "EMPLOYEE") {
      ({ permissions, permissionsUpdatedAt } =
        await getEmployeePermissions(employee));
    }

    req.session.user = {
      id: userId.toString(),
      role,
      email: user.email || user.emailOffice,
      name: user.companyName || user.employeeName,
      roleId:
        employee?.roleId?._id?.toString() ||
        employee?.roleId?.toString() ||
        null,
      permissions,
      permissionsUpdatedAt,
      isSuperAdmin: companyMaster ? companyMaster.isSuperAdmin : false,
    };

    return res.status(200).json({
      isOk: true,
      message: "Login successful",
      data: dataToSend,
      role,
    });
  } catch (error) {
    console.error("Error in loginCompany:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getCurrentUserDetails = async (req, res) => {
  try {
    const userId = req.user.id;

    let user = null;
    let role = null;

    const companyMaster = await CompanyMasterModels.findById(userId)
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .exec();

    const employee = await EmployeeModels.findById(userId)
      .populate("departmentId")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .exec();

    if (!companyMaster && !employee) {
      return res.status(404).json({
        isOk: false,
        message: "Company or Employee not found",
        status: 404,
      });
    }

    if (!companyMaster) {
      user = employee;
      role = "EMPLOYEE";
    }

    if (!employee) {
      user = companyMaster;
      role = "ADMIN";
    }

    const superAdminCompany = await CompanyMasterModels.findOne({ isSuperAdmin: true }) ||
                              await CompanyMasterModels.findOne({ isSuperAdmin: false });
    const employeeCompany = employee 
      ? (await CompanyMasterModels.findById(employee.companyId) || await CompanyMasterModels.findOne({ isSuperAdmin: false }))
      : null;

    if (superAdminCompany) {
      if (employee || !companyMaster.isSuperAdmin) {
        const userObj = user.toObject ? user.toObject() : user;
        userObj.sidebarBgColor = superAdminCompany.sidebarBgColor;
        userObj.addButtonColor = superAdminCompany.addButtonColor;
        userObj.removeButtonColor = superAdminCompany.removeButtonColor;
        userObj.addButtonTextColor = superAdminCompany.addButtonTextColor;
        userObj.removeButtonTextColor = superAdminCompany.removeButtonTextColor;
        userObj.buttonStyle = superAdminCompany.buttonStyle;
        userObj.enableSearchMenu = superAdminCompany.enableSearchMenu !== false;
        user = userObj;
      }
    }

    if (employee && employeeCompany) {
      const userObj = user.toObject ? user.toObject() : user;
      userObj.companyName = employeeCompany.companyName;
      userObj.logo = employeeCompany.logo;
      userObj.favicon = employeeCompany.favicon;
      userObj.loginBanner = employeeCompany.loginBanner;
      user = userObj;
    }

    return res.status(200).json({
      isOk: true,
      data: user,
      role: role,
      status: 200,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getAdminList = async (req, res) => {
  try {
    const admins = await CompanyMasterModels.find({ isSuperAdmin: false })
      .select("-password")
      .populate("countryId")
      .populate("stateId")
      .populate("cityId")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      isOk: true,
      data: admins,
      total: admins.length,
      status: 200,
    });
  } catch (error) {
    console.error("Error in getAdminList", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

export const getPublicCompanyDetails = async (req, res) => {
  try {
    const { email } = req.query;
    let company = null;

    if (email && typeof email === "string" && email.trim()) {
      const sanitizedEmail = email.trim().toLowerCase();
      const { companyMaster, employee } = await findUserByEmail(sanitizedEmail);

      if (companyMaster) {
        company = companyMaster;
      } else if (employee && employee.companyId) {
        company = await CompanyMasterModels.findById(employee.companyId);
      }
    }

    // Fallback: Default to first non-superadmin company
    if (!company) {
      company = await CompanyMasterModels.findOne({
        isSuperAdmin: false,
      });
    }

    if (!company) {
      return res.status(404).json({
        isOk: false,
        message: "Company not found",
        status: 404,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: {
        companyName: company.companyName,
        logo: company.logo,
        favicon: company.favicon,
        loginBanner: company.loginBanner,
      },
      status: 200,
    });
  } catch (error) {
    console.error("Error in getPublicCompanyDetails", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const deleteCompanyMaster = async (req, res) => {
  try {
    const companyId = req.params.id;
    const company = await CompanyMasterModels.findById(companyId);

    if (!company) {
      return res.status(404).json({
        isOk: false,
        message: "Company Master not found",
      });
    }

    // Delete custom uploaded assets
    deleteFileIfExists(company.logo);
    deleteFileIfExists(company.favicon);
    deleteFileIfExists(company.loginBanner);

    await CompanyMasterModels.findByIdAndDelete(companyId);

    return res.status(200).json({
      isOk: true,
      message: "Company Master deleted successfully",
    });
  } catch (error) {
    console.error("Error in deleteCompanyMaster", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

export const getCompanyById = async (req, res) => {
  try {
    const companyId = req.params.id;
    const company = await CompanyMasterModels.findById(companyId);

    if (!company) {
      return res.status(404).json({
        isOk: false,
        message: "Company Master not found",
      });
    }

    return res.status(200).json({
      isOk: true,
      data: company,
    });
  } catch (error) {
    console.error("Error in getCompanyById", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};