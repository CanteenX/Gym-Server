import mongoose from "mongoose";
import ClassSession, {
  MAX_CAPACITY,
  MAX_DURATION_MINUTES,
} from "../../models/ClassSession.js";
import Booking from "../../models/Booking.js";
import Branch from "../../models/Branch.js";
import Trainer from "../../models/Trainer.js";
import {
  scopeFilter,
  scopedBranch,
  resolveBranchFilter,
} from "../../middlewares/branchScope.js";

// Same helper as every other list controller here: a user-supplied `match`
// becomes part of a $regex, so its metacharacters must be neutralised or a
// search for "(" is a crash and ".*" is a full table scan.
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ isOk: false, status, message, ...extra });

/**
 * Multipart and query values arrive as strings. Coercing at the edge keeps
 * every comparison below honest; without it `Boolean("false")` is true and a
 * session switched off in the UI stays bookable.
 */
const toBool = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === "true" || v === "1" || v === 1;
};

/**
 * A finite Date or null. `new Date("")` is an Invalid Date that saves cleanly
 * and then sorts before everything forever — the Phase 1 advert bug where a
 * cleared date picker stored one. Rejecting it here is the fix.
 */
const toDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * Keeps a branch honest without hardcoding "Vasna"/"Gotri" — the same check
 * lead.controller.js does, and for the same reason (models/Branch.js made
 * branches data, so opening a third gym must not need this file edited).
 *
 * `isPhysical: true` matters: "Common" is an accounting bucket for shared costs,
 * not a place a class can be held in.
 *
 * @param {string} name
 * @returns {Promise<string|null>} the canonical branch name, or null
 */
const resolvePhysicalBranch = async (name) => {
  const asked = typeof name === "string" ? name.trim() : "";
  if (!asked) return null;
  const branch = await Branch.findOne({
    name: asked,
    isActive: true,
    isPhysical: true,
  })
    .select("name")
    .lean();
  return branch?.name || null;
};

/**
 * Fields the public list is allowed to see.
 *
 * `notes` is staff-internal and `bookedCount` is an operational number; neither
 * belongs on a marketing page. `remainingCapacity` is derived and sent instead,
 * which is the number a visitor actually needs and leaks nothing about how full
 * the class has been over time.
 */
const publicView = (session) => ({
  _id: session._id,
  title: session.title,
  description: session.description,
  branch: session.branch,
  start: session.start,
  durationMinutes: session.durationMinutes,
  endsAt: session.endsAt,
  capacity: session.capacity,
  remainingCapacity: session.remainingCapacity,
  isFull: session.isFull,
  allowGuests: session.allowGuests,
  trainerName: session.trainer?.fullName || "",
});

/**
 * PUBLIC — upcoming, bookable classes for the marketing site's booking form.
 *
 * No auth and no session: this is printed on midcitygym.in next to a "Book a
 * free trial" button, exactly like GET /site/items. Only ACTIVE sessions that
 * have not yet started are returned — a visitor must never be shown a slot the
 * booking endpoint will then refuse, because the two would look like a bug.
 *
 * NOT BRANCH-SCOPED, and that is correct: there is no session, so there is no
 * branch to scope to. `?branch=` NARROWS for a visitor who has chosen a gym.
 *
 * GET /api/v1/classes/upcoming?branch=Vasna&days=14
 */
