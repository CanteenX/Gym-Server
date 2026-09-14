import mongoose from "mongoose";
import EmployeeRoles from "../models/EmployeeRoles.js";
import RoleMaster from "../models/RoleMaster.js";
import { isSuperAdminSession } from "./superAdmin.js";

/**
 * THE ESCALATION CEILING, AND THE TWO ROADS THAT REACH IT.
 *
 * ============================================================================
 * WHY THIS MODULE EXISTS SEPARATELY FROM employeeRoles.controller.js
 * ============================================================================
 * "You may not hand out a permission you do not hold" was already enforced when
 * a role's PERMISSIONS are edited. But there are two ways to give somebody a
 * capability, and only one of them was guarded:
 *
 *   1. edit a role's permission rows       -> guarded (employeeRoles.controller)
 *   2. assign an existing role to a person -> NOT guarded, until now
 *
 * `createEmployee` and `updateEmployee` wrote `req.body.roleId` straight onto
 * the row. `/role-master` being reserved to the super admin was mistaken for a
 * control: it stops a branch admin LISTING roles, it does not stop them naming
 * an id. Not seeing a menu is not the same as being unable to type.
 *
 * Confirmed against production on 2026-09-14 as the Vasna branch admin: an
 * employee was created carrying the `SUPPORT` role, which exceeds a branch
 * admin's ceiling by 111 flag-grants — including `/employee-roles` and
 * `/menu-master` in full. Sign in as that account and it can grant itself
 * anything. (The probe was created inactive so it could never be signed into,
 * and deleted immediately.)
 *
 * The comparison is HERE rather than copied into a second controller because
 * this codebase has already been bitten by exactly that: a guard written twice,
 * with one copy counting the wrong collection, reading as correct in review
 * while being incapable of firing (see middlewares/superAdminFloor.js). Two
 * implementations of "is this above your ceiling" would drift the same way, and
 * the drift is invisible, because the wrong answer is silence.
 */

export const PERMISSION_KEYS = ["read", "write", "edit", "delete", "print", "mail"];

/**
 * Permission rows keyed by menuId, for O(1) lookup during comparison.
 *
 * @param {Array<object>} permissions
 * @returns {Record<string, object>}
 */
export const buildPermissionMap = (permissions) => {
  const permissionMap = {};

  for (const perm of permissions) {
    if (perm.menuId) {
      permissionMap[perm.menuId] = perm;
    }
  }

  return permissionMap;
};

/**
 * Every flag the request asks for that the caller does not themselves hold.
 *
 * Compared PER FLAG, not per menu. Holding `read` on /members does not entitle
 * you to hand out `delete` on /members, so a menu the caller partly holds is
 * still a partial escalation — which is why this loops the keys rather than
 * asking whether the menu appears at all.
 *
 * An empty array means "nothing above the ceiling", which is what callers
 * treat as allowed.
 *
 * @param {Array<object>} callerPermissions req.session.user.permissions
 * @param {Array<object>} requestedRoles the permission rows being granted
 * @returns {Array<{menuId: string, permission: string}>}
 */
