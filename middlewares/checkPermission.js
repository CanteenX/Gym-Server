import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";

/**
 * Check if session permissions are stale by comparing updatedAt timestamps
 * Only fetches updatedAt field — very lightweight DB call
 */
const isPermissionStale = async (sessionUser) => {
  try {
    const roleId = sessionUser?.roleId;
    if (!roleId) return false;

    const dbRole = await EmployeeRoles.findOne({ roleId, isActive: true })
      .select("updatedAt")
      .lean();

    if (!dbRole) return false;

    const sessionTime = new Date(sessionUser.permissionsUpdatedAt).getTime();
    const dbTime = new Date(dbRole.updatedAt).getTime();

    return sessionTime !== dbTime;
  } catch (error) {
    console.error("isPermissionStale error:", error);
    return false;
  }
};

/**
 * Reload full permissions from DB into session
 * Called only when timestamps don't match
 */
const refreshPermissions = async (req) => {
  try {
    const roleId = req.session?.user?.roleId;
    if (!roleId) return false;

    const employeeRole = await EmployeeRoles.findOne({
      roleId,
      isActive: true,
    });

    if (!employeeRole) return false;

    req.session.user.permissions = employeeRole.roles.map((r) => ({
      menuId: r.menuId?.toString(),
      menuGroupId: r.menuGroupId?.toString(),
      read: r.read,
      write: r.write,
      delete: r.delete,
      edit: r.edit,
      print: r.print,
      mail: r.mail,
    }));

    req.session.user.permissionsUpdatedAt = employeeRole.updatedAt;

    return true;
  } catch (error) {
    console.error("refreshPermissions error:", error);
    return false;
  }
};

/**
 * Makes sure `req.session.user.permissions` is present and current, loading or
 * refreshing it from EmployeeRoles when it is not.
 *
 * EXTRACTED so that a middleware which has to check MORE THAN ONE menu on a
 * single request (middlewares/cmsPermission.js checks the page being edited and
 * then the all-pages fallback) pays for the staleness round-trip ONCE rather
 * than once per menu. Behaviour is unchanged for checkPermission below: the
 * same three outcomes, in the same order, with the same messages.
 *
 * ALWAYS READS req.session.user, never req.user — authMiddleware builds req.user
 * from four fields only and it carries no permissions at all.
 *
 * @param {import("express").Request} req
 * @returns {Promise<{ok: true} | {ok: false, status: number, message: string}>}
 */
export const ensurePermissionsFresh = async (req) => {
  const sessionUser = req.session?.user;

  if (!sessionUser) {
    return { ok: false, status: 401, message: "Not logged in" };
  }

  // If no permissions in session — load from DB
  if (!sessionUser.permissions || sessionUser.permissions.length === 0) {
    const refreshed = await refreshPermissions(req);
    if (!refreshed) {
      return {
        ok: false,
        status: 403,
        message: "No permissions found for this role",
      };
    }
  } else {
    // Permissions exist — check if stale
    const stale = await isPermissionStale(sessionUser);
    if (stale) {
      await refreshPermissions(req);
    }
  }

  return { ok: true };
};

/**
 * Resolves a menu BY URL and answers whether the session holds `action` on it.
 *
 * Assumes ensurePermissionsFresh() has already run — it does no loading of its
 * own, which is what makes it cheap to call twice in one request.
 *
 * The two negative answers are kept DISTINCT rather than collapsed to a
 * boolean, because they mean completely different things operationally:
 * `menuFound: false` is "the seed has not been run" (an ops problem, and the
 * reason every seed script in this repo carries a NOT OPTIONAL banner), while
 * `allowed: false` is "this role was not granted it" (a permissions problem).
 * Collapsing them is how a missing seed row gets diagnosed for an hour as a
 * permissions bug.
 *
 * @param {import("express").Request} req
 * @param {string} menuUrl exact MenuMaster.menuUrl
 * @param {string} action read | write | edit | delete | print | mail
 * @returns {Promise<{menuFound: boolean, allowed: boolean}>}
 */
export const hasMenuPermission = async (req, menuUrl, action) => {
  const menu = await MenuMaster.findOne({ menuUrl, isActive: true }).lean();

  if (!menu) return { menuFound: false, allowed: false };

  const permissions = req.session?.user?.permissions || [];
  const menuPermission = permissions.find(
    (p) => p.menuId === menu._id.toString(),
  );

  return { menuFound: true, allowed: Boolean(menuPermission?.[action]) };
};

/**
 * Permission middleware
 * Usage: checkPermission("/employee", "read")
 *        checkPermission("/department", "write")
 *        checkPermission("/role-master", "delete")
 * ADMIN role always bypasses permission check
 *
 * For the CMS routes, which must check the permission of the PAGE being edited
 * rather than one fixed URL, see middlewares/cmsPermission.js — it is built on
 * the two helpers above and shares this function's semantics exactly.
 */
export const checkPermission = (menuUrl, action) => {
  return async (req, res, next) => {
    try {
      // ADMIN always has full access
      if (req.session?.user?.role === "ADMIN") {
        return next();
      }

      const fresh = await ensurePermissionsFresh(req);
      if (!fresh.ok) {
        return res.status(fresh.status).json({
          isOk: false,
          message: fresh.message,
          status: fresh.status,
        });
      }

      const { menuFound, allowed } = await hasMenuPermission(
        req,
        menuUrl,
        action,
      );

      if (!menuFound) {
        return res.status(403).json({
          isOk: false,
          message: `Menu '${menuUrl}' not found`,
          status: 403,
        });
      }

      if (!allowed) {
        return res.status(403).json({
          isOk: false,
          message: `Access denied — no '${action}' permission for this module`,
          status: 403,
        });
      }

      return next();
    } catch (error) {
      console.error("checkPermission error:", error);
      return res.status(500).json({
        isOk: false,
        message: "Permission check failed",
        status: 500,
      });
    }
  };
};
