import mongoose from "mongoose";
import WorkoutPlan from "../../models/WorkoutPlan.js";
import WorkoutLog from "../../models/WorkoutLog.js";
import Member from "../../models/Member.js";

/**
 * Workout plans (staff-configured) and workout logs (member-recorded).
 *
 * The member-facing handlers scope every query by req.member.id, which
 * requireMember derives from the verified token. No handler accepts a memberId
 * from the client — that would let any logged-in member read or write another's
 * training log.
 */

/** Midnight local, so a session belongs to a day rather than an instant. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Plans run Day 1..Day 6; anything else is a client bug, not a new day. */
const MIN_DAY = 1;
const MAX_DAY = 6;

/**
 * A plausible loaded-barbell range in kg.
 *
 * Rejecting nonsense keeps one fat-fingered "5000" out of the member's history,
 * where it would misrepresent what they actually lifted.
 */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 500;

/**
 * The plan a member actually follows.
 *
 * A null workoutPlanId is not missing data — it is the normal case, meaning
 * "follows whatever the gym default currently is". Resolving it at read time
 * rather than copying the plan onto the member is what makes an edit to the
 * default reach every such member at once.
 */
const resolveEffectivePlan = async (member) => {
  if (member?.workoutPlanId) {
    const assigned = await WorkoutPlan.findById(member.workoutPlanId).lean();
    // Falls through to the default when the assigned plan was deleted, so a
    // stale pointer leaves the member with a programme rather than an error.
    if (assigned) return assigned;
  }
  return WorkoutPlan.findOne({ isDefault: true }).lean();
};

/** Days sorted 1..6 — array order in the document is not guaranteed to be. */
const withSortedDays = (plan) => {
  if (!plan) return null;
  const days = [...(plan.days || [])].sort(
    (a, b) => (a.dayNumber || 0) - (b.dayNumber || 0),
  );
  return { ...plan, days };
};

/**
 * Group a log's DONE entries by the split day each came from.
 *
 * A session can span several days — two leg exercises and two shoulder ones is
 * one session, two days — so a calendar row needs the breakdown rather than the
 * log's single headline dayNumber.
 *
 * Entries with a null dayNumber predate per-entry attribution and therefore
 * belong to the document-level day (see EntrySchema); that fallback is what
 * makes an old single-day log come back as one group reading exactly as it
 * always did, with no stored document rewritten.
 *
 * Label precedence is deliberate: the entry's OWN copied label wins, because it
 * records what the day was called when the log was written. Only when there
 * isn't one (an old entry) do we consult the current plan, and a day the plan no
 * longer has resolves to null rather than to some other day's current label —
 * the same reasoning as the row-level dayLabel below.
 */
const groupDoneEntriesByDay = (doneEntries, logDayNumber, labelByDay) => {
  const groups = new Map();

  for (const entry of doneEntries) {
    const dayNumber = entry.dayNumber ?? logDayNumber ?? null;
    // Map keyed on the raw value so a null day (an old log that never recorded
    // one either) still forms its own group rather than being dropped.
    if (!groups.has(dayNumber)) {
      const copiedLabel = String(entry.dayLabel || "").trim();
      groups.set(dayNumber, {
        dayNumber,
        dayLabel:
          copiedLabel ||
          (dayNumber == null ? null : labelByDay.get(dayNumber) ?? null),
        exerciseNames: [],
      });
    }
    groups.get(dayNumber).exerciseNames.push(entry.exerciseName);
  }

  // Sorted by day so the calendar reads "Legs + Shoulders" in split order
  // rather than in whatever order the member happened to tick things off. A
  // null day sorts last: it is the unattributed remainder, not Day 0.
  return [...groups.values()].sort((a, b) => {
    if (a.dayNumber == null) return 1;
    if (b.dayNumber == null) return -1;
    return a.dayNumber - b.dayNumber;
  });
};

/**
 * Validate a days array coming from a staff client.
 *
 * Returns an error string, or null when the shape is good. Checked here rather
 * than left to Mongoose so staff get a sentence naming the offending day
 * instead of a ValidationError path.
 */
