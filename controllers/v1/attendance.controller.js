import Attendance from "../../models/Attendance.js";
import Member from "../../models/Member.js";

/**
 * Member-portal attendance (check-in / check-out).
 *
 * Every handler scopes its query by req.member.id, which requireMember derives
 * from the verified token. No handler accepts a memberId from the client — that
 * would let any logged-in member check in, or read the history of, another.
 *
 * ============================================================================
 * EVERY QUERY BELOW ALSO CARRIES subjectType: "MEMBER". IT IS NOT DECORATION.
 * ============================================================================
 * Phase 3 put trainer shifts in the same collection behind a discriminator
 * (plan.md D3). These particular queries are additionally keyed on a memberId
 * that came from a member's own token, so a trainer row — memberId: null —
 * could not match one today even without the filter. It is written anyway,
 * everywhere, for two reasons:
 *
 *   1. It is the house rule for this collection, and a rule with exceptions
 *      scattered through it is a rule nobody applies. The one query that must
 *      NOT filter says so explicitly (branch.controller.js).
 *   2. It lets the { subjectType, branch, checkInAt } index serve these too.
 *
 * The check-in WRITE is the one that genuinely needs it: an insert with no
 * subjectType would rely on the schema default and, if that default were ever
 * removed, land in neither bucket and vanish from footfall silently.
 */

/** Midnight local, so a visit belongs to a day rather than an instant. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Whole minutes between the two taps. Null while the session is still open. */
const durationMinutes = (session) => {
  if (!session?.checkInAt || !session?.checkOutAt) return null;
  const ms = new Date(session.checkOutAt) - new Date(session.checkInAt);
  return ms > 0 ? Math.round(ms / 60000) : 0;
};

/** The row as the portal wants it: the session plus its derived duration. */
const withDuration = (session) => {
  if (!session) return null;
  const plain = session.toObject ? session.toObject() : session;
  return { ...plain, durationMinutes: durationMinutes(plain) };
};

/** Defaults to 90 for records written before sessionMinutes existed. */
const sessionLengthOf = (member) => member?.sessionMinutes || 90;

/**
 * Close any open session that has outrun the member's expected session length.
 *
 * WHY THE CLOSE TIME IS checkInAt + sessionMinutes AND NOT "now":
 * the member left the gym roughly when they said they would — they just never
 * tapped out. Stamping "now" would credit them for every hour the tab sat open,
 * turning a forgotten tap into a six-hour workout and poisoning totalMinutes.
 * The expected time is the honest reconstruction of what actually happened, and
 * autoClosed records that it IS a reconstruction rather than an observation.
 *
 * Called at the top of the read/write paths rather than from a cron: a stale
 * session only matters the moment somebody looks at it, and this keeps the
 * server free of a scheduler it would otherwise need solely for this.
 */
const autoCloseStale = async (memberId, minutes) => {
  const open = await Attendance.find({
    subjectType: "MEMBER",
    memberId,
    checkOutAt: null,
  });
  if (!open.length) return;

  const now = Date.now();
  await Promise.all(
    open.map((session) => {
      const expected = new Date(
        new Date(session.checkInAt).getTime() + minutes * 60000,
      );
      if (expected.getTime() > now) return null; // still legitimately inside
      session.checkOutAt = expected;
      session.autoClosed = true;
      return session.save();
    }),
  );
};

/** Loads the member and sweeps their stale sessions in one step. */
const loadMemberAndSweep = async (memberId) => {
  const member = await Member.findById(memberId).select(
    "branch sessionMinutes fullName",
  );
  if (!member) return null;
  await autoCloseStale(memberId, sessionLengthOf(member));
  return member;
};

/**
 * Start today's session.
 *
 * Stale sessions are swept first, so a member who forgot to tap out yesterday
 * (or three hours ago) is not blocked from training today.
 */
