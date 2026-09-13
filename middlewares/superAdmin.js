/**
 * The ONE answer to "is this request the super admin?".
 *
 * ============================================================================
 * WHY THIS FILE EXISTS: A ROLE STRING IS NOT A PRIVILEGE LEVEL.
 * ============================================================================
 *
 * `role` has exactly two values on the staff side — "ADMIN" for a CompanyMaster
 * login and "EMPLOYEE" for an Employee login. It answers "which table is this
 * person in?", nothing more. It has never answered "how much may they do?".
 *
 * checkPermission and cmsPermission used to bypass every permission check on
 * `role === "ADMIN"`. That was harmless only while exactly one ADMIN existed.
 * The moment a second, branch-level CompanyMaster admin is created — which the
 * Setup → Admin screen does, and which CompanyMaster.isSuperAdmin: false is
 * precisely the record of — that account silently bypassed the whole RBAC
 * system: every CMS page, the SEO manager, the audit log, other people's
 * branches' reports. Not because anyone granted it, but because the gate was
 * reading the wrong field. `isSuperAdmin` was already being computed onto the
 * session by both login paths and was simply never consulted by the gate.
 *
 * So: PRIVILEGE IS `isSuperAdmin`. TABLE IS `role`. They are different
 * questions and must never be conflated again.
 *
 * WHAT STILL READS THE ROLE STRING, CORRECTLY:
 *   - authMiddleware(["ADMIN", "EMPLOYEE"]) — "is this a staff session at all?"
 *     That is a question about the table, so the role string is the right
 *     field. Do not change it: narrowing it to super admins would lock every
 *     employee out of every staff route.
 *   - employeeRoles.controller.js checkUpdatePermissions — "which branch of the
 *     role-editing rules applies?", again a question about which table the
 *     editor lives in, with its own separate rules per table.
 *   - the email* controllers' ownership checks — "may I touch a row I did not
 *     create?", a per-table ownership convention, unrelated to RBAC.
 *
 * ============================================================================
 * THE MISSING-FLAG PROBLEM, AND WHY WE RE-DERIVE RATHER THAN GUESS.
 * ============================================================================
 *
 * Sessions live in MongoDB (connect-mongo) and SURVIVE A DEPLOY. A session
 * created before `isSuperAdmin` was written onto the session at login has no
 * such field at all. On the first request after this change ships, that session
 * asks the new gate a question the old login never recorded an answer to.
 *
 * Both naive answers are wrong:
 *   - "absent means super admin" re-opens the exact hole being closed, for
 *     every pre-deploy branch-admin session, for the life of that session.
 *   - "absent means not super admin" can lock the OWNER out of their own
 *     system until they think to log out and back in — with no error that
 *     explains why, because a 403 from checkPermission looks identical to a
 *     missing grant.
 *
 * So we do not guess: we LOOK IT UP. `isSuperAdmin` is a durable fact stored on
 * the account row, and the session carries the account id. resolveSuperAdminFlag
 * reads the row, writes the answer back onto the session, and every later
 * request on that session is answered synchronously from the session again.
 * The cost is ONE indexed findById per pre-deploy session, once, ever.
 *
 * The residual fail-closed case is deliberate: if the flag is absent AND the
 * account cannot be read (deleted account, or the database is unreachable), we
 * answer false. An account that no longer exists is not a super admin, and a
 * database we cannot read is not one we should be granting unlimited access on
 * the strength of.
 *
 * WHAT WE DO NOT RE-DERIVE: an explicit `false`. A stored `false` is a recorded
 * answer from a real login, not an absence, and re-checking it would put a
 * database round-trip on every request of every ordinary employee forever. The
 * consequence is that promoting or demoting someone takes effect at their next
 * login — exactly as `branch`, `roleId` and the permission snapshot already
 * behave. Log out and back in to pick up a promotion.
 */
import CompanyMaster from "../models/CompanyMaster.js";
import Employee from "../models/Employee.js";

/**
 * True when this request belongs to the super admin.
 *
 * SYNCHRONOUS AND STRICT ON PURPOSE. `=== true` rather than a truthiness test,
 * because the three states this field can be in — true, false, absent — mean
 * three different things, and a truthiness test collapses the last two. Absence
 * is handled by resolveSuperAdminFlag() during authMiddleware, so by the time
 * any gate calls this, the session holds a real boolean.
 *
 * READS req.session.user, NEVER req.user. authMiddleware builds req.user from
 * four fields (id, role, email, name); it carries no isSuperAdmin and no
 * branch, so `req.user.isSuperAdmin` is undefined for the owner and for
 * everybody else alike — a check written against it denies everyone, or, worse,
 * is negated somewhere and grants everyone. See middlewares/branchScope.js.
 *
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export const isSuperAdminSession = (req) =>
  req?.session?.user?.isSuperAdmin === true;

/**
 * True when the session exists but has no recorded answer for isSuperAdmin.
 *
 * This is the pre-deploy-session case and ONLY that case: an explicit `false`
 * is an answer, not an absence, and returns false here.
 *
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export const superAdminFlagMissing = (req) => {
  const sessionUser = req?.session?.user;
  if (!sessionUser) return false;
  return (
    sessionUser.isSuperAdmin === undefined || sessionUser.isSuperAdmin === null
  );
};

/**
 * Re-derives isSuperAdmin from the account row and heals the session in place.
 *
 * A no-op unless the flag is genuinely absent, so it costs nothing on the
 * normal path. Both staff tables are checked because both carry the flag and
 * the session does not reliably say which table it came from for old sessions:
 * Employee first, because that is the table that grows.
 *
 * ALSO HEALS `branch`, for the same reason and at no extra cost — we already
 * have the row in hand. A pre-deploy session missing isSuperAdmin is just as
 * likely to be missing branch, and a missing branch reads as "all branches" in
 * scopedBranch(), which is a silent cross-branch data leak rather than a 403
 * anybody would report.
 *
 * @param {import("express").Request} req
 * @returns {Promise<boolean>} the resolved flag
 */
export const resolveSuperAdminFlag = async (req) => {
  const sessionUser = req?.session?.user;
  if (!sessionUser) return false;
  if (!superAdminFlagMissing(req)) return sessionUser.isSuperAdmin === true;

  const id = sessionUser.id;
  if (!id) {
    sessionUser.isSuperAdmin = false;
    return false;
  }

  try {
    const employee = await Employee.findById(id)
      .select("isSuperAdmin branch")
      .lean();

    const account =
      employee ||
      (await CompanyMaster.findById(id).select("isSuperAdmin").lean());

    if (!account) {
      // The session names an account that no longer exists. Not a super admin,
      // and nothing else here can be trusted either.
      console.warn(
        `⚠️  Session ${id} has no isSuperAdmin and no matching account row — treated as NOT super admin`,
      );
      sessionUser.isSuperAdmin = false;
      return false;
    }

    sessionUser.isSuperAdmin = account.isSuperAdmin === true;

    if (sessionUser.branch === undefined) {
      sessionUser.branch = account.branch ?? null;
    }

    return sessionUser.isSuperAdmin;
  } catch (error) {
    // Fail closed. See the file header: a database we cannot read is not one to
    // hand out unlimited access on the strength of. Nothing is written to the
    // session, so the next request retries the lookup rather than caching a
    // wrong answer produced by a transient outage.
    console.error("resolveSuperAdminFlag error:", error.message);
    return false;
  }
};
