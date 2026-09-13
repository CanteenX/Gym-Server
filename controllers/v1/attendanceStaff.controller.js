import Attendance from "../../models/Attendance.js";
import Member from "../../models/Member.js";
import {
  scopeFilter,
  resolveBranchFilter,
} from "../../middlewares/branchScope.js";

/**
 * STAFF-FACING attendance views. Nothing here writes.
 *
 * Until now attendance was collected and never seen: members check themselves
 * in at /member-portal/attendance/* and no staff route existed at all. These
 * three reads are that missing half — footfall, who is inside now, and who has
 * stopped logging sessions.
 *
 * ============================================================================
 * WORDING IS PART OF THE CONTRACT: "NOT CHECKED IN", NEVER "NOT VISITED".
 * ============================================================================
 * Check-in is unattended and self-reported (plan.md D2): the branch QR is a
 * printed sticker, so it can be photographed and used from a sofa, and the
 * portal's check-in button needs no QR at all. A row therefore proves somebody
 * pressed a button, not that they were in the building — and no row proves
 * nothing, because a member can train without logging.
 *
 * So this measures LOGGING BEHAVIOUR. It is still the best churn prompt
 * available and it catches the common case (stopped coming, stopped logging),
 * but it is a reason to make a phone call, not evidence that somebody stopped
 * attending. Every field name and message below says "checked in" for that
 * reason; renaming them to "visited" would turn a soft signal into a claim the
 * data cannot support.
 *
 * BRANCH SCOPING: every filter here ends with `...scopeFilter(req)` spread
 * LAST, so a branch admin's own branch overrides whatever the client asked
 * for. See middlewares/branchScope.js — and note that it reads
 * req.session.user, never req.user, which carries no branch at all.
 *
 * ============================================================================
 * SUBJECT SCOPING: EVERY QUERY HERE CARRIES subjectType. THIS IS THE FILE THE
 * PHASE 3 WARNING WAS WRITTEN ABOUT.
 * ============================================================================
 * Phase 3 put trainer shifts in the same collection behind a discriminator
 * (plan.md D3). Unlike the member-portal queries, NOTHING here is keyed on a
 * memberId — these ask about a branch and a date range, which a trainer's row
 * answers just as well as a member's. So a query that omits subjectType counts
 * trainer shifts as member footfall, and it does so silently: no error, no
 * warning, nothing on screen that looks wrong. The owner simply gets numbers
 * that are too big, and nobody finds out from the software.
 *
 * `subjectFilter(req)` below is the single place that decides it. Default
 * MEMBER — the pre-Phase-3 meaning of every one of these screens, so an admin
 * page that was not updated keeps showing exactly what it showed yesterday.
 * `?subjectType=TRAINER` switches, `?subjectType=ALL` deliberately combines and
 * has to be asked for by name.
 *
 * DENIED ATTEMPTS ARE ALSO EXCLUDED from the counting queries. A refused scan
 * is a real row (it has to be — the front desk needs to see it), but it is not
 * a visit, and a lapsed member tapping the sticker five times must not read as
 * five arrivals.
 */

/**
 * The subject-type fragment for every query in this file. Spread like
 * scopeFilter, and for the same reason: one place to be right.
 *
 * Returns `{}` only for an explicit `?subjectType=ALL`, never by accident —
 * an unrecognised value falls back to MEMBER rather than to "everything",
 * because the failure mode of guessing wrong must be a number that is too
 * small and obviously so, not one that is too big and plausible.
 *
 * Exported so the override handler (attendanceOverride.controller.js) uses this
 * exact definition rather than a second copy of it. A second copy is how the
 * two drift, and the drift is silent.
 */
export const subjectFilter = (req) => {
  const asked = String(req.query?.subjectType || "").trim().toUpperCase();
  if (asked === "ALL") return {};
  if (asked === "TRAINER") return { subjectType: "TRAINER" };
  return { subjectType: "MEMBER" };
};

/** How the response labels what it just counted, so a screen cannot guess. */
const subjectLabel = (req) => {
  const asked = String(req.query?.subjectType || "").trim().toUpperCase();
  if (asked === "ALL") return "ALL";
  if (asked === "TRAINER") return "TRAINER";
  return "MEMBER";
};