export const checkIn = async (req, res) => {
  try {
    const member = await loadMemberAndSweep(req.member.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const today = startOfDay();
    const existing = await Attendance.findOne({
      subjectType: "MEMBER",
      memberId: req.member.id,
      date: today,
    });

    if (existing) {
      /**
       * A REFUSED SCAN EARLIER TODAY IS NOT A COMPLETED SESSION.
       *
       * The QR path records a denial as a CLOSED row carrying deniedReason
       * (attendanceScan.controller.js), which to the two branches below looks
       * exactly like a workout already finished — so without this the member
       * would tap the button and be told "see you tomorrow", having trained
       * nowhere. The unique { memberId, date } index means the row cannot be
       * left alone and a second one inserted, so it is converted in place.
       *
       * This deliberately does NOT re-run eligibility. The button has never
       * evaluated subscription state and Phase 3 did not change that — the
       * gating belongs to the QR path, which is where the verdict is shown.
       * Adding it here would silently turn the existing button into a gate.
       */
      if (existing.deniedReason) {
        existing.deniedReason = null;
        existing.checkInAt = new Date();
        existing.checkOutAt = null;
        existing.autoClosed = false;
        existing.source = "SELF";
        existing.branch = member.branch;
        await existing.save();

        return res.status(200).json({
          isOk: true,
          status: 200,
          message: `Checked in at ${member.branch}`,
          data: withDuration(existing),
        });
      }

      // Two different situations, two different messages — "already checked in"
      // for a member standing at the door, and "come back tomorrow" for one who
      // already trained and left.
      if (existing.checkOutAt === null) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "You are already checked in for today",
          data: withDuration(existing),
        });
      }
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "You have already completed your session today. See you tomorrow!",
        data: withDuration(existing),
      });
    }

    const session = await Attendance.create({
      // The discriminator is written explicitly rather than left to the schema
      // default: this is the row that becomes footfall, and "the default will
      // cover it" is how a row ends up in neither bucket.
      subjectType: "MEMBER",
      memberId: req.member.id,
      trainerId: null,
      checkInAt: new Date(),
      checkOutAt: null,
      autoClosed: false,
      deniedReason: null,
      // The button path, not the QR. Both write the same shape of row (D2b) and
      // this is the only field that separates them.
      source: "SELF",
      branch: member.branch,
      date: today,
    });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Checked in at ${member.branch}`,
      data: withDuration(session),
    });
  } catch (error) {
    console.error("Check in error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * End today's session — a member's, OR a trainer's shift (docs/todo.md item 1).
 *
 * Deliberately does NOT sweep stale sessions first: if the subject is tapping
 * out late, their real tap is better data than the reconstruction, so let it
 * win.
 *
 * ============================================================================
 * req.portalUser IS THE ONLY THING THIS HANDLER MAY KEY OFF. NOT req.member.
 * ============================================================================
 * Behind requirePortalUser, so req.portalUser.subjectType is the verified
 * token claim — a trainer's token is validly signed with the same key a
 * member's is, so the signature alone proves nothing about whose row this is.
 * The filter below is built from that claim's OWN id, on the matching field
 * (trainerId for a TRAINER, memberId for a MEMBER), so:
 *   - a trainer's request can only ever match a TRAINER row carrying their own
 *     trainerId — never a member's row, and never another trainer's shift,
 *   - a member's request can only ever match a MEMBER row carrying their own
 *     memberId — exactly the behaviour this handler always had.
 * Getting this filter wrong the other way (e.g. defaulting to memberId when
 * subjectType is unrecognised) would let a trainer close a member's session;
 * there is deliberately no default branch.
 */
export const checkOut = async (req, res) => {
  try {
    const { id, subjectType } = req.portalUser;
    const ownerFilter =
      subjectType === "TRAINER"
        ? { subjectType: "TRAINER", trainerId: id }
        : { subjectType: "MEMBER", memberId: id };

    const session = await Attendance.findOne({
      ...ownerFilter,
      date: startOfDay(),
      checkOutAt: null,
      // A refused scan is a closed row with a reason on it, never an open
      // session, so this cannot pick one up — but saying so keeps the
      // check-out path honest if that ever changes.
      deniedReason: null,
    });

    if (!session) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "You don't have an open session to check out of",
      });
    }

    session.checkOutAt = new Date();
    session.autoClosed = false;
    await session.save();

    const result = withDuration(session);
    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Checked out after ${result.durationMinutes} minutes`,
      data: result,
    });
  } catch (error) {
    console.error("Check out error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Today's session (or null), with the expected check-out time while open. */
export const getToday = async (req, res) => {
  try {
    const member = await loadMemberAndSweep(req.member.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const minutes = sessionLengthOf(member);
    const session = await Attendance.findOne({
      subjectType: "MEMBER",
      memberId: req.member.id,
      date: startOfDay(),
    });

    // Only meaningful while a session is open — on a closed one the actual
    // check-out time is the answer, and a second "expected" figure beside it
    // would just invite the portal to show the wrong one.
    const expectedCheckOutAt =
      session && session.checkOutAt === null
        ? new Date(new Date(session.checkInAt).getTime() + minutes * 60000)
        : null;

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        session: withDuration(session),
        sessionMinutes: minutes,
        expectedCheckOutAt,
        branch: member.branch,
      },
    });
  } catch (error) {
    console.error("Get today attendance error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Streaks over a set of day-timestamps.
 *
 * EDGE CASES THIS HANDLES:
 *  - TODAY IS NOT OVER YET. A member with sessions on the 3rd–7th, checked on
 *    the 8th before training, is on a 5-day streak, not a broken one. So the
 *    count is allowed to start at either today OR yesterday; only a gap before
 *    yesterday ends it.
 *  - DUPLICATE DAYS are impossible by index, but the set collapses them anyway
 *    so a data repair can't inflate a streak.
 *  - THE WINDOW EDGE. currentStreak counts back from today through the days
 *    supplied; a streak that began before `from` reads as truncated. That's
 *    accepted — the caller asked about a window, and widening it silently would
 *    make the number depend on data the member didn't ask to see.
 *  - NO SESSIONS AT ALL gives 0/0 rather than 1, because "never trained" is not
 *    a one-day streak.
 */
const computeStreaks = (days) => {
  // Midnight timestamps, deduplicated and ascending.
  const stamps = [...new Set(days.map((d) => startOfDay(d).getTime()))].sort(
    (a, b) => a - b,
  );
  if (!stamps.length) return { currentStreak: 0, longestStreak: 0 };

  const DAY = 24 * 60 * 60 * 1000;

  let longest = 1;
  let run = 1;
  for (let i = 1; i < stamps.length; i += 1) {
    // Day arithmetic on midnight stamps, so a DST shift moves the wall clock
    // but never the day boundary the comparison relies on.
    const gap = Math.round((stamps[i] - stamps[i - 1]) / DAY);
    run = gap === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const today = startOfDay().getTime();
  const newest = stamps[stamps.length - 1];
  const daysSinceNewest = Math.round((today - newest) / DAY);

  // Anything older than yesterday means the streak is already broken.
  let current = 0;
  if (daysSinceNewest <= 1) {
    current = 1;
    for (let i = stamps.length - 1; i > 0; i -= 1) {
      if (Math.round((stamps[i] - stamps[i - 1]) / DAY) === 1) current += 1;
      else break;
    }
  }

  return { currentStreak: current, longestStreak: longest };
};

/**
 * Sessions in a window, with the summary the dashboard shows above them.
 *
 * Accepts from/to ISO dates or month=YYYY-MM; defaults to the current month.
 */
export const listAttendance = async (req, res) => {
  try {
    const member = await loadMemberAndSweep(req.member.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const { from, to, month } = req.query;

    let start;
    let end;

    if (month) {
      // YYYY-MM. Built from parts rather than parsed as a date string, because
      // new Date("2026-09") is UTC midnight and lands in the previous month for
      // anyone east of Greenwich — including this gym.
      const match = /^(\d{4})-(\d{2})$/.exec(String(month));
      if (!match) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "Month must be in YYYY-MM format",
        });
      }
      const year = Number(match[1]);
      const monthIndex = Number(match[2]) - 1;
      if (monthIndex < 0 || monthIndex > 11) {
        return res
          .status(400)
          .json({ isOk: false, status: 400, message: "Invalid month" });
      }
      start = new Date(year, monthIndex, 1);
      start.setHours(0, 0, 0, 0);
      // Day 0 of the next month is the last day of this one — no leap-year or
      // 30/31 table needed.
      end = new Date(year, monthIndex + 1, 0);
      end.setHours(0, 0, 0, 0);
    } else if (from || to) {
      start = startOfDay(from) || startOfDay();
      end = startOfDay(to) || startOfDay();
      if (!startOfDay(from) && from) {
        return res
          .status(400)
          .json({ isOk: false, status: 400, message: "Invalid 'from' date" });
      }
      if (!startOfDay(to) && to) {
        return res
          .status(400)
          .json({ isOk: false, status: 400, message: "Invalid 'to' date" });
      }
      if (start > end) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "'from' must be on or before 'to'",
        });
      }
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      end.setHours(0, 0, 0, 0);
    }

    // Cap the window rather than reject it: a portal bug asking for ten years
    // should return a year of data, not an error the member has to interpret.
    const DAY = 24 * 60 * 60 * 1000;
    const MAX_DAYS = 366;
    if (Math.round((end - start) / DAY) + 1 > MAX_DAYS) {
      end = new Date(start.getTime() + (MAX_DAYS - 1) * DAY);
      end.setHours(0, 0, 0, 0);
    }

    const sessions = await Attendance.find({
      subjectType: "MEMBER",
      memberId: req.member.id,
      date: { $gte: start, $lte: end },
      // Refused attempts are not sessions. Leaving them in would break the
      // member's own streak and minute totals with days they were turned away.
      deniedReason: null,
    })
      .sort({ date: 1 })
      .lean();

    const rows = sessions.map((s) => ({ ...s, durationMinutes: durationMinutes(s) }));

    // Open sessions contribute nothing to totalMinutes — the time isn't spent
    // yet, and counting a partial session would make the figure fall when the
    // member finally taps out.
    const totalMinutes = rows.reduce((sum, r) => sum + (r.durationMinutes || 0), 0);

    const { currentStreak, longestStreak } = computeStreaks(
      rows.map((r) => r.date),
    );

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        from: start,
        to: end,
        sessions: rows,
        summary: {
          totalSessions: rows.length,
          currentStreak,
          longestStreak,
          totalMinutes,
        },
      },
    });
  } catch (error) {
    console.error("List attendance error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * The member's own typical session length, which drives the auto-close.
 *
 * Bounded at 60–120 in the schema too; validated here as well so the member
 * gets a sentence rather than a Mongoose ValidationError.
 */
export const updateSessionLength = async (req, res) => {
  try {
    const minutes = Number(req.body.sessionMinutes);

    if (!minutes || Number.isNaN(minutes) || !Number.isInteger(minutes)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Session length must be a whole number of minutes",
      });
    }
    if (minutes < 60 || minutes > 120) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Session length must be between 60 and 120 minutes",
      });
    }

    const member = await Member.findByIdAndUpdate(
      req.member.id,
      { $set: { sessionMinutes: minutes } },
      { new: true },
    ).select("sessionMinutes");

    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Session length set to ${minutes} minutes`,
      data: { sessionMinutes: member.sessionMinutes },
    });
  } catch (error) {
    console.error("Update session length error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
