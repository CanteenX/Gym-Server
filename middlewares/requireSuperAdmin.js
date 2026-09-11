export const requireSuperAdmin = (req, res, next) => {
    if (!req.session?.user) {
        return res.status(401).json({
            isOk: false,
            message: "Not logged in",
            status: 401,
        });
    }

    if (!req.session.user.isSuperAdmin) {
        return res.status(403).json({
            isOk: false,
            message: "Access denied. Super admin only.",
            status: 403,
        });
    }

    next();
};