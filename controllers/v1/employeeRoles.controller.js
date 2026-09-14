import EmployeeRoles from "../../models/EmployeeRoles.js";
import Employee from "../../models/Employee.js";
import RoleMaster from "../../models/RoleMaster.js";
import mongoose from "mongoose";
import { isSuperAdminSession } from "../../middlewares/superAdmin.js";
/**
 * The ceiling comparison moved to middlewares/roleCeiling.js.
 *
 * Not a refactor for tidiness. There are TWO roads to giving somebody a
 * capability - editing a role's permissions (here) and assigning an existing
 * role to a person (employee.controller.js) - and only this one was guarded.
 * One comparison now serves both, because a rule written twice is a rule that
 * drifts, and the drift is invisible: the wrong answer is silence.
 */
import {
  PERMISSION_KEYS,
  buildPermissionMap,
  getPermissionViolations,
} from "../../middlewares/roleCeiling.js";


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



/**
 * What a caller with NO permission set of their own is told.
 *
 * A CompanyMaster row has no `roleId`, therefore no EmployeeRoles document,
 * therefore an empty `permissions` array on its session. Run through the
 * escalation ceiling below, "what they hold" is nothing, so EVERY box they tick
 * is a violation and the honest answer is a 403 — but a 403 whose message is
 * "you cannot give more permissions than you have yourself" plus a list of
 * sixty violations reads as a bug, not as an instruction, and the owner has no
 * way to work out that the real problem is that the account was never given a
 * role. So this case gets its own sentence naming the fix.
 *
 * WE REFUSE OUTRIGHT rather than reading it as "may grant nothing":
 *   - "may grant nothing" would still let such an account WIPE another role's
 *     permissions (every box false is zero violations), which is how you lock
 *     the other branch's manager out of their own panel. Taking permissions
 *     away is exactly as privileged as handing them out.
 *   - An account that holds no permissions has no basis to administer anyone
 *     else's, and the repair is a one-line admin action, not a code change.
 * Failing closed here costs a real super admin nothing: they never reach this
 * function (see authorizeRolePermissionWrite).
 */
const NO_OWN_PERMISSIONS_MESSAGE =
  "This account has no permission set of its own, so it cannot change anyone else's. " +
  "A super admin must either assign this account a role and grant that role permissions, " +
  "or mark the account as a super admin.";

/**
 * True when one of the ids this request is about to write IS the caller's own
 * role.
 *
 * TWO IDS ARE CHECKED on the update path on purpose. updateEmployeeRoles
 * resolves the document to write as `req.params.id || req.body.roleId`, but the
 * old self-check only ever compared `req.body.roleId`. Omitting `roleId` from
 * the body and putting your own role id in the URL therefore walked straight
 * past it. The escalation ceiling below still bounded what such a request could
 * achieve, so this was never a way to gain a permission — but the guard is
 * cheap and it should mean what it says.
 *
 * @param {object} sessionUser req.session.user
 * @param {Array<unknown>} targetIds every id this write could resolve to
 * @returns {boolean}
 */
const isOwnRole = (sessionUser, targetIds) => {
  const ownRoleId = sessionUser?.roleId ? String(sessionUser.roleId) : "";
  if (!ownRoleId) return false;

  return (targetIds || []).some(
    (id) => id !== undefined && id !== null && String(id) === ownRoleId,
  );
};

/**
 * THE ESCALATION CEILING: you may not hand out a permission you do not hold.
 *
 * Applied to every session that is not the super admin, from EITHER staff
 * table. It used to be applied to `role === "EMPLOYEE"` only, and `role` says
 * which table you logged in from, not how much you may do (middlewares/
 * superAdmin.js). A branch-level CompanyMaster admin — `role: "ADMIN"`,
 * `isSuperAdmin: false` — holding `edit` on /employee-roles could therefore
 * write themselves a role carrying the CMS, the SEO manager and the audit log,
 * which are super-admin-only precisely BECAUSE they are granted to nobody.
 * Granting yourself the thing nobody was granted defeats the whole model.
 *
 * `sessionUser.permissions` is trustworthy at this point: both write routes run
 * checkPermission("/employee-roles", …) first, which calls
 * ensurePermissionsFresh() and reloads a stale snapshot from EmployeeRoles. We
 * do not re-read it here — that would be a second round-trip for the same
 * answer — but we also do not assume it is non-empty.
 *
 * @param {object} sessionUser req.session.user — NEVER req.user, which carries
 *   no permissions at all and would read as "holds nothing" for everyone.
 * @param {Array<object>} processedRoles the permission rows being written
 */
const checkEscalationCeiling = (sessionUser, processedRoles) => {
  const callerPermissions = Array.isArray(sessionUser?.permissions)
    ? sessionUser.permissions
    : [];

  if (callerPermissions.length === 0) {
    return { isOk: false, status: 403, message: NO_OWN_PERMISSIONS_MESSAGE };
  }

  const violations = getPermissionViolations(callerPermissions, processedRoles);
  if (violations.length > 0) {
    return {
      isOk: false,
      status: 403,
      message: "You cannot give more permissions than you have yourself.",
      violations,
    };
  }

  return { isOk: true };
};