/**
 * Refused scans are rows but not visits. Excluded from every count below.
 * `deniedReason: null` also matches rows written before the field existed —
 * Mongo treats a missing field as null for an equality match — so this needs
 * no backfill to be correct.
 */
const NOT_DENIED = { deniedReason: null };

/**
 * The mirror of NOT_DENIED: rows that ARE refusals.
 *
 * `$ne: null` rather than `$exists: true`, for the same reason NOT_DENIED can
 * use a bare null — Mongo treats a missing field as null on an equality match,
 * so a pre-Phase-3 row (no deniedReason field at all) is correctly excluded
 * here and correctly included there, with no backfill either way.
 *
 * An overridden refusal does NOT match this: the override clears deniedReason
 * and copies the original into `denialOverride` (models/Attendance.js). That is
 * what makes a resolved denial leave the feed without any query here knowing
 * the override exists.
 */
const IS_DENIED = { deniedReason: { $ne: null } };

/** Midnight local — Attendance.date is stored normalised the same way. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

/** A date range is capped so one mistyped year cannot scan the collection. */
const MAX_RANGE_DAYS = 366;

/**
 * How long an open session can be before it stops meaning "inside right now".
 *
 * Member.sessionMinutes is capped at 120 by the schema, and stale sessions are
 * auto-closed LAZILY — only when that member next reads or writes their own
 * attendance. So an abandoned row can sit open for days, and a naive
 * `checkOutAt: null` query would report a member as being in the gym all week.
 * Anything older than the longest legitimate session is reported separately as
 * `staleOpenSessions` rather than shown as a person on the floor.
 */
const MAX_SESSION_MINUTES = 120;

/**
 * The most refusals one poll will carry. A denial is a row somebody has to act
 * on, so a hundred of them is already a queue nobody is working through; the
 * count beside the list (`deniedToday`) is the honest total.
 */
const DENIAL_CAP = 100;

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/**
 * GET /api/v1/attendance/footfall?fromDate&toDate&branch
 *
 * Check-ins per branch per day. One aggregation, grouped on
 * { branch, date } — which is exactly the shape of the index this relies on
 * (Attendance { branch: 1, date: 1 }), so the range is an index scan rather
 * than a collection scan.
 */
