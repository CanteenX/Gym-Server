/**
 * Hard gate for the routes only the owner may call at all — the ones that have
 * no per-menu permission and never should have one, such as creating another
 * super admin.
 *
 * Reads the SAME single answer every other gate now reads
 * (middlewares/superAdmin.js). It previously spelled the test itself as
 * `!req.session.user.isSuperAdmin`, which agreed with this one in practice but
 * was a third independent copy of the question; checkPermission's copy asked a
 * different question entirely (`role === "ADMIN"`) and that is how a branch
 * admin ended up blocked here while bypassing every permission check elsewhere.
 */
import { isSuperAdminSession } from "./superAdmin.js";

export const requireSuperAdmin = (req, res, next) => {
    if (!req.session?.user) {
        return res.status(401).json({
            isOk: false,
            message: "Not logged in",
            status: 401,
        });
    }

    if (!isSuperAdminSession(req)) {
        return res.status(403).json({
            isOk: false,
            message: "Access denied. Super admin only.",
            status: 403,
        });
    }

    next();
};
