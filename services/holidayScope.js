/**
 * Branch scoping for the Holiday Master, composed on top of
 * middlewares/branchScope.js rather than hand-rolled.
 *
 * WHY THIS ISN'T JUST scopeFilter()/resolveBranchFilter(): a holiday READ has
 * to express an OR that neither of those helpers can — "this branch admin's
 * own branch, OR an all-branches closure" — because a gym-wide holiday
 * (`branch: null`) applies to every branch admin too. scopeFilter() alone
 * would narrow a branch admin to `{ branch: "Gotri" }` and silently hide every
 * all-branches holiday from their calendar. The session-branch derivation
 * itself — the actual security-critical part — still goes through
 * scopedBranch(), never re-implemented here.
 *
 * The owner's brief draws a second line WRITE vs READ does not: a branch admin
 * may only CREATE/EDIT/DELETE their OWN branch's holidays, never an
 * all-branches one and never the other branch's. That is plain
 * scopeFilter()/scopedBranch() unchanged — see controllers/v1/holiday.controller.js,
 * which uses scopeFilter() (not holidayReadFilter) for every write-path lookup.
 */
import { scopedBranch } from "../middlewares/branchScope.js";

/**
 * The filter a holiday LIST/CALENDAR view should apply.
 *
 *   - branch admin -> their own branch's holidays AND the all-branches ones.
 *     `requested` is ignored outright, same rule resolveBranchFilter() applies
 *     elsewhere — it can only ever be an attempt to widen.
 *   - super admin  -> whatever they asked for (narrows), or `{}` for
 *     everything.
 *
 * @param {import("express").Request} req
 * @param {unknown} requested req.body.branch or req.query.branch
 * @returns {object} a Mongo filter fragment
 */
export const holidayReadFilter = (req, requested) => {
  const own = scopedBranch(req);
  if (own) return { branch: { $in: [own, null] } };

  const asked =
    typeof requested === "string" && requested.trim() ? requested.trim() : "";
  return asked ? { branch: asked } : {};
};

/**
 * The branch a holiday WRITE (create) must be filed under.
 *
 *   - branch admin -> always their own branch. The body is not consulted at
 *     all — same reasoning createSession() gives in classSession.controller.js
 *     for why branch comes from the session, never the request.
 *   - super admin  -> whatever the body names, or `null` ("all branches") when
 *     omitted/blank. `null` is a legitimate, common value here — unlike a
 *     ClassSession, a holiday is not tied to a physical floor, and a gym-wide
 *     closure is the expected case, not an edge one.
 *
 * Returns a branch NAME (possibly null) that the caller must still resolve
 * against the Branch master when non-null — this function only decides WHICH
 * branch is being asked for, not whether it exists. See
 * controllers/v1/holiday.controller.js's resolveHolidayBranch().
 *
 * @param {import("express").Request} req
 * @param {unknown} bodyBranch req.body.branch
 * @returns {{ok: true, branch: string|null} | {ok: false, error: string}}
 */
export const holidayWriteBranch = (req, bodyBranch) => {
  const own = scopedBranch(req);
  if (own) return { ok: true, branch: own };

  if (bodyBranch === undefined || bodyBranch === null || bodyBranch === "") {
    return { ok: true, branch: null };
  }
  if (typeof bodyBranch !== "string" || !bodyBranch.trim()) {
    return {
      ok: false,
      error: "branch must be a non-empty string, or omitted/null for all branches",
    };
  }
  return { ok: true, branch: bodyBranch.trim() };
};
