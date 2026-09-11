import EmployeeRoles from "../../models/EmployeeRoles.js";
import Employee from "../../models/Employee.js";
import RoleMaster from "../../models/RoleMaster.js";
import mongoose from "mongoose";

const PERMISSION_KEYS = ["read", "write", "edit", "delete", "print", "mail"];

const processRoles = (roles) =>
  roles.map((role) => ({
    menuId: role.menuId ? role.menuId.toString() : null,
    menuGroupId: role.menuGroupId ? role.menuGroupId.toString() : null,
    read: role.read || false,
    write: role.write || false,
    delete: role.delete || false,
    edit: role.edit || false,
    print: role.print || false,
    mail: role.mail || false,
  }));

const buildPermissionMap = (permissions) => {
  const permissionMap = {};

  for (const perm of permissions) {
    if (perm.menuId) {
      permissionMap[perm.menuId] = perm;
    }
  }

  return permissionMap;
};

const getPermissionViolations = (callerPermissions, requestedRoles) => {
  const callerPermMap = buildPermissionMap(callerPermissions);
  const violations = [];

  for (const requested of requestedRoles) {
    if (!requested.menuId) continue;

    const callerPerm = callerPermMap[requested.menuId];

    for (const key of PERMISSION_KEYS) {
      // ✅ Fix 1: optional chaining instead of !callerPerm || callerPerm[key]
      if (requested[key] === true && callerPerm?.[key] !== true) {
        violations.push({
          menuId: requested.menuId,
          permission: key,
        });
      }
    }
  }

  return violations;
};

const countViolationsInRoles = (roles, updatedPermMap) => {
  let count = 0;
  for (const subPerm of roles) {
    if (!subPerm.menuId) continue;

    const parentPerm = updatedPermMap[subPerm.menuId.toString()];

    for (const key of PERMISSION_KEYS) {
      if (subPerm[key] === true && parentPerm?.[key] !== true) {
        count++;
      }
    }
  }
  return count;
};

const calculatePreviewImpact = async (safeRoleId, updatedPermMap, visited = new Set()) => {
  const safeRoleIdStr = typeof safeRoleId === "string" ? safeRoleId.trim() : (safeRoleId ? safeRoleId.toString() : "");
  const isValidObjectId = mongoose.Types.ObjectId.isValid(safeRoleIdStr);
  if (!isValidObjectId) return 0;

  if (visited.has(safeRoleIdStr)) return 0;
  visited.add(safeRoleIdStr);

  const ownerEmployees = await Employee.find({
    roleId: new mongoose.Types.ObjectId(safeRoleIdStr),
  }).select("_id");
  if (ownerEmployees.length === 0) return 0;

  const ownerEmployeeIds = ownerEmployees.map((e) => e._id);

  const subordinateRoles = await RoleMaster.find({
    createdBy: { $in: ownerEmployeeIds },
  }).select("_id");

  const subordinateRoleIds = subordinateRoles.map((r) => r._id);
  if (subordinateRoleIds.length === 0) return 0;

  const subEmployeeRoles = await EmployeeRoles.find({
    roleId: { $in: subordinateRoleIds },
  });

  let affectedCount = 0;
  for (const subRole of subEmployeeRoles) {
    const roleAffectedCount = countViolationsInRoles(subRole.roles || [], updatedPermMap);
    if (roleAffectedCount > 0) {
      affectedCount += roleAffectedCount;

      // Calculate post-strip permissions for this subRole to pass down recursively
      const subUpdatedPerms = (subRole.roles || []).map((subPerm) => {
        const parentPerm = updatedPermMap[subPerm.menuId?.toString()];
        const newPerm = typeof subPerm.toObject === "function" ? subPerm.toObject() : { ...subPerm };
        for (const key of PERMISSION_KEYS) {
          if (subPerm[key] === true && parentPerm?.[key] !== true) {
            newPerm[key] = false;
          }
        }
        return newPerm;
      });

      const subUpdatedPermMap = {};
      for (const perm of subUpdatedPerms) {
        if (perm.menuId) subUpdatedPermMap[perm.menuId.toString()] = perm;
      }

      const subRoleRoleIdStr = subRole.roleId ? subRole.roleId.toString() : "";
      affectedCount += await calculatePreviewImpact(subRoleRoleIdStr, subUpdatedPermMap, visited);
    }
  }

  return affectedCount;
};