/**
 * The ONE authorisation answer for both role-permission writes (create and
 * update). Returns `{ isOk: true }` or a `{ status, message }` to send back.
 *
 * ORDER MATTERS, and it is:
 *   1. the table-specific structural rules, UNCHANGED — an ADMIN may not touch
 *      a role an employee created; an EMPLOYEE may not touch their own role.
 *      These are ownership conventions, not privilege levels, so they stay
 *      keyed on the role string and they still apply to a super admin.
 *   2. the super admin short-circuit. They are the account that hands
 *      permissions out; a ceiling of "only what you already hold" would make it
 *      impossible for anyone to ever be granted anything.
 *   3. everybody else: not your own role, and nothing above your own ceiling.
 *
 * @param {import("express").Request} req
 * @param {object} options
 * @param {string} options.safeRoleId trimmed req.body.roleId
 * @param {Array<unknown>} options.targetIds every id this write could resolve to
 * @param {Array<object>} options.processedRoles permission rows being written
 * @param {boolean} options.enforceTargetRoleOwnership run rule 1's ADMIN half.
 *   True on update only, exactly as before this change: create has never
 *   carried it, and adding it here would 403 the first save of permissions for
 *   an employee-created role — a behaviour change with no security value, since
 *   rule 3 already bounds what that first save may contain.
 */
const authorizeRolePermissionWrite = async (
  req,
  { safeRoleId, targetIds, processedRoles, enforceTargetRoleOwnership = false },
) => {
  // ALWAYS req.session.user. authMiddleware builds req.user from four fields
  // (id, role, email, name): no permissions, no roleId, no isSuperAdmin, no
  // branch. A check written against it denies everyone or, negated, grants
  // everyone. See middlewares/branchScope.js.
  const sessionUser = req?.session?.user;

  if (!sessionUser) {
    return { isOk: false, status: 401, message: "Not logged in" };
  }

  // ── 1. structural rules, per table ────────────────────────────────
  if (sessionUser.role === "ADMIN" && enforceTargetRoleOwnership) {
    const isValidRole =
      typeof safeRoleId === "string" && /^[0-9a-fA-F]{24}$/.test(safeRoleId);
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

  if (sessionUser.role === "EMPLOYEE" && isOwnRole(sessionUser, targetIds)) {
    return {
      isOk: false,
      status: 403,
      message: "You cannot modify your own role permissions.",
    };
  }

  // ── 2. the super admin, and ONLY the super admin, is unbounded ────
  if (isSuperAdminSession(req)) {
    return { isOk: true };
  }

  // ── 3. everyone else, from either table ───────────────────────────
  // A CompanyMaster may now carry a roleId, so "not your own role" is not an
  // employees-only rule any more.
  if (isOwnRole(sessionUser, targetIds)) {
    return {
      isOk: false,
      status: 403,
      message: "You cannot modify your own role permissions.",
    };
  }

  return checkEscalationCeiling(sessionUser, processedRoles);
};

/** Sends an authorisation refusal in the repo's standard envelope. */
const sendAuthorizationFailure = (res, authorization) =>
  res.status(authorization.status).json({
    isOk: false,
    message: authorization.message,
    ...(authorization.violations
      ? { violations: authorization.violations }
      : {}),
  });

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

    /**
     * SAME GATE AS THE UPDATE PATH. This used to check `role === "EMPLOYEE"`
     * only, so a branch-level CompanyMaster admin could POST a brand-new
     * permission set carrying anything at all — the identical hole the update
     * path had, one endpoint over. Creating and editing a role's permissions
     * must cost the same privilege or the cheaper one is simply the one that
     * gets used.
     */
    const authorization = await authorizeRolePermissionWrite(req, {
      safeRoleId,
      targetIds: [safeRoleId],
      processedRoles,
    });

    if (!authorization.isOk) {
      return sendAuthorizationFailure(res, authorization);
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
        data: null,
      });
    }

    /**
     * ONE document, not an array.
     *
     * There is exactly one EmployeeRoles document per role, and every consumer
     * reads `data.roles` — MenuContext does `roles?.roles` to build the sidebar.
     * Returning the raw find() array meant `data.roles` was undefined, so every
     * non-admin user got an empty menu with no error anywhere: the request was
     * a clean 200 carrying the right data in the wrong shape.
     */
    return res.status(200).json({
      isOk: true,
      data: employeeRoles[0],
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

    const authorization = await authorizeRolePermissionWrite(req, {
      safeRoleId,
      // Both ids, because `safeId` is what actually gets written — see isOwnRole.
      targetIds: [safeRoleId, safeId],
      processedRoles,
      enforceTargetRoleOwnership: true,
    });

    if (!authorization.isOk) {
      return sendAuthorizationFailure(res, authorization);
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