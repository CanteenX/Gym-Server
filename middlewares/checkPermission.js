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
 * Permission middleware
 * Usage: checkPermission("/employee", "read")
 *        checkPermission("/department", "write")
 *        checkPermission("/role-master", "delete")
 * ADMIN role always bypasses permission check
 */
export const checkPermission = (menuUrl, action) => {
  return async (req, res, next) => {
    try {
      // ADMIN always has full access
      if (req.session?.user?.role === "ADMIN") {
        return next();
      }

      const sessionUser = req.session?.user;

      if (!sessionUser) {
        return res.status(401).json({
          isOk: false,
          message: "Not logged in",
          status: 401,
        });
      }

      // If no permissions in session — load from DB
      if (!sessionUser.permissions || sessionUser.permissions.length === 0) {
        const refreshed = await refreshPermissions(req);
        if (!refreshed) {
          return res.status(403).json({
            isOk: false,
            message: "No permissions found for this role",
            status: 403,
          });
        }
      } else {
        // Permissions exist — check if stale
        const stale = await isPermissionStale(sessionUser);
        if (stale) {
          await refreshPermissions(req);
        }
      }

      // Find the menu in DB by menuUrl passed directly
      const menu = await MenuMaster.findOne({
        menuUrl,
        isActive: true,
      }).lean();

      if (!menu) {
        return res.status(403).json({
          isOk: false,
          message: `Menu '${menuUrl}' not found`,
          status: 403,
        });
      }

      // Check permission for this menu
      const permissions = req.session.user.permissions || [];
      const menuPermission = permissions.find(
        (p) => p.menuId === menu._id.toString(),
      );

      if (!menuPermission?.[action]) {
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