export const getFootfall = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;

    // Default window: the last 30 days, inclusive of today.
    const to = endOfDay(toDate || new Date());
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 29);
    const from = startOfDay(fromDate || defaultFrom);

    if (!from || !to) return fail(res, 400, "fromDate or toDate is not a date");
    if (from > to) return fail(res, 400, "fromDate must be before toDate");

    const spanDays = Math.round((to - from) / 86400000);
    if (spanDays > MAX_RANGE_DAYS) {
      return fail(res, 400, `Date range must be ${MAX_RANGE_DAYS} days or less`);
    }

    // A super admin may narrow to one branch; a branch admin's own branch is
    // returned regardless of what was asked for.
    const requested = resolveBranchFilter(req, req.query.branch);

    const match = {
      date: { $gte: from, $lte: to },
      ...NOT_DENIED,
      // MEMBER unless the caller explicitly asked otherwise. Without this,
      // trainer shifts are counted as member arrivals — see the file header.
      ...subjectFilter(req),
      ...(requested ? { branch: requested } : {}),
      // LAST, and therefore authoritative over everything above it.
      ...scopeFilter(req),
    };

    const rows = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: { branch: "$branch", date: "$date" },
          checkIns: { $sum: 1 },
          // A member can only hold one row per day (the unique index on
          // { memberId, date }), so this is the same number today — kept
          // explicit so the figure survives any future change to that rule.
          // Whichever id this row actually carries. A trainer row has
          // memberId: null, and counting nulls into a set would collapse every
          // trainer on a day into one "unique member" — a number that is wrong
          // and looks reasonable, which is the worst combination.
          uniqueMembers: { $addToSet: { $ifNull: ["$memberId", "$trainerId"] } },
          autoClosed: { $sum: { $cond: ["$autoClosed", 1, 0] } },
          totalMinutes: {
            $sum: {
              $cond: [
                { $ifNull: ["$checkOutAt", false] },
                {
                  $divide: [
                    { $subtract: ["$checkOutAt", "$checkInAt"] },
                    60000,
                  ],
                },
                0,
              ],
            },
          },
        },
      },
      { $sort: { "_id.date": 1, "_id.branch": 1 } },
    ]);

    const days = rows.map((r) => ({
      branch: r._id.branch,
      date: r._id.date,
      checkIns: r.checkIns,
      uniqueMembers: r.uniqueMembers.length,
      autoClosedSessions: r.autoClosed,
      totalMinutes: Math.round(r.totalMinutes),
    }));

    // Per-branch rollup, so the panel does not have to re-add the rows itself
    // and cannot arrive at a different total than the chart.
    const byBranch = {};
    for (const d of days) {
      byBranch[d.branch] ??= { branch: d.branch, checkIns: 0, totalMinutes: 0 };
      byBranch[d.branch].checkIns += d.checkIns;
      byBranch[d.branch].totalMinutes += d.totalMinutes;
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Footfall fetched successfully",
      data: {
        from,
        to,
        days,
        byBranch: Object.values(byBranch),
        totalCheckIns: days.reduce((s, d) => s + d.checkIns, 0),
        // Which population was counted. Travels with the numbers so a chart
        // cannot label trainer shifts as member footfall.
        subjectType: subjectLabel(req),
        // Repeated in the payload so a screen cannot present this as a
        // turnstile count by accident.
        basis:
          "Self-reported check-ins. Counts sessions members logged, not verified visits.",
      },
    });
  } catch (error) {
    console.error("Error fetching footfall:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/attendance/live?branch&since
 *
 * Who is in the gym now — open sessions started within the longest possible
 * session length. Polled by the admin panel (plan.md D2a: the API is a
 * serverless function and cannot hold a WebSocket), so it is deliberately
 * small and cheap.
 *
 * `since` (ISO timestamp) narrows to arrivals after that moment, which is what
 * keeps a 30-second poll's payload near-empty. `serverTime` comes back so the
 * caller can hand it straight to the next poll instead of trusting its own
 * clock.
 *
 * ============================================================================
 * DENIALS RIDE ALONG IN THE SAME RESPONSE, AND ON A DIFFERENT CURSOR FIELD.
 * ============================================================================
 * plan.md D2: nobody is at the door, so a refusal cannot stop anyone — the only
 * thing the system can do is put it in front of staff. Until now it did not:
 * this endpoint and /footfall both exclude denied rows, so a refusal was
 * visible only by downloading exports/attendance?includeDenied=true. Somebody
 * was told on their own phone that their membership had lapsed and nobody knew.
 *
 * WHY HERE AND NOT A SECOND ENDPOINT. The panel already polls this one every
 * 30 s with a `since` cursor. A separate endpoint means a second poll on a
 * second cursor, and two cursors drift: the moment one request succeeds and the
 * other fails or is rescheduled, the two lists describe different instants and
 * "what happened at the door in the last 30 seconds" can no longer be answered
 * from one payload. One response, one cursor, one answer.
 *
 * WHY THE DENIAL CURSOR IS `updatedAt` AND NOT `checkInAt`. A repeat refusal
 * does NOT create a second row — the unique { memberId, date } index forbids
 * it, so attendanceScan.controller.js updates today's row in place and leaves
 * `checkInAt` at the FIRST refusal of the day. Cursoring denials on checkInAt
 * would therefore mean a member denied at 07:00 who tries again at 07:31 never
 * appears again: the row's checkInAt is still 07:00, older than every
 * subsequent `since`, and the second attempt is silently lost between polls.
 * `updatedAt` moves on every attempt, so each fresh refusal surfaces exactly
 * once and then stops — which is also what stops a resolved-but-untouched
 * denial being re-sent forever.
 *
 * The comparison is `$gte`, not `$gt`, and deliberately: `serverTime` is
 * stamped before the queries run, so a row written in between would be returned
 * by this poll and again by the next. That is a DUPLICATE (dedupe by `_id`),
 * which is recoverable; `$gt` would turn the same race into a MISS, which is
 * not.
 */
export const getInGymNow = async (req, res) => {
  try {
    const now = new Date();
    const sessionFloor = new Date(now.getTime() - MAX_SESSION_MINUTES * 60000);

    const requested = resolveBranchFilter(req, req.query.branch);
    const branchMatch = {
      // Applied to BOTH queries below, which is why it lives up here: the open
      // sessions and the stale count must describe the same population or the
      // panel shows "3 people inside" beside "5 stale" for five different rows.
      ...NOT_DENIED,
      ...subjectFilter(req),
      ...(requested ? { branch: requested } : {}),
      ...scopeFilter(req),
    };

    const since = req.query.since ? new Date(req.query.since) : null;
    const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;

    const openFilter = {
      checkOutAt: null,
      checkInAt: {
        $gte:
          sinceValid && sinceValid > sessionFloor ? sinceValid : sessionFloor,
      },
      ...branchMatch,
    };

    /**
     * Refusals, for the same branch and subject population as the sessions
     * above — but built from IS_DENIED rather than NOT_DENIED, so the two lists
     * are disjoint by construction and a denial can never leak into `sessions`,
     * `inGymNow` or `staleOpenSessions`.
     *
     * Scoped to TODAY, and on `date` rather than `checkInAt` for two reasons:
     * `date` is the normalised midnight, so this is an exact day boundary with
     * no arithmetic; and it is indexed both on its own (`date_1`) and as the
     * tail of `{ branch: 1, date: 1 }`, so the query is a small index scan
     * whether or not a branch narrows it. Without the day bound a super admin's
     * denial query has no usable index prefix and degenerates into a scan of
     * every member row ever written.
     *
     * Yesterday's refusals are yesterday's: the gym is shut overnight and an
     * unbounded list would grow into a backlog nobody reads.
     */
    const todayStart = startOfDay(now);
    const denialMatch = {
      ...IS_DENIED,
      date: { $gte: todayStart },
      ...subjectFilter(req),
      ...(requested ? { branch: requested } : {}),
      // LAST, and therefore authoritative. A Gotri admin never sees a Vasna
      // refusal here, exactly as they never see a Vasna session.
      ...scopeFilter(req),
    };

    const denialFilter = {
      ...denialMatch,
      // See the header: the cursor for a refusal is updatedAt, because a repeat
      // refusal updates today's row instead of writing a new one.
      ...(sinceValid ? { updatedAt: { $gte: sinceValid } } : {}),
    };

    // prettier-ignore
    const [sessions, staleOpenSessions, denialRows, deniedToday] = await Promise.all([
      Attendance.find(openFilter)
        .select("subjectType memberId trainerId branch checkInAt date")
        .populate("memberId", "fullName mobileNumber photo branch")
        // Populated too, or a trainer shift shows up on the floor as a blank
        // row with no name on it once ?subjectType is TRAINER or ALL.
        .populate("trainerId", "fullName mobileNumber branch")
        .sort({ checkInAt: -1 })
        .limit(200)
        .lean(),
      /**
       * Rows still open past the longest legitimate session. NOT people on the
       * floor: they are forgotten check-outs waiting for the lazy auto-close to
       * run the next time that member opens the portal. Surfaced as a number
       * because a rising count means the check-out button is not being found.
       */
      Attendance.countDocuments({
        checkOutAt: null,
        checkInAt: { $lt: sessionFloor },
        ...branchMatch,
      }),
      /** The refusals themselves, newest attempt first — see denialFilter. */
      Attendance.find(denialFilter)
        .select(
          "subjectType memberId trainerId branch checkInAt date deniedReason source updatedAt",
        )
        .populate("memberId", "fullName mobileNumber photo branch endDate")
        .populate("trainerId", "fullName mobileNumber branch")
        .sort({ updatedAt: -1 })
        .limit(DENIAL_CAP)
        .lean(),
      /**
       * Today's refusals in total, NOT narrowed by the cursor.
       *
       * The list answers "what is new since the last poll"; this answers "how
       * many people were turned away today". A panel that only ever showed the
       * cursor's slice would read 0 on every quiet poll and make a morning's
       * refusals look like they never happened.
       */
      Attendance.countDocuments(denialMatch),
    ]);

    const data = sessions.map((s) => ({
      _id: s._id,
      subjectType: s.subjectType || "MEMBER",
      branch: s.branch,
      checkInAt: s.checkInAt,
      minutesSoFar: Math.max(
        0,
        Math.round((now - new Date(s.checkInAt)) / 60000),
      ),
      // `member` keeps its exact former shape and meaning — null on a trainer
      // row — so the existing admin feed renders unchanged. `trainer` is the
      // new, separate key rather than a person squeezed into `member`, because
      // a screen that showed a trainer under the member column would be lying
      // in the same way the unfiltered footfall count did.
      member: s.memberId
        ? {
            _id: s.memberId._id,
            fullName: s.memberId.fullName,
            mobileNumber: s.memberId.mobileNumber,
            photo: s.memberId.photo,
          }
        : null,
      trainer: s.trainerId
        ? {
            _id: s.trainerId._id,
            fullName: s.trainerId.fullName,
            mobileNumber: s.trainerId.mobileNumber,
          }
        : null,
    }));

    /**
     * The refusals, shaped like the sessions above so one list component can
     * render both — same `subjectType` / `member` / `trainer` keys, plus why
     * and when.
     *
     * `minutesSoFar` is deliberately ABSENT: a refusal is not a session and
     * nothing is elapsing. `deniedAt` is the first refusal of the day (the row
     * keeps its original checkInAt) and `lastAttemptAt` is the most recent one,
     * so "denied at 07:00, tried again three times since" is readable without
     * another query.
     */
    const denials = denialRows.map((d) => ({
      _id: d._id,
      subjectType: d.subjectType || "MEMBER",
      branch: d.branch,
      deniedReason: d.deniedReason,
      deniedAt: d.checkInAt,
      lastAttemptAt: d.updatedAt || d.checkInAt,
      source: d.source || "SELF",
      member: d.memberId
        ? {
            _id: d.memberId._id,
            fullName: d.memberId.fullName,
            mobileNumber: d.memberId.mobileNumber,
            photo: d.memberId.photo,
            // The single most useful thing for the person picking up the phone:
            // it names what has to be fixed before the next scan succeeds.
            endDate: d.memberId.endDate || null,
          }
        : null,
      trainer: d.trainerId
        ? {
            _id: d.trainerId._id,
            fullName: d.trainerId.fullName,
            mobileNumber: d.trainerId.mobileNumber,
          }
        : null,
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Open sessions fetched successfully",
      data: {
        serverTime: now,
        /**
         * FIRST in the payload because they are first on the screen (plan.md
         * D2): a refusal is the only row here that somebody has to DO something
         * about. Everything else is a person happily training.
         */
        denials,
        // New or re-asserted since `since`; the length of the list above.
        deniedNew: denials.length,
        // Every refusal today, cursor or no cursor.
        deniedToday,
        denialsTruncated: denials.length >= DENIAL_CAP,
        /**
         * UNCHANGED, and it has to stay that way. `inGymNow` counts open
         * sessions only — a refusal is not an arrival, and folding one in here
         * would move a number Phase 4 already reports.
         */
        inGymNow: data.length,
        sessions: data,
        staleOpenSessions,
        subjectType: subjectLabel(req),
        basis:
          "Open self-reported sessions. A member can log a session without being present.",
        denialsBasis:
          "Refused scans today. A denial did not stop anyone entering — nobody is " +
          "at the door — so these are people who may be in the gym right now with " +
          "something unresolved. Not counted in inGymNow or in footfall.",
      },
    });
  } catch (error) {
    console.error("Error fetching live attendance:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * Active members this session may see. Bounded rather than streamed: two
 * branches of a city gym is hundreds of rows, and the whole point is to hand a
 * human a call list.
 */
const ROSTER_CAP = 5000;

/**
 * GET /api/v1/attendance/not-checked-in?days=14&skip&per_page&branch
 *
 * Members with NO logged check-in in the last N days (default 14).
 *
 * Not "not visited" — see the header of this file. The response repeats that
 * caveat in `basis` so it travels with the data into whatever screen renders
 * it.
 *
 * Query shape, and why it is three small queries rather than one $lookup:
 *   1. the active roster this session may see (indexed on Member
 *      { branch: 1, isActive: 1, startDate: 1 });
 *   2. who among them HAS a row since the cutoff — an $in over
 *      Attendance { memberId: 1, date: 1 }, the existing unique index, so it
 *      is an index-only scan;
 *   3. the last check-in for the remainder, to sort the call list.
 * A $lookup from Member into Attendance would have to scan every member's
 * whole attendance history to find one maximum; this touches only the recent
 * slice.
 */
export const getNotCheckedIn = async (req, res) => {
  try {
    const requestedDays = Number(req.query.days);
    const days =
      Number.isFinite(requestedDays) && requestedDays > 0
        ? Math.min(Math.trunc(requestedDays), 365)
        : 14;

    const cutoff = startOfDay(new Date());
    cutoff.setDate(cutoff.getDate() - days);

    const skip = Math.max(0, Number(req.query.skip) || 0);
    const perPage = Math.min(
      Math.max(1, Number(req.query.per_page) || 50),
      500,
    );

    const requested = resolveBranchFilter(req, req.query.branch);

    const memberFilter = {
      isActive: true,
      ...(requested ? { branch: requested } : {}),
      // LAST. A branch admin never sees another branch's roster.
      ...scopeFilter(req),
    };

    const members = await Member.find(memberFilter)
      .select("fullName mobileNumber branch planCode startDate endDate")
      .limit(ROSTER_CAP)
      .lean();

    const ids = members.map((m) => m._id);

    // Everyone with at least one logged session inside the window.
    const recentIds = await Attendance.distinct("memberId", {
      // This one is already keyed on a set of member _ids, so a trainer row
      // (memberId: null) could not match. Filtered anyway — the house rule for
      // this collection has no silent exceptions, and it lets the query use the
      // subjectType index. A denied scan must NOT count as having checked in:
      // the member was turned away, which is precisely when somebody should
      // call them.
      subjectType: "MEMBER",
      ...NOT_DENIED,
      memberId: { $in: ids },
      date: { $gte: cutoff },
    });
    const recent = new Set(recentIds.map(String));

    const lapsed = members.filter((m) => !recent.has(String(m._id)));

    // Their most recent check-in ever, so the list can be ordered by how long
    // it has been. Members with no row at all keep lastCheckInAt: null.
    const lastSeen = await Attendance.aggregate([
      {
        $match: {
          subjectType: "MEMBER",
          ...NOT_DENIED,
          memberId: { $in: lapsed.map((m) => m._id) },
        },
      },
      { $group: { _id: "$memberId", lastCheckInAt: { $max: "$checkInAt" } } },
    ]);
    const lastSeenBy = new Map(
      lastSeen.map((r) => [String(r._id), r.lastCheckInAt]),
    );

    const now = Date.now();
    const rows = lapsed
      .map((m) => {
        const last = lastSeenBy.get(String(m._id)) || null;
        return {
          _id: m._id,
          fullName: m.fullName,
          mobileNumber: m.mobileNumber,
          branch: m.branch,
          planCode: m.planCode,
          endDate: m.endDate,
          membershipExpired: m.endDate ? new Date(m.endDate) < new Date() : false,
          lastCheckInAt: last,
          // Null for a member who has never logged one — the portal may simply
          // never have been set up for them, which is a different conversation.
          daysSinceLastCheckIn: last
            ? Math.floor((now - new Date(last).getTime()) / 86400000)
            : null,
          hasEverCheckedIn: Boolean(last),
        };
      })
      // Longest silence first; never-checked-in members sort to the very top.
      .sort((a, b) => {
        if (a.lastCheckInAt === b.lastCheckInAt) return 0;
        if (!a.lastCheckInAt) return -1;
        if (!b.lastCheckInAt) return 1;
        return new Date(a.lastCheckInAt) - new Date(b.lastCheckInAt);
      });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Members with no logged check-in in the last ${days} days`,
      data: {
        days,
        cutoff,
        total: rows.length,
        rosterTruncated: members.length >= ROSTER_CAP,
        rows: rows.slice(skip, skip + perPage),
        basis:
          "Measures logging behaviour, not attendance. Check-in is self-reported " +
          "and unattended, so a member may train without logging a session. " +
          "Treat this as a prompt for a phone call, not as evidence.",
      },
    });
  } catch (error) {
    console.error("Error fetching not-checked-in members:", error);
    return fail(res, 500, "Internal server error");
  }
};