const validateDays = (days) => {
  if (days === undefined) return null;
  if (!Array.isArray(days)) return "Days must be a list";

  const seen = new Set();
  for (const day of days) {
    const dayNumber = Number(day?.dayNumber);
    if (!Number.isInteger(dayNumber) || dayNumber < MIN_DAY || dayNumber > MAX_DAY) {
      return `Day number must be a whole number between ${MIN_DAY} and ${MAX_DAY}`;
    }
    if (seen.has(dayNumber)) return `Day ${dayNumber} is listed twice`;
    seen.add(dayNumber);

    if (day.exercises !== undefined && !Array.isArray(day.exercises)) {
      return `Exercises for day ${dayNumber} must be a list`;
    }
    for (const exercise of day.exercises || []) {
      if (!String(exercise?.name || "").trim()) {
        return `Every exercise on day ${dayNumber} needs a name`;
      }
    }
  }
  return null;
};

/** Strip a staff-supplied days array down to the fields the schema owns. */
const normaliseDays = (days) =>
  (days || []).map((day) => ({
    dayNumber: Number(day.dayNumber),
    label: String(day.label || "").trim(),
    exercises: (day.exercises || []).map((exercise) => ({
      name: String(exercise.name).trim(),
      targetSets:
        exercise.targetSets === undefined ? 4 : Number(exercise.targetSets),
      targetReps: String(exercise.targetReps || "").trim(),
      notes: String(exercise.notes || "").trim(),
    })),
  }));

// ============ MEMBER-FACING ============

/**
 * The member's effective plan — their assignment, else the gym default.
 */
