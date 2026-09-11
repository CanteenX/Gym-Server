/**
 * Branch scoping — the single place that answers "whose data may this user see?"
 *
 * ============================================================================
 * READ THIS BEFORE USING ANYTHING IN THIS FILE: req.user IS NOT THE SOURCE OF
 * TRUTH. USE req.session.user.
 * ============================================================================
 *
 * authMiddleware.js builds `req.user` by copying only four fields off the
 * session:
 *
 *     req.user = { id, role, email, name };
 *
 * It does NOT copy `branch`, and it does NOT copy `isSuperAdmin`. So
 * `req.user.branch` is ALWAYS undefined — not "undefined for super admins",
 * undefined for everyone. Scope code written against req.user therefore reads
 * undefined, concludes "no branch restriction", and returns an empty filter:
 * every branch admin silently sees both branches, and nothing anywhere throws
 * or logs. That failure is invisible in testing unless you are specifically
 * looking for it. The helpers below read `req.session.user` for that reason,
 * and any new scoping code must do the same.
 *
 * The second rule: scope is derived from the SESSION, never from the request.
 * A branch is not a filter the client asks for, it is a fact about who is
 * logged in. If a branch were ever taken from req.body/req.query, a Gotri admin
 * could read Vasna simply by editing the request — which is the entire thing
 * this module exists to prevent. Client-supplied branch params may narrow a
 * super admin's view, but must never widen a branch admin's.
 */

/**
 * The branch this request is limited to, or null for unrestricted (super admin).
 *
 * Treated as unrestricted when the session says isSuperAdmin, or when no branch
 * is set — `branch: null` on an Employee is precisely how "all branches" is
 * recorded (see models/Employee.js).
 */
export const scopedBranch = (req) => {
  const sessionUser = req.session?.user;
  if (!sessionUser) return null;
  if (sessionUser.isSuperAdmin) return null;
  return sessionUser.branch || null;
};

/**
 * A MongoDB filter fragment to spread into any query over branch-bearing data
 * (Member, Trainer, Transaction):
 *
 *     const filter = { ...scopeFilter(req), isActive: true };
 *
 * Returns `{}` for a super admin (no restriction) and `{ branch: "Vasna" }`
 * for a Vasna admin. Because it returns a plain object, spreading it LAST
 * makes it authoritative over anything the client sent — which is what you
 * want on every list endpoint.
 */
export const scopeFilter = (req) => {
  const branch = scopedBranch(req);
  return branch ? { branch } : {};
};

/**
 * True when the session belongs to someone with full cross-branch access.
 */
export const isSuperAdmin = (req) => Boolean(req.session?.user?.isSuperAdmin);

/**
 * Resolves the branch a LIST endpoint should filter on, honouring a
 * client-supplied value only where it is legitimate to do so.
 *
 *   - branch admin  -> always their own branch; `requested` is ignored outright
 *                      (it can only ever be an attempt to widen).
 *   - super admin   -> whatever they asked for, or "" meaning all branches.
 *
 * Returns "" for "no branch restriction", so callers can do
 * `if (branch) filter.branch = branch;` exactly as they already did.
 */
export const resolveBranchFilter = (req, requested) => {
  const own = scopedBranch(req);
  if (own) return own;
  return typeof requested === "string" && requested.trim() ? requested.trim() : "";
};

/**
 * The branch filter for FINANCIAL reporting, where "Common" needs special care.
 *
 * Transaction.branch is ["Vasna", "Gotri", "Common"]. "Common" holds costs that
 * belong to the business rather than to either floor — shared rent, software,
 * the owner's salary. Those must NOT appear in a single branch's P&L, or that
 * branch would look unprofitable for costs it does not carry. A branch admin
 * therefore sees strictly their own rows; a super admin sees everything,
 * including Common.
 *
 * Returns a filter fragment, same contract as scopeFilter().
 */
export const financialScopeFilter = (req, requested) => {
  const own = scopedBranch(req);
  if (own) return { branch: own };

  const asked =
    typeof requested === "string" && requested.trim() ? requested.trim() : "";
  return asked ? { branch: asked } : {};
};