export const getPermissionViolations = (callerPermissions, requestedRoles) => {
  const callerPermMap = buildPermissionMap(callerPermissions);
  const violations = [];

  for (const requested of requestedRoles) {
    if (!requested.menuId) continue;

    const callerPerm = callerPermMap[requested.menuId];

    for (const key of PERMISSION_KEYS) {
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

/**
 * The permission rows a RoleMaster row currently carries.
 *
 * `EmployeeRoles.roleId` is a FIELD, not the document's `_id` — the single most
 * repeated mistake against this collection, and it fails by returning null
 * rather than by throwing. The rows live under `roles`, not `permissions`.
 *
 * @param {string|import("mongoose").Types.ObjectId} roleId
 * @returns {Promise<Array<object>>}
 */
const permissionsForRole = async (roleId) => {
  const row = await EmployeeRoles.findOne({ roleId, isActive: true }).lean();
  return Array.isArray(row?.roles) ? row.roles : [];
};

/**
 * Normalises a stored permission row to the shape getPermissionViolations wants.
 *
 * `menuId` arrives as an ObjectId from the database and as a string from a
 * session snapshot. Compared without normalising, every single flag reads as an
 * escalation, which would lock out the very people this is meant to let work.
 */
const normalise = (row) => ({
  ...row,
  menuId: row.menuId ? String(row.menuId) : null,
});

/**
 * May this request assign this role to a member of staff?
 *
 * @param {import("express").Request} req
 * @param {unknown} roleId the roleId from the request body
 * @returns {Promise<string|null>} an error to refuse with, or null to allow
 */
export const roleAssignmentError = async (req, roleId) => {
  // Nothing being set is not an escalation. Whether roleId is REQUIRED is the
  // model's business (it is), not this guard's — conflating "missing" with
  // "forbidden" would produce a 403 for what is really a validation error.
  if (roleId === undefined || roleId === null || roleId === "") return null;

  /**
   * The super admin is the account that hands capability out. A ceiling of
   * "only what you already hold" would make it impossible for anyone to ever
   * be granted anything — the same short-circuit employeeRoles.controller.js
   * applies, and for the same reason.
   */
  if (isSuperAdminSession(req)) return null;

  /**
   * A malformed id is answered here; a DATABASE FAILURE IS NOT.
   *
   * This was briefly written as `.findById(roleId).catch(() => null)` followed
   * by "that role does not exist", which is the wrong shape entirely: a Mongo
   * hiccup would then present as an authorisation refusal, so every employee
   * save during an outage would tell the user their role was invalid. An
   * outage is a 500. Only a genuinely unusable id is answered as a 400-style
   * refusal, and real errors are allowed to propagate to the caller's own
   * try/catch.
   */
  if (!mongoose.Types.ObjectId.isValid(String(roleId))) {
    return "That role id is not valid.";
  }

  const role = await RoleMaster.findById(roleId).lean();
  if (!role) return "That role does not exist.";
  if (role.isActive === false) return "That role is inactive and cannot be assigned.";

  /**
   * req.session.user, NEVER req.user — req.user carries no permissions at all,
   * so reading it here would make every caller look like they hold nothing and
   * refuse every assignment including the legitimate ones.
   */
  const callerPermissions = Array.isArray(req.session?.user?.permissions)
    ? req.session.user.permissions
    : [];

  if (callerPermissions.length === 0) {
    return (
      "Your own account has no permissions loaded, so there is nothing to " +
      "measure this role against. Ask a super admin to assign staff roles."
    );
  }

  const requested = (await permissionsForRole(roleId)).map(normalise);
  const violations = getPermissionViolations(
    callerPermissions.map(normalise),
    requested,
  );

  if (violations.length === 0) return null;

  return (
    `You cannot assign the "${role.role || role.roleName || "selected"}" role — ` +
    `it grants ${violations.length} permission(s) you do not hold yourself. ` +
    "Ask a super admin to assign it."
  );
};

/**
 * The roles this request may legitimately put on a new member of staff.
 *
 * This is what the admin panel's Role dropdown reads. It is deliberately NOT
 * the roles screen: it returns ids and names and nothing else, for roles the
 * caller could already assign anyway, so it grants no information they could
 * not obtain by trying. Showing a role that would then be refused on save is
 * the worse design — the owner's report was an empty dropdown and an
 * unsaveable form, and a dropdown full of refusals is the same failure wearing
 * a different hat.
 *
 * A role equal to the caller's own is included: a branch can reasonably have a
 * second manager, and that is lateral, not an escalation.
 *
 * @param {import("express").Request} req
 * @returns {Promise<Array<{_id: any, role: string}>>}
 */
export const listAssignableRoles = async (req) => {
  const roles = await RoleMaster.find({ isActive: { $ne: false } })
    .select("role roleName")
    .lean();

  if (isSuperAdminSession(req)) return roles;

  const callerPermissions = Array.isArray(req.session?.user?.permissions)
    ? req.session.user.permissions.map(normalise)
    : [];

  if (callerPermissions.length === 0) return [];

  const allowed = [];
  for (const role of roles) {
    const requested = (await permissionsForRole(role._id)).map(normalise);
    /**
     * A role with NO permission rows is skipped rather than allowed.
     *
     * It trivially passes the subset test — granting nothing cannot exceed any
     * ceiling — but assigning it produces a login that can open nothing, which
     * reads to whoever receives it as a broken account rather than a deliberate
     * one. The empty-permission roles in this database are abandoned scaffolding.
     */
    if (requested.length === 0) continue;
    if (getPermissionViolations(callerPermissions, requested).length === 0) {
      allowed.push(role);
    }
  }

  return allowed;
};
