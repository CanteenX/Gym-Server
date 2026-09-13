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



/**
 * ✅ Helper: find user by email
 *
 * THE ONLY PLACE IN THIS FILE THAT MAY ASK FOR THE PASSWORD HASH.
 * `password` is `select: false` on CompanyMaster (models/CompanyMaster.js), so
 * every other query in the codebase gets a document with no hash on it at all —
 * which is why returning a whole company/employee row is no longer a leak.
 * loginCompany needs the hash for bcrypt.compare, so it opts back in here with
 * `+password`, and only here.
 *
 * The Employee query opts in too even though Employee.password is still
 * selected by default: `+password` is a no-op on a selected field, and it means
 * staff login through this endpoint keeps working the moment someone finishes
 * the job and makes Employee.password `select: false` as well.
 *
 * The hash still never reaches the client: loginCompany serialises through
 * toObject(), and both schemas strip `password` in their toJSON/toObject
 * transforms.
 */
const findUserByEmail = async (sanitizedEmail) => {
  const safeEmail = typeof sanitizedEmail === "string" ? sanitizedEmail.trim().toLowerCase() : "";

  const companyMaster = await CompanyMasterModels.findOne({
    email: safeEmail,
    isActive: true,
  })
    .select("+password")
    .populate("countryId")
    .populate("stateId")
    .populate("cityId")
    .exec();

  const employee = await EmployeeModels.findOne({
    emailOffice: safeEmail,
    isActive: true,
  })
    .select("+password")
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
const handleFailedPassword = async (res, userId, email) => {
  const attemptResult = await recordFailedAttempt(userId, email);

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

/**
 * The permission snapshot for ANY staff account that carries a roleId.
 *
 * Named for Employee because that is the only table that had a roleId when it
 * was written, but the lookup is by roleId alone and nothing in it is
 * Employee-specific. CompanyMaster now carries an optional roleId too (see
 * models/CompanyMaster.js), because a branch-level CompanyMaster admin is no
 * longer waved through by the permission gate and therefore needs a real grant
 * set like everybody else. An account with no roleId gets an empty snapshot,
 * exactly as before.
 */
const getEmployeePermissions = async (account) => {
  let permissions = [];
  let permissionsUpdatedAt = null;

  const roleId = account?.roleId?._id || account?.roleId;
  if (!roleId) return { permissions, permissionsUpdatedAt };

  const employeeRole = await EmployeeRoles.findOne({
    roleId,
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
    } = req.body;

    // Consent is no longer collected and neither is the client IP or location:
    // the login form asks for email and password only. An earlier gate rejected
    // any request without both consent flags with a 400, which is why removing
    // the checkboxes broke login outright. Nothing about the request origin is
    // recorded now - see services/authService.js.

    // ✅ Validate email
    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        isOk: false,
        message: "Invalid email",
        status: 400,
      });
    }

    const sanitizedEmail = email.trim().toLowerCase();

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
      return handleFailedPassword(res, userId, email);
    }

    // ✅ Successful login
    await recordSuccessfulLogin(userId, email);

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

    /**
     * Permissions are loaded for WHOEVER JUST AUTHENTICATED, keyed on their
     * roleId — not for `role === "EMPLOYEE"` only.
     *
     * While the permission gate bypassed on the role string, a CompanyMaster
     * login needed no grants and this correctly skipped the lookup. Now that
     * only a super admin bypasses, a branch-level CompanyMaster admin is
     * subject to the same checks as everyone else, and loading nothing for them
     * would 403 every gated screen with "No permissions found for this role" —
     * a total lockout dressed up as a permissions message. Keyed on the
     * authenticated user, so an account with no roleId still gets an empty
     * snapshot and nothing changes for it.
     */
    let permissions = [];
    let permissionsUpdatedAt = null;

    ({ permissions, permissionsUpdatedAt } =
      await getEmployeePermissions(user));

    req.session.user = {
      id: userId.toString(),
      role,
      email: user.email || user.emailOffice,
      name: user.companyName || user.employeeName,
      /**
       * From the AUTHENTICATED user, not from `employee`.
       *
       * findUserByEmail() looks BOTH tables up and returns both hits;
       * resolveUserRole() then picks one as the account that actually logged
       * in. Reading `employee?.…` here ignored that decision: when a
       * CompanyMaster and an Employee happen to share an address, the
       * CompanyMaster authenticates but the session was stamped with the
       * Employee's roleId, branch and super-admin flag. That is one account
       * silently wearing another's privileges, and it could only ever be found
       * by someone re-reading this function.
       */
      roleId:
        user?.roleId?._id?.toString() || user?.roleId?.toString() || null,
      permissions,
      permissionsUpdatedAt,
      /**
       * Super-admin status has TWO sources, and both must be honoured.
       *
       * Historically it lived only on CompanyMaster, so this read
       * `companyMaster ? companyMaster.isSuperAdmin : false` — which silently
       * returned false for every Employee login. An Employee created through
       * Setup → Employee with the "Super Admin (both branches)" box ticked
       * therefore logged in as an ordinary user: the checkbox that grants the
       * flag is itself gated on having the flag, so ticking it achieved
       * nothing and the account could never administer anything.
       *
       * `user` is whichever table authenticated, so BOTH sources are covered by
       * one read and neither table can lend its flag to the other. This field
       * is now the ONLY thing standing between a branch admin and the whole
       * system — checkPermission and cmsPermission bypass on it — so a false
       * negative locks the owner out and a false positive hands a branch the
       * CMS. `=== true`, never truthiness: absent is a third state, resolved in
       * middlewares/superAdmin.js, not guessed at here.
       */
      isSuperAdmin: user?.isSuperAdmin === true,
      /**
       * The branch this session is scoped to; null means all branches.
       *
       * Without this, scopedBranch() in middlewares/branchScope.js reads
       * undefined for everyone and concludes "no restriction" — handing every
       * branch admin both branches, silently and with nothing logged.
       */
      branch: user?.branch ?? null,
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
      // `companyMaster?.` — NOT `companyMaster.`. For an Employee login this is
      // null, and the unguarded read threw a TypeError here. That crashed
      // /auth/me, which the admin app calls immediately after signing in to
      // confirm the session — so the login appeared to succeed and then bounced
      // straight back to the login screen with no error anyone could see.
      if (employee || !companyMaster?.isSuperAdmin) {
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