export const getMyPlan = async (req, res) => {
  try {
    const member = await Member.findById(req.member.id).select("workoutPlanId");
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const plan = await resolveEffectivePlan(member);
    if (!plan) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message:
          "No workout plan has been set up yet. Please ask the gym staff to configure one.",
      });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        plan: withSortedDays(plan),
        // Tells the portal whether this member is on something bespoke or on
        // the shared default, without it having to compare ids itself.
        isCustomPlan: Boolean(member.workoutPlanId),
      },
    });
  } catch (error) {
    console.error("Get my workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Today's log, or null when the member hasn't started yet.
 *
 * Returning null rather than 404 because "no workout logged yet today" is the
 * ordinary state every morning, not an error the portal should handle.
 */
export const getTodayLog = async (req, res) => {
  try {
    const day = startOfDay(req.query.date);
    if (!day) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid date" });
    }

    // Whole document, no .select() — so each entry's dayNumber/dayLabel come
    // back alongside exerciseName/done/weightKg without the wrapper changing.
    // Entries written before per-entry attribution have a null dayNumber, which
    // the client reads as "the log's own dayNumber" (see EntrySchema).
    const log = await WorkoutLog.findOne({
      memberId: req.member.id,
      date: day,
    }).lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: { date: day, log: log || null },
    });
  } catch (error) {
    console.error("Get today workout log error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Logged sessions across a date range, summarised for the calendar.
 *
 * getTodayLog answers "what am I doing right now" for one day; this answers
 * "which days did I train, and what did I do" for a month at a time. The
 * attendance calendar marks the days; these rows put the exercises on them.
 *
 * Parameters mirror listAttendance exactly (month, or from/to, else the current
 * month) because one calendar screen calls both — a member changing month must
 * not have to speak two dialects to get the two halves of the same view.
 */
export const listWorkoutLogs = async (req, res) => {
  try {
    const { from, to, month } = req.query;

    let start;
    let end;

    if (month) {
      // YYYY-MM built from parts, not parsed: new Date("2026-09") is UTC
      // midnight and lands in the previous month east of Greenwich, this gym
      // included. Same construction as listAttendance.
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
      // Day 0 of the next month is the last day of this one.
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

    // Capped, not rejected — same 366-day ceiling as listAttendance, for the
    // same reason: a portal bug asking for ten years should return a year of
    // data rather than an error the member has to interpret. The two calendar
    // endpoints must truncate identically or a wide range would return
    // attendance days with no exercises hanging off the tail.
    const DAY = 24 * 60 * 60 * 1000;
    const MAX_DAYS = 366;
    if (Math.round((end - start) / DAY) + 1 > MAX_DAYS) {
      end = new Date(start.getTime() + (MAX_DAYS - 1) * DAY);
      end.setHours(0, 0, 0, 0);
    }

    // Scoped to the token's member, and selected down to the fields the
    // calendar renders: weightKg and planId would drag a year of full documents
    // across for icons that never show them.
    const logs = await WorkoutLog.find({
      memberId: req.member.id,
      date: { $gte: start, $lte: end },
    })
      // entries.dayNumber/dayLabel added so byDay can group without a second
      // query. weightKg stays out deliberately — see above; the calendar never
      // renders it, and a year of it is dead weight on the wire.
      .select(
        "date dayNumber entries.exerciseName entries.done entries.dayNumber entries.dayLabel",
      )
      .sort({ date: 1 })
      .lean();

    // One plan lookup for the whole range rather than one per log: every row
    // resolves its label against the member's CURRENT plan.
    const member = await Member.findById(req.member.id).select("workoutPlanId");
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }
    const plan = await resolveEffectivePlan(member);

    const labelByDay = new Map(
      (plan?.days || []).map((day) => [day.dayNumber, day.label || null]),
    );

    const rows = logs.map((log) => {
      const entries = log.entries || [];
      const doneEntries = entries.filter((e) => e.done);

      return {
        _id: log._id,
        date: log.date,
        dayNumber: log.dayNumber,
        // Null when the plan changed or the day was deleted since the log was
        // written. A stale label is worse than none: labelling an old Day 3 with
        // whatever Day 3 means today would tell the member they trained legs on
        // a day they trained chest — the log's own exerciseNames are the
        // historical truth, and a missing heading is obviously missing, whereas
        // a wrong one is silently believed.
        dayLabel:
          log.dayNumber == null
            ? null
            : labelByDay.get(log.dayNumber) ?? null,
        totalExercises: entries.length,
        doneExercises: doneEntries.length,
        // Done only. A calendar icon asserts "did this", not "was scheduled" —
        // showing skipped exercises would overstate the session.
        exerciseNames: doneEntries.map((e) => e.exerciseName),
        // ADDITIVE: the same done exercises as exerciseNames, split by the day
        // each came from, so one date can render "Legs + Shoulders" instead of
        // being forced to claim a single day. Every field above keeps its exact
        // previous meaning; a client that ignores this sees no change.
        byDay: groupDoneEntriesByDay(doneEntries, log.dayNumber, labelByDay),
      };
    });

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: { from: start, to: end, logs: rows },
    });
  } catch (error) {
    console.error("List workout logs error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Save the day's ticks and weights.
 *
 * Upserts on {memberId, date}: a member who ticks three exercises, trains, then
 * ticks the rest is logging ONE session, so the second save updates the first.
 */
export const saveLog = async (req, res) => {
  try {
    const { dayNumber, entries, date } = req.body;

    const day = Number(dayNumber);
    if (!Number.isInteger(day) || day < MIN_DAY || day > MAX_DAY) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `Please pick a day between ${MIN_DAY} and ${MAX_DAY}`,
      });
    }

    // The body-level dayNumber stays REQUIRED even though entries may now carry
    // their own. A client that sends no per-entry day is the old shape and must
    // keep working exactly as before, so this remains the session's day and the
    // fallback for every entry that does not name one.

    if (!Array.isArray(entries)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Entries must be a list",
      });
    }

    const logDate = startOfDay(date);
    if (!logDate) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid date" });
    }

    // The plan is resolved server-side; the client never says which plan it was
    // following, so a stale tab cannot attribute the session to the wrong one.
    // Resolved BEFORE the entry loop because each entry's day label is copied
    // from it at log time — see the EntrySchema comment on why the label is
    // copied rather than looked up when the log is later read.
    const member = await Member.findById(req.member.id).select("workoutPlanId");
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }
    const plan = await resolveEffectivePlan(member);

    const planLabelByDay = new Map(
      (plan?.days || []).map((d) => [d.dayNumber, String(d.label || "").trim()]),
    );

    const cleanEntries = [];
    for (const entry of entries) {
      const name = String(entry?.exerciseName || "").trim();
      if (!name) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "Every entry needs an exercise name",
        });
      }

      // Per-entry day is OPTIONAL: absent means "this entry belongs to the
      // session's day", which is exactly how every log written before this
      // feature reads. Only a supplied value is validated, so the old body
      // shape cannot start failing.
      let entryDayNumber = null;
      let entryDayLabel = "";
      if (
        entry.dayNumber !== undefined &&
        entry.dayNumber !== null &&
        entry.dayNumber !== ""
      ) {
        const entryDay = Number(entry.dayNumber);
        if (
          !Number.isInteger(entryDay) ||
          entryDay < MIN_DAY ||
          entryDay > MAX_DAY
        ) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: `Day for ${name} must be between ${MIN_DAY} and ${MAX_DAY}`,
          });
        }
        entryDayNumber = entryDay;
        // Label taken from the plan, not from the client: the client could send
        // anything, and the log is supposed to record what the day was actually
        // called at the time. Falls back to the client's string only when the
        // plan has no such day, so a label is still better than blank.
        entryDayLabel =
          planLabelByDay.get(entryDay) ?? String(entry.dayLabel || "").trim();
      }

      // Absent and null both mean "not recorded" — only an actual value is
      // range-checked, so a member can tick an exercise off without a weight.
      let weightKg = null;
      if (entry.weightKg !== undefined && entry.weightKg !== null && entry.weightKg !== "") {
        const weight = Number(entry.weightKg);
        if (Number.isNaN(weight)) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: `Weight for ${name} must be a number`,
          });
        }
        if (weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: `Please enter a weight between ${MIN_WEIGHT} and ${MAX_WEIGHT} kg for ${name}`,
          });
        }
        weightKg = weight;
      }

      cleanEntries.push({
        exerciseName: name,
        done: Boolean(entry.done),
        weightKg,
        dayNumber: entryDayNumber,
        dayLabel: entryDayLabel,
      });
    }

    /**
     * The session's headline day when entries span several.
     *
     * Whichever day contributed the MOST done exercises wins; ties and a
     * session with nothing ticked yet fall back to the day the member selected.
     * Chosen because this number is what a single-day reader (an old client, a
     * summary line) shows as "what you trained", and the day you did most of is
     * the least misleading answer to that. It is never used to reconstruct the
     * breakdown — the entries carry that — so a tie being resolved arbitrarily
     * loses no information.
     */
    const doneByDay = new Map();
    for (const entry of cleanEntries) {
      if (!entry.done) continue;
      const attributedDay = entry.dayNumber ?? day;
      doneByDay.set(attributedDay, (doneByDay.get(attributedDay) || 0) + 1);
    }
    let primaryDay = day;
    let bestCount = doneByDay.get(day) || 0;
    for (const [candidateDay, count] of doneByDay) {
      if (count > bestCount) {
        primaryDay = candidateDay;
        bestCount = count;
      }
    }

    const log = await WorkoutLog.findOneAndUpdate(
      { memberId: req.member.id, date: logDate },
      {
        $set: {
          dayNumber: primaryDay,
          entries: cleanEntries,
          planId: plan?._id || null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    const doneCount = cleanEntries.filter((e) => e.done).length;
    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Saved ${doneCount} of ${cleanEntries.length} exercises`,
      data: log,
    });
  } catch (error) {
    console.error("Save workout log error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

// ============ STAFF-FACING ============

/** Every plan, default first so the one most staff want is at the top. */
export const listWorkoutPlans = async (req, res) => {
  try {
    const plans = await WorkoutPlan.find({})
      .sort({ isDefault: -1, name: 1 })
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: plans.map(withSortedDays),
    });
  } catch (error) {
    console.error("List workout plans error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getWorkoutPlanById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid plan id" });
    }

    const plan = await WorkoutPlan.findById(req.params.id).lean();
    if (!plan) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Workout plan not found" });
    }

    return res
      .status(200)
      .json({ isOk: true, status: 200, data: withSortedDays(plan) });
  } catch (error) {
    console.error("Get workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createWorkoutPlan = async (req, res) => {
  try {
    const { name, days, isActive, isDefault } = req.body;

    if (!String(name || "").trim()) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Plan name is required" });
    }

    const daysError = validateDays(days);
    if (daysError) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: daysError });
    }

    // Promoting a new default demotes the old one first: the partial unique
    // index would otherwise reject the insert outright, which reads to staff as
    // a mysterious failure rather than "there is already a default".
    if (isDefault === true) {
      await WorkoutPlan.updateMany(
        { isDefault: true },
        { $set: { isDefault: false } },
      );
    }

    const plan = await WorkoutPlan.create({
      name: String(name).trim(),
      days: normaliseDays(days),
      isActive: isActive === undefined ? true : Boolean(isActive),
      isDefault: isDefault === true,
    });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Created workout plan '${plan.name}'`,
      data: plan,
    });
  } catch (error) {
    console.error("Create workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Update a plan, including a full replacement of its days/exercises. */
export const updateWorkoutPlan = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid plan id" });
    }

    const { name, days, isActive, isDefault } = req.body;

    const daysError = validateDays(days);
    if (daysError) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: daysError });
    }

    const plan = await WorkoutPlan.findById(req.params.id);
    if (!plan) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Workout plan not found" });
    }

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res
          .status(400)
          .json({ isOk: false, status: 400, message: "Plan name is required" });
      }
      plan.name = String(name).trim();
    }

    // Whole-array replacement, not a merge: the admin screen sends the complete
    // day list, so a missing day means "deleted" rather than "unchanged".
    if (days !== undefined) plan.days = normaliseDays(days);
    if (isActive !== undefined) plan.isActive = Boolean(isActive);

    if (isDefault === true && !plan.isDefault) {
      await WorkoutPlan.updateMany(
        { isDefault: true, _id: { $ne: plan._id } },
        { $set: { isDefault: false } },
      );
      plan.isDefault = true;
    } else if (isDefault === false && plan.isDefault) {
      // Refused rather than obeyed: clearing the last default would leave every
      // member without an assignment with no programme at all.
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "Make another plan the default instead — the gym must always have one default plan",
      });
    }

    await plan.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Updated workout plan '${plan.name}'`,
      data: plan,
    });
  } catch (error) {
    console.error("Update workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Delete a plan, unless something still depends on it.
 *
 * Both refusals name the reason: "cannot delete" with no cause sends staff
 * hunting through the UI for a constraint they can't see.
 */
export const deleteWorkoutPlan = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid plan id" });
    }

    const plan = await WorkoutPlan.findById(req.params.id);
    if (!plan) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Workout plan not found" });
    }

    if (plan.isDefault) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "This is the gym's default plan — make another plan the default before deleting it",
      });
    }

    const assignedCount = await Member.countDocuments({
      workoutPlanId: plan._id,
    });
    if (assignedCount > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `${assignedCount} member(s) are assigned to this plan — move them to another plan first`,
      });
    }

    await plan.deleteOne();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Deleted workout plan '${plan.name}'`,
    });
  } catch (error) {
    console.error("Delete workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Assign a plan to a member, or reset them to the gym default.
 *
 * A null workoutPlanId is the reset: it puts the member back on the shared
 * default, so they pick up future improvements to it automatically.
 */
export const assignMemberWorkoutPlan = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid member id" });
    }

    const { workoutPlanId } = req.body;

    let planId = null;
    if (workoutPlanId !== null && workoutPlanId !== undefined && workoutPlanId !== "") {
      if (!mongoose.isValidObjectId(workoutPlanId)) {
        return res
          .status(400)
          .json({ isOk: false, status: 400, message: "Invalid plan id" });
      }
      const plan = await WorkoutPlan.findById(workoutPlanId).select("_id");
      if (!plan) {
        return res.status(404).json({
          isOk: false,
          status: 404,
          message: "Workout plan not found",
        });
      }
      planId = plan._id;
    }

    const member = await Member.findByIdAndUpdate(
      req.params.id,
      { $set: { workoutPlanId: planId } },
      { new: true },
    ).select("fullName workoutPlanId");

    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: planId
        ? `${member.fullName} assigned a custom workout plan`
        : `${member.fullName} reset to the gym default plan`,
      data: { memberId: member._id, workoutPlanId: member.workoutPlanId },
    });
  } catch (error) {
    console.error("Assign member workout plan error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