export const createEmployeeRoles = async (req, res) => {
  try {
    const { roleId, roles, preview } = req.body;
    const sessionUser = req.session.user;

    const safeRoleId = typeof roleId === "string" ? roleId.trim() : "";

    if (!Array.isArray(roles)) {
      return res.status(400).json({
        isOk: false,
        message: "Roles must be an array",
      });
    }

    const processedRoles = processRoles(roles);

    // ── PREVIEW: check impact before saving ────────────────────────
    if (preview) {
      const updatedPermMap = {};
      for (const perm of processedRoles) {
        if (perm.menuId) updatedPermMap[perm.menuId] = perm;
      }

      const affectedCount = await calculatePreviewImpact(safeRoleId, updatedPermMap);

      return res.json({
        isOk: true,
        preview: true,
        hasImpact: affectedCount > 0,
        affectedCount,
      });
    }
    // ──────────────────────────────────────────────────────────────

    if (sessionUser.role === "EMPLOYEE") {
      if (String(sessionUser.roleId) === String(safeRoleId)) {
        return res.status(403).json({
          isOk: false,
          message: "You cannot modify your own role permissions.",
        });
      }

      const violations = getPermissionViolations(
        sessionUser.permissions,
        processedRoles,
      );

      if (violations.length > 0) {
        return res.status(403).json({
          isOk: false,
          message: "You cannot give more permissions than you have yourself.",
          violations,
        });
      }
    }

    const employeeRoles = await EmployeeRoles.create({
      roleId: safeRoleId,
      roles: processedRoles,
    });

    return res.status(200).json({
      isOk: true,
      message: "Employee roles created successfully",
      data: employeeRoles,
    });
  } catch (error) {
    // ✅ Fix 3: console.log → console.error
    console.error(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

export const getEmployeeRoles = async (req, res) => {
  try {
    const { roleId } = req.params;
    const safeRoleId = typeof roleId === "string" ? roleId.trim() : "";
    const employeeRoles = await EmployeeRoles.find({ roleId: safeRoleId });

    if (!employeeRoles?.length) {
      return res.status(200).json({
        isOk: true,
        message: "No roles assigned yet",
        data: [],
      });
    }

    return res.status(200).json({
      isOk: true,
      data: employeeRoles,
    });
  } catch (error) {
    // ✅ Fix 4: console.log → console.error
    console.error(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};

const processSubRolePreview = (subRole, subordinateRoles, updatedPermMap) => {
  const roleMaster = subordinateRoles.find(
    (r) => r._id.toString() === subRole.roleId.toString(),
  );

  const affectedPermissions = [];
  let roleAffectedCount = 0;

  for (const subPerm of subRole.roles || []) {
    if (!subPerm.menuId) continue;

    const parentPerm = updatedPermMap[subPerm.menuId.toString()];
    const strippedKeys = [];

    for (const key of PERMISSION_KEYS) {
      if (subPerm[key] === true && parentPerm?.[key] !== true) {
        strippedKeys.push(key);
        roleAffectedCount++;
      }
    }

    if (strippedKeys.length > 0) {
      affectedPermissions.push({
        menuId: subPerm.menuId,
        permissions: strippedKeys,
      });
    }
  }

  return {
    affectedPermissions,
    roleAffectedCount,
    roleMaster,
  };
};

const calculateUpdatePreviewImpact = async (safeRoleId, updatedPermMap, visited = new Set()) => {
  const safeRoleIdStr = typeof safeRoleId === "string" ? safeRoleId.trim() : (safeRoleId ? safeRoleId.toString() : "");
  const isValidObjectId = mongoose.Types.ObjectId.isValid(safeRoleIdStr);
  if (!isValidObjectId) return { affectedCount: 0, affectedRoles: [] };

  if (visited.has(safeRoleIdStr)) return { affectedCount: 0, affectedRoles: [] };
  visited.add(safeRoleIdStr);

  const ownerEmployees = await Employee.find({
    roleId: new mongoose.Types.ObjectId(safeRoleIdStr),
  }).select("_id");

  let affectedCount = 0;
  const affectedRoles = [];

  const ownerEmployeeIds = ownerEmployees.map((e) => e._id);
  if (ownerEmployeeIds.length > 0) {
    const subordinateRoles = await RoleMaster.find({
      createdBy: { $in: ownerEmployeeIds },
    }).select("_id roleName");

    const subordinateRoleIds = subordinateRoles.map((r) => r._id);

    if (subordinateRoleIds.length > 0) {
      const subEmployeeRoles = await EmployeeRoles.find({
        roleId: { $in: subordinateRoleIds },
      });

      for (const subRole of subEmployeeRoles) {
        const { affectedPermissions, roleAffectedCount, roleMaster } = processSubRolePreview(subRole, subordinateRoles, updatedPermMap);

        if (roleAffectedCount > 0) {
          affectedCount += roleAffectedCount;
          affectedRoles.push({
            roleId: subRole.roleId,
            roleName: roleMaster?.roleName || "Unknown Role",
            affectedPermissions,
          });

          // Calculate post-strip permissions for this subRole to pass down recursively
          const subUpdatedPerms = (subRole.roles || []).map((subPerm) => {
            const parentPerm = updatedPermMap[subPerm.menuId?.toString()];
            const newPerm = typeof subPerm.toObject === "function" ? subPerm.toObject() : { ...subPerm };
            for (const key of PERMISSION_KEYS) {
              if (subPerm[key] === true && parentPerm?.[key] !== true) {
                newPerm[key] = false;
              }
            }
            return newPerm;
          });

          const subUpdatedPermMap = {};
          for (const perm of subUpdatedPerms) {
            if (perm.menuId) subUpdatedPermMap[perm.menuId.toString()] = perm;
          }

          const subRoleRoleIdStr = subRole.roleId ? subRole.roleId.toString() : "";
          const subImpact = await calculateUpdatePreviewImpact(subRoleRoleIdStr, subUpdatedPermMap, visited);
          affectedCount += subImpact.affectedCount;
          affectedRoles.push(...subImpact.affectedRoles);
        }
      }
    }
  }

  return { affectedCount, affectedRoles };
};

const processAndStripSubRolePermissions = (subRole, updatedPermMap) => {
  let changed = false;

  const updatedSubRoles = (subRole.roles || []).map((subPerm) => {
    if (!subPerm.menuId) return subPerm;

    const parentPerm = updatedPermMap[subPerm.menuId.toString()];
    const newPerm = typeof subPerm.toObject === "function" ? subPerm.toObject() : { ...subPerm };

    for (const key of PERMISSION_KEYS) {
      if (subPerm[key] === true && parentPerm?.[key] !== true) {
        newPerm[key] = false;
        changed = true;
      }
    }

    return newPerm;
  });

  return {
    updatedSubRoles,
    changed,
  };
};

const cascadePermissionStrip = async (employeeRoles, processedRoles, visited = new Set()) => {
  try {
    const updatedPermMap = {};
    for (const perm of processedRoles) {
      if (perm.menuId) updatedPermMap[perm.menuId.toString()] = perm;
    }

    const employeeRoleId = employeeRoles?.roleId;
    const employeeRoleIdStr = employeeRoleId ? employeeRoleId.toString() : "";
    const isValidObjectId = mongoose.Types.ObjectId.isValid(employeeRoleIdStr);
    if (!isValidObjectId) return;

    // Avoid infinite recursion in case of cyclic roles
    if (visited.has(employeeRoleIdStr)) return;
    visited.add(employeeRoleIdStr);

    const ownerEmployees = await Employee.find({
      roleId: new mongoose.Types.ObjectId(employeeRoleIdStr),
    }).select("_id");
    if (ownerEmployees.length === 0) return;

    const ownerEmployeeIds = ownerEmployees.map((emp) => emp._id);

    const subordinateRoles = await RoleMaster.find({
      createdBy: { $in: ownerEmployeeIds },
    }).select("_id");

    const subordinateRoleIds = subordinateRoles.map((r) => r._id);
    if (subordinateRoleIds.length === 0) return;

    const subordinateEmployeeRoles = await EmployeeRoles.find({
      roleId: { $in: subordinateRoleIds },
    });

    for (const subRole of subordinateEmployeeRoles) {
      const { updatedSubRoles, changed } = processAndStripSubRolePermissions(subRole, updatedPermMap);

      if (changed) {
        const updatedSubRole = await EmployeeRoles.findByIdAndUpdate(
          subRole._id,
          { roles: updatedSubRoles },
          { new: true },
        );
        // Recursively strip permissions from downstream roles
        await cascadePermissionStrip(updatedSubRole, updatedSubRoles, visited);
      }
    }
  } catch (cascadeErr) {
    console.error("Cascade permission update error:", cascadeErr.message);
  }
};

const checkUpdatePermissions = async (sessionUser, safeRoleId, processedRoles) => {
  if (sessionUser.role === "ADMIN") {
    const isValidRole = typeof safeRoleId === "string" && /^[0-9a-fA-F]{24}$/.test(safeRoleId);
    if (!isValidRole) {
      return { isOk: false, status: 400, message: "Invalid role ID format" };
    }
    const targetRole = await RoleMaster.findById(safeRoleId).select("createdBy");
    if (targetRole && targetRole.createdBy !== null) {
      return {
        isOk: false,
        status: 403,
        message: "You cannot modify permissions for roles created by employees.",
      };
    }
  }

  if (sessionUser.role === "EMPLOYEE") {
    if (String(sessionUser.roleId) === String(safeRoleId)) {
      return {
        isOk: false,
        status: 403,
        message: "You cannot modify your own role permissions.",
      };
    }

    const violations = getPermissionViolations(sessionUser.permissions, processedRoles);
    if (violations.length > 0) {
      return {
        isOk: false,
        status: 403,
        message: "You cannot give more permissions than you have yourself.",
        violations,
      };
    }
  }

  return { isOk: true };
};

const handleUpdatePreview = async (processedRoles, safeRoleId) => {
  const updatedPermMap = {};
  for (const perm of processedRoles) {
    if (perm.menuId) updatedPermMap[perm.menuId] = perm;
  }

  const { affectedCount, affectedRoles } = await calculateUpdatePreviewImpact(safeRoleId, updatedPermMap);

  return {
    isOk: true,
    preview: true,
    hasImpact: affectedCount > 0,
    affectedCount,
    affectedRoles,
  };
};

export const updateEmployeeRoles = async (req, res) => {
  try {
    const { roles, roleId, preview } = req.body;
    const paramId = req.params.id;
    const sessionUser = req.session.user;

    const safeRoleId = typeof roleId === "string" ? roleId.trim() : "";
    const safeParamId = typeof paramId === "string" ? paramId.trim() : "";
    const safeId = safeParamId || safeRoleId;

    const isValidId = typeof safeId === "string" && /^[0-9a-fA-F]{24}$/.test(safeId);
    if (!isValidId) {
      return res.status(400).json({
        isOk: false,
        message: "Invalid ID format",
      });
    }

    if (!Array.isArray(roles)) {
      return res.status(400).json({
        isOk: false,
        message: "Roles must be an array",
      });
    }

    const processedRoles = processRoles(roles);

    if (preview) {
      const previewResult = await handleUpdatePreview(processedRoles, safeRoleId);
      return res.json(previewResult);
    }

    const permissionCheck = await checkUpdatePermissions(sessionUser, safeRoleId, processedRoles);
    if (!permissionCheck.isOk) {
      return res.status(permissionCheck.status).json({
        isOk: false,
        message: permissionCheck.message,
        ...(permissionCheck.violations ? { violations: permissionCheck.violations } : {}),
      });
    }

    let employeeRoles = await EmployeeRoles.findByIdAndUpdate(
      safeId,
      { roles: processedRoles },
      { new: true },
    );

    if (!employeeRoles) {
      employeeRoles = await EmployeeRoles.findOneAndUpdate(
        { roleId: safeId },
        { roles: processedRoles },
        { new: true },
      );
    }

    if (!employeeRoles) {
      return res.status(404).json({
        isOk: false,
        message: "Employee roles not found",
      });
    }

    // ── CASCADE: strip permissions from subordinate roles ──────────
    await cascadePermissionStrip(employeeRoles, processedRoles);
    // ──────────────────────────────────────────────────────────────

    return res.status(200).json({
      isOk: true,
      message: "Employee roles updated successfully",
      data: employeeRoles,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
    });
  }
};