export const getPublicUpcomingSessions = async (req, res) => {
  try {
    const { branch, days } = req.query || {};

    const now = new Date();
    // Default a fortnight. Capped at 90 so a crafted `?days=100000` cannot turn
    // a public endpoint into a full-collection scan.
    const windowDays = Math.min(Math.max(toInt(days, 14), 1), 90);
    const until = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

    const filter = { isActive: true, start: { $gt: now, $lte: until } };

    const safeBranch = await resolvePhysicalBranch(branch);
    // An unknown branch narrows to nothing rather than being ignored: silently
    // showing Vasna's timetable to somebody who asked for a third gym is worse
    // than showing an empty list.
    if (typeof branch === "string" && branch.trim() && !safeBranch) {
      return ok(res, 200, "Upcoming classes fetched successfully", []);
    }
    if (safeBranch) filter.branch = safeBranch;

    const sessions = await ClassSession.find(filter)
      .populate("trainer", "fullName")
      .sort({ start: 1 })
      .limit(200);

    return ok(
      res,
      200,
      "Upcoming classes fetched successfully",
      sessions.map(publicView),
    );
  } catch (error) {
    console.error("Error fetching upcoming classes:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — paged list, house `…-by-params` convention.
 *
 * BRANCH SCOPING: resolveBranchFilter reads req.session.user (NOT req.user,
 * which carries no branch — see middlewares/branchScope.js) and ignores any
 * client-supplied branch for a branch admin.
 *
 * POST /api/v1/classes-by-params
 */
export const listSessionsByParams = async (req, res) => {
  try {
    const {
      skip,
      per_page,
      sorton,
      sortdir,
      match,
      branch,
      isActive,
      fromDate,
      toDate: toDateRaw,
      upcomingOnly,
    } = req.body || {};

    const safeSkip = Math.max(0, toInt(skip, 0));
    const safePerPage = Math.min(Math.max(toInt(per_page, 20), 1), 200);

    const matchCondition = {};

    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = toBool(isActive, true);
    }

    const from = toDate(fromDate);
    const to = toDate(toDateRaw);
    if (from || to || toBool(upcomingOnly, false)) {
      matchCondition.start = {};
      if (from) matchCondition.start.$gte = from;
      if (to) matchCondition.start.$lte = to;
      if (toBool(upcomingOnly, false) && !from) {
        matchCondition.start.$gte = new Date();
      }
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
      ];
    }

    // Applied LAST so it is authoritative over anything above. A branch admin's
    // own branch always wins; `branch` from the body can only narrow a super
    // admin's view.
    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) matchCondition.branch = effectiveBranch;

    const allowed = ["start", "title", "branch", "capacity", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "start";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await ClassSession.countDocuments(matchCondition);
    const data = await ClassSession.find(matchCondition)
      .populate("trainer", "fullName mobileNumber branch")
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing class sessions:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * Validates and normalises the writable fields shared by create and update.
 *
 * Returns `{ error }` rather than throwing so the caller owns the response
 * shape, matching siteItem.controller.js.
 *
 * @param {object} body
 * @param {object} [existing] the current document, for an update
 * @returns {Promise<{values?: object, error?: string}>}
 */
const buildSessionValues = async (body, existing = null) => {
  const values = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { error: "title is required" };
    values.title = title.slice(0, 200);
  } else if (!existing) {
    return { error: "title is required" };
  }

  if (body.description !== undefined) {
    values.description = String(body.description ?? "").trim().slice(0, 2000);
  }
  if (body.notes !== undefined) {
    values.notes = String(body.notes ?? "").trim().slice(0, 2000);
  }

  if (body.start !== undefined) {
    const start = toDate(body.start);
    if (!start) return { error: "start must be a valid date and time" };
    values.start = start;
  } else if (!existing) {
    return { error: "start is required" };
  }

  if (body.durationMinutes !== undefined && body.durationMinutes !== "") {
    const mins = toInt(body.durationMinutes, NaN);
    if (!Number.isFinite(mins) || mins < 5 || mins > MAX_DURATION_MINUTES) {
      return { error: `durationMinutes must be between 5 and ${MAX_DURATION_MINUTES}` };
    }
    values.durationMinutes = mins;
  }

  if (body.capacity !== undefined && body.capacity !== "") {
    const capacity = toInt(body.capacity, NaN);
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      return { error: `capacity must be between 1 and ${MAX_CAPACITY}` };
    }
    /**
     * LOWERING CAPACITY BELOW WHAT IS ALREADY BOOKED IS REFUSED.
     *
     * Allowing it would leave `bookedCount > capacity`, which the atomic
     * reservation reads as "full" (correct) but which also means somebody who
     * already holds a confirmed place is now over the line — and nothing tells
     * them. Staff must cancel the bookings first, so the people affected are
     * told by a human. `bookedCount` is read here purely to produce the error
     * message; no booking decision is made from it.
     */
    if (existing && capacity < (existing.bookedCount || 0)) {
      return {
        error:
          `Capacity cannot be set below the ${existing.bookedCount} place(s) ` +
          `already booked — cancel those bookings first`,
      };
    }
    values.capacity = capacity;
  } else if (!existing) {
    return { error: "capacity is required" };
  }

  if (body.trainer !== undefined) {
    if (body.trainer === null || body.trainer === "") {
      values.trainer = null;
    } else {
      if (!mongoose.isValidObjectId(body.trainer)) {
        return { error: "trainer must be a valid trainer id" };
      }
      const trainer = await Trainer.findById(body.trainer).select("_id").lean();
      if (!trainer) return { error: "Trainer not found" };
      values.trainer = body.trainer;
    }
  }

  if (body.allowGuests !== undefined) {
    values.allowGuests = toBool(body.allowGuests, true);
  }
  if (body.isActive !== undefined) {
    values.isActive = toBool(body.isActive, true);
  }

  return { values };
};

/**
 * ADMIN — schedule a class.
 *
 * BRANCH COMES FROM THE SESSION, NOT THE BODY, for a branch admin. A Gotri
 * admin posting `branch: "Vasna"` gets a Gotri class: scopedBranch(req) wins
 * outright, because a branch is a fact about who is logged in and never a field
 * the client fills in (middlewares/branchScope.js).
 *
 * A super admin (scopedBranch === null) has no own branch, so they MUST name
 * one — there is no sensible default and picking "Vasna" silently would put
 * classes in the wrong gym.
 *
 * POST /api/v1/classes
 */
export const createSession = async (req, res) => {
  try {
    const own = scopedBranch(req);
    const requested = own || req.body?.branch;
    const branch = await resolvePhysicalBranch(requested);
    if (!branch) {
      return fail(
        res,
        400,
        own
          ? `Your branch '${own}' is not an active physical branch`
          : "branch is required and must be an active physical branch",
      );
    }

    const { values, error } = await buildSessionValues(req.body || {});
    if (error) return fail(res, 400, error);

    const session = await ClassSession.create({
      ...values,
      branch,
      // Never accepted from the client — it is maintained only by
      // services/bookingCapacity.js. Set explicitly so a stray body field
      // cannot reach the document through some future spread.
      bookedCount: 0,
    });

    return ok(res, 201, "Class scheduled successfully", session);
  } catch (error) {
    console.error("Error creating class session:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — edit a class.
 *
 * The lookup is scoped, so a Gotri admin editing a Vasna session id gets a 404
 * rather than a silent cross-branch write. `branch` is NOT editable by a branch
 * admin for the same reason it is not settable on create; a super admin may
 * move a session between branches.
 *
 * PUT /api/v1/classes/:id
 */
export const updateSession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return fail(res, 400, "Invalid class id");
    }

    // scopeFilter spread LAST — authoritative over the id lookup.
    const session = await ClassSession.findOne({ _id: id, ...scopeFilter(req) });
    if (!session) return fail(res, 404, "Class not found");

    const { values, error } = await buildSessionValues(req.body || {}, session);
    if (error) return fail(res, 400, error);

    // Only a super admin may move a class to another branch. scopedBranch()
    // returns null for them and their own branch for everybody else.
    if (req.body?.branch !== undefined && !scopedBranch(req)) {
      const branch = await resolvePhysicalBranch(req.body.branch);
      if (!branch) return fail(res, 400, "branch must be an active physical branch");
      values.branch = branch;
    }

    Object.assign(session, values);
    await session.save();

    /**
     * The denormalised copies on existing bookings are refreshed here.
     *
     * models/Booking.js copies `branch` and `sessionStart` so a roster reads
     * without a join and so branch scoping cannot be forgotten. That copy has to
     * be kept current when the class moves, or a rescheduled class's bookings
     * sort under the old time and a moved class's bookings stay visible to the
     * old branch. Not atomic with the save above and deliberately not made so:
     * the worst case is a stale sort key on a roster, which the next edit fixes.
     */
    if (values.branch !== undefined || values.start !== undefined) {
      await Booking.updateMany(
        { session: session._id },
        { $set: { branch: session.branch, sessionStart: session.start } },
      );
    }

    return ok(res, 200, "Class updated successfully", session);
  } catch (error) {
    console.error("Error updating class session:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — delete a class.
 *
 * REFUSED while anybody holds a place, unless `?force=true`. Deleting a session
 * out from under a booking leaves an orphan row pointing at nothing, and the
 * member who booked is told nothing at all. Switching `isActive` off is almost
 * always what was meant, so the error says so.
 *
 * DELETE /api/v1/classes/:id
 */
export const deleteSession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return fail(res, 400, "Invalid class id");
    }

    const session = await ClassSession.findOne({ _id: id, ...scopeFilter(req) });
    if (!session) return fail(res, 404, "Class not found");

    const activeBookings = await Booking.countDocuments({
      session: session._id,
      status: "BOOKED",
    });

    if (activeBookings > 0 && !toBool(req.query?.force, false)) {
      return fail(
        res,
        409,
        `${activeBookings} person(s) have booked this class. Switch it off ` +
          `(isActive: false) to hide it, or cancel the bookings first.`,
        { code: "HAS_BOOKINGS", bookings: activeBookings },
      );
    }

    // Bookings go with the session. Leaving them would leave rows whose
    // `session` resolves to nothing, which every roster query then has to
    // defend against forever.
    await Booking.deleteMany({ session: session._id });
    await ClassSession.deleteOne({ _id: session._id });

    return ok(res, 200, "Class deleted successfully", { id: session._id });
  } catch (error) {
    console.error("Error deleting class session:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — the roster: who is coming to one class.
 *
 * Scoped through the SESSION, not through the bookings: the session lookup
 * carries scopeFilter, so a Gotri admin asking for a Vasna roster gets a 404
 * before any booking is read.
 *
 * Cancelled rows are returned too, in their own bucket. "Six booked, two
 * cancelled" is what staff need to decide whether to open the slot back up;
 * hiding the cancellations makes a half-empty class look like nobody was ever
 * interested.
 *
 * GET /api/v1/classes/:id/roster
 */
export const getSessionRoster = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return fail(res, 400, "Invalid class id");
    }

    const session = await ClassSession.findOne({ _id: id, ...scopeFilter(req) })
      .populate("trainer", "fullName mobileNumber");
    if (!session) return fail(res, 404, "Class not found");

    const bookings = await Booking.find({ session: session._id })
      .populate("member", "fullName mobileNumber email branch endDate")
      .populate("lead", "name phone email status")
      .sort({ status: 1, createdAt: 1 })
      .lean();

    const byStatus = bookings.reduce((acc, b) => {
      acc[b.status] = (acc[b.status] || 0) + 1;
      return acc;
    }, {});

    return ok(res, 200, "Roster fetched successfully", {
      session,
      counts: {
        capacity: session.capacity,
        bookedCount: session.bookedCount,
        remainingCapacity: session.remainingCapacity,
        byStatus,
      },
      bookings,
    });
  } catch (error) {
    console.error("Error fetching class roster:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
