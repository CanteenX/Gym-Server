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
 */

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
          uniqueMembers: { $addToSet: "$memberId" },
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
 */
export const getInGymNow = async (req, res) => {
  try {
    const now = new Date();
    const sessionFloor = new Date(now.getTime() - MAX_SESSION_MINUTES * 60000);

    const requested = resolveBranchFilter(req, req.query.branch);
    const branchMatch = {
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

    const [sessions, staleOpenSessions] = await Promise.all([
      Attendance.find(openFilter)
        .select("memberId branch checkInAt date")
        .populate("memberId", "fullName mobileNumber photo branch")
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
    ]);

    const data = sessions.map((s) => ({
      _id: s._id,
      branch: s.branch,
      checkInAt: s.checkInAt,
      minutesSoFar: Math.max(
        0,
        Math.round((now - new Date(s.checkInAt)) / 60000),
      ),
      member: s.memberId
        ? {
            _id: s.memberId._id,
            fullName: s.memberId.fullName,
            mobileNumber: s.memberId.mobileNumber,
            photo: s.memberId.photo,
          }
        : null,
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Open sessions fetched successfully",
      data: {
        serverTime: now,
        inGymNow: data.length,
        sessions: data,
        staleOpenSessions,
        basis:
          "Open self-reported sessions. A member can log a session without being present.",
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
      memberId: { $in: ids },
      date: { $gte: cutoff },
    });
    const recent = new Set(recentIds.map(String));

    const lapsed = members.filter((m) => !recent.has(String(m._id)));

    // Their most recent check-in ever, so the list can be ordered by how long
    // it has been. Members with no row at all keep lastCheckInAt: null.
    const lastSeen = await Attendance.aggregate([
      { $match: { memberId: { $in: lapsed.map((m) => m._id) } } },
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
