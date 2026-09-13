/**
 * WHO is expiring, WHO has expired, and WHO owes money — defined exactly once.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS: TWO DEFINITIONS OF "EXPIRING" WOULD DISAGREE.
 * ============================================================================
 * The admin dashboard (controllers/v1/member.controller.js,
 * getMemberDashboardStats) has answered these three questions since long before
 * Phase 5. The reminder job asks the same three questions of the same data. If
 * it re-derived them — an `endDate <= now + 7d` here against the dashboard's
 * midnight-anchored window there — the two would disagree at the edges, and
 * they would disagree SILENTLY: a member emailed "your membership expires in 7
 * days" who does not appear in the dashboard's expiring list, or worse, the
 * reverse. Staff would have no way to tell which screen was lying.
 *
 * So the definitions moved here and BOTH callers read them. The dashboard's
 * behaviour is unchanged by the extraction; that is the point of it.
 *
 * ============================================================================
 * PURE ON PURPOSE — NO MONGOOSE, NO EXPRESS, NO CLOCK OF ITS OWN.
 * ============================================================================
 * Same contract as services/attendanceEligibility.js: plain functions over
 * plain objects that RETURN query fragments rather than running queries. That
 * is what makes scripts/tests/reminders.test.mjs an offline unit test, and it
 * is what lets a caller spread `...scopeFilter(req)` LAST over the fragment —
 * which is mandatory, because a cohort query that is not branch-scoped emails
 * the other branch's members (see middlewares/branchScope.js).
 *
 * ============================================================================
 * A NOTE ON MONEY, BECAUSE THE RULE HERE IS THE OPPOSITE OF THE REPORTING RULE
 * ============================================================================
 * CLAUDE.md is emphatic that financial REPORTS must be computed from the
 * `Transaction` ledger and never from `Member.payments[]`, which is cleared on
 * renewal. That rule is about totals over time — revenue, collections, P&L —
 * and it is correct.
 *
 * "Does this member owe money for the period they are in right now" is a
 * different question, and `Member.payments[]` is its ONLY correct source,
 * precisely BECAUSE it is cleared on renewal: the balance it describes is the
 * current period's, which is the one a reminder is about. Summing the ledger
 * would produce a lifetime figure that says nothing about whether this month is
 * settled. services/attendanceEligibility.js reads it for the same reason and
 * documents the same distinction.
 *
 * Nothing in this file is a report. No figure produced here is a revenue
 * number, a total, or an input to one.
 */

/** The three cohorts. Codes, not prose. */
export const MEMBER_COHORTS = {
  /** Membership ends within the next 7 days (today counts as day 0). */
  EXPIRING_SOON: "EXPIRING_SOON",
  /** Membership already ended. */
  EXPIRED: "EXPIRED",
  /** An unpaid balance on the CURRENT period — see the header note on money. */
  PAYMENT_DUE: "PAYMENT_DUE",
};

export const MEMBER_COHORT_LIST = Object.values(MEMBER_COHORTS);

/** How far ahead "expiring soon" looks. Changing this changes both callers. */
export const EXPIRY_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight at the START of the given day, local time.
 *
 * Anchored to midnight rather than to `now` so that "expiring in 7 days" means
 * the same set of members whether the question is asked at 09:00 or at 23:30.
 * A cron that drifts by a few minutes must not change who gets an email.
 */
export const startOfDay = (value = new Date()) => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** The last millisecond of the given day, local time. */
export const endOfDay = (value = new Date()) => {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
};

/** Midnight today. Kept as its own name because that is how it reads at the call site. */
export const startOfToday = (now = new Date()) => startOfDay(now);

/**
 * The two boundaries every cohort below is expressed in terms of.
 *
 * `in7Days` is the END of the seventh day, not the same clock time seven days
 * out — otherwise a membership ending at 18:00 on day 7 would fall outside a
 * window computed at 09:00 and inside one computed at 19:00.
 *
 * @param {Date} [now]
 * @returns {{ today: Date, in7Days: Date }}
 */
export const cohortWindow = (now = new Date()) => {
  const today = startOfToday(now);
  return {
    today,
    in7Days: endOfDay(new Date(today.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS)),
  };
};

/**
 * The MongoDB filter fragment for one cohort.
 *
 * PAYMENT_DUE returns only `{ isActive: true }` and NOT a balance clause,
 * because the balance is a Mongoose virtual derived from the `payments`
 * subdocument array — there is no stored field to query on. The caller fetches
 * the active members and filters them in JavaScript with `hasPaymentDue()`
 * below, which is exactly what the dashboard has always done. Stated here
 * rather than left to be discovered: a caller that treats this fragment as the
 * whole cohort would email every active member.
 *
 * SPREAD `scopeFilter(req)` AFTER THIS, NEVER BEFORE.
 *
 * @param {string} cohort - one of MEMBER_COHORTS
 * @param {Date} [now]
 * @returns {object} a query fragment
 */
