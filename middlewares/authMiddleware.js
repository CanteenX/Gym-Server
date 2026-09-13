/**
 * Authentication Middleware using Express Session
 * Session storage is MongoDB (connect-mongo), so sessions SURVIVE A DEPLOY.
 *
 * ============================================================================
 * THE ROLE LIST HERE IS NOT A PRIVILEGE CHECK. DO NOT "FIX" IT.
 * ============================================================================
 *
 * authMiddleware(["ADMIN", "EMPLOYEE"]) answers ONE question: "is there a valid
 * staff session on this request, from one of these tables?" It is the door to
 * the staff API, and both staff tables must keep coming through it — narrowing
 * it to super admins would lock every employee and every branch admin out of
 * every staff route at once.
 *
 * "How much may this session do?" is a DIFFERENT question, asked afterwards by
 * checkPermission / cmsPermission / requireSuperAdmin, and answered from
 * `isSuperAdmin` plus the EmployeeRoles grants — never from the role string.
 * See middlewares/superAdmin.js.
 */
import EmployeeRoles from "../models/EmployeeRoles.js";
import {
  superAdminFlagMissing,
  resolveSuperAdminFlag,
} from "./superAdmin.js";

const refreshEmployeePermissions = async (sessionUser) => {
  if (sessionUser.role !== "EMPLOYEE" || !sessionUser.roleId) {
    return null;
  }

  try {
    const employeeRole = await EmployeeRoles.findOne({
      roleId: sessionUser.roleId,
      isActive: true,
    }).select("roles updatedAt");

    if (!employeeRole) return null;

    const sessionUpdatedAt = sessionUser.permissionsUpdatedAt
      ? new Date(sessionUser.permissionsUpdatedAt).getTime()
      : 0;
    const dbUpdatedAt = new Date(employeeRole.updatedAt).getTime();

    if (dbUpdatedAt > sessionUpdatedAt) {
      return {
        permissions: employeeRole.roles.map((r) => ({
          menuId: r.menuId?.toString(),
          menuGroupId: r.menuGroupId?.toString(),
          read: r.read,
          write: r.write,
          delete: r.delete,
          edit: r.edit,
          print: r.print,
          mail: r.mail,
        })),
        updatedAt: employeeRole.updatedAt,
      };
    }
  } catch (err) {
    console.error("Permission refresh error:", err.message);
  }
  return null;
};

export const authMiddleware = (roles) => {
  return async (req, res, next) => {
    // Check if user has an active session
    if (!req.session?.user) {
      // Clear the session cookie since it's invalid
      res.clearCookie("sessionId");
      return res.status(401).json({
        success: false,
        error: "Not logged in",
        status: 401,
        message: "Not logged in",
      });
    }

    const sessionUser = req.session.user;

    // Check if session has required data
    if (!sessionUser.id || !sessionUser.role) {
      // Clear the session cookie since it's invalid
      res.clearCookie("sessionId");
      return res.status(401).json({
        success: false,
        message: "Session invalid or expired",
        error: "Session invalid or expired",
        status: 401,
      });
    }

    // Check if user role is allowed
    if (roles && roles.length > 0 && !roles.includes(sessionUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
        error: "You do not have permission to access this resource",
        status: 403,
      });
    }

    // ── HEAL A PRE-DEPLOY SESSION THAT HAS NO isSuperAdmin ─────────
    //
    // This is the only place it can be done once and be true for the whole
    // request: it runs before every gate on every staff route, and the gates
    // themselves are synchronous by design. A session created before the login
    // paths started recording isSuperAdmin has no answer stored, and both
    // possible guesses are wrong in a way somebody pays for — so the flag is
    // re-derived from the account row and written back. One indexed lookup, per
    // stale session, once. See middlewares/superAdmin.js for the full argument.
    if (superAdminFlagMissing(req)) {
      await resolveSuperAdminFlag(req);
    }
    // ───────────────────────────────────────────────────────────────

    // Attach user data to request (compatible with existing code)
    // ── AUTO-REFRESH PERMISSIONS FOR EMPLOYEE ──────────────────────
    const refreshData = await refreshEmployeePermissions(sessionUser);
    if (refreshData) {
      req.session.user.permissions = refreshData.permissions;
      req.session.user.permissionsUpdatedAt = refreshData.updatedAt;
    }
    // ───────────────────────────────────────────────────────────────

    /**
     * DELIBERATELY STILL FOUR FIELDS. isSuperAdmin and branch are NOT copied
     * here, and that is not an oversight to be tidied up later: the entire
     * codebase's scoping and permission code is written against
     * req.session.user precisely because req.user is a lossy copy, and every
     * comment in branchScope.js / checkPermission.js / requestContext.js says
     * so. Adding the fields here would make those warnings false, and would
     * create a second copy that goes stale the moment anything (including the
     * healing above) updates the session mid-request.
     */
    req.user = {
      id: sessionUser.id,
      role: sessionUser.role,
      email: sessionUser.email,
      name: sessionUser.name,
    };

    next();
  };
};