export const cohortFilter = (cohort, now = new Date()) => {
  const { today, in7Days } = cohortWindow(now);

  switch (cohort) {
    case MEMBER_COHORTS.EXPIRING_SOON:
      return { isActive: true, endDate: { $gte: today, $lte: in7Days } };
    case MEMBER_COHORTS.EXPIRED:
      return { isActive: true, endDate: { $lt: today } };
    case MEMBER_COHORTS.PAYMENT_DUE:
      // Deliberately incomplete — see the note above.
      return { isActive: true };
    default:
      throw new Error(
        `Unknown member cohort '${cohort}' (expected one of: ${MEMBER_COHORT_LIST.join(", ")})`,
      );
  }
};

/**
 * The `endDate` clause the members LIST screen filters on.
 *
 * Separate from cohortFilter() and deliberately so: the list screen's ACTIVE /
 * EXPIRING / EXPIRED chips do NOT constrain `isActive`, because staff use them
 * to find deactivated members too. Extracting it here anyway keeps the three
 * date boundaries in one file, so a change to the 7-day window cannot land on
 * the dashboard and miss the list.
 *
 * @param {string} status - "ACTIVE" | "EXPIRING" | "EXPIRED", anything else -> null
 * @param {Date} [now]
 * @returns {object|null} an `endDate` clause, or null for "no date filter"
 */
export const listStatusFilter = (status, now = new Date()) => {
  const { today, in7Days } = cohortWindow(now);
  if (status === "EXPIRING") return { $gte: today, $lte: in7Days };
  if (status === "EXPIRED") return { $lt: today };
  if (status === "ACTIVE") return { $gt: in7Days };
  return null;
};

/**
 * What a member still owes for the CURRENT period. Never negative.
 *
 * Prefers the `balanceAmount` virtual when handed a real Mongoose document and
 * falls back to recomputing it for a `.lean()` object, where virtuals do not
 * exist. That fallback is not defensive padding — it is the difference between
 * this working and silently reporting "nobody owes anything" the first time a
 * caller adds `.lean()` for speed.
 *
 * @param {object} member
 * @returns {number}
 */
export const memberBalance = (member) => {
  if (!member) return 0;
  if (typeof member.balanceAmount === "number") {
    return Math.max(0, member.balanceAmount);
  }
  const paid = (member.payments || []).reduce(
    (sum, p) => sum + (p?.amount || 0),
    0,
  );
  return Math.max(0, (member.totalFee || 0) - paid);
};

/** True when the member owes something for the current period. */
export const hasPaymentDue = (member) => memberBalance(member) > 0;

/**
 * Days from today (midnight) until the membership ends. Negative once expired.
 *
 * Whole days, measured between midnights, so it agrees with the cohort windows
 * above rather than producing 6.7 days for something the dashboard calls 7.
 *
 * @param {object} member
 * @param {Date} [now]
 * @returns {number|null} null when the member has no endDate at all
 */
export const daysToExpiry = (member, now = new Date()) => {
  if (!member?.endDate) return null;
  const end = startOfDay(member.endDate);
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - startOfToday(now).getTime()) / DAY_MS);
};

/**
 * Does this member actually belong to this cohort, checked in JavaScript?
 *
 * The query fragments above are what NARROW the database read; this is what
 * CONFIRMS a row once it is in hand. Both are needed: PAYMENT_DUE cannot be
 * expressed as a query at all, and for the date cohorts a second check costs
 * nothing and catches the case where a caller composed the filter wrongly.
 *
 * @param {string} cohort
 * @param {object} member
 * @param {Date} [now]
 * @returns {boolean}
 */
export const isInCohort = (cohort, member, now = new Date()) => {
  if (!member) return false;
  if (member.isActive === false) return false;

  const days = daysToExpiry(member, now);

  switch (cohort) {
    case MEMBER_COHORTS.EXPIRING_SOON:
      return days !== null && days >= 0 && days <= EXPIRY_WINDOW_DAYS;
    case MEMBER_COHORTS.EXPIRED:
      return days !== null && days < 0;
    case MEMBER_COHORTS.PAYMENT_DUE:
      return hasPaymentDue(member);
    default:
      return false;
  }
};

export default {
  MEMBER_COHORTS,
  MEMBER_COHORT_LIST,
  cohortFilter,
  cohortWindow,
  listStatusFilter,
  memberBalance,
  hasPaymentDue,
  daysToExpiry,
  isInCohort,
  startOfDay,
  startOfToday,
  endOfDay,
};
