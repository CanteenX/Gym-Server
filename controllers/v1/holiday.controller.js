import mongoose from "mongoose";
import Holiday from "../../models/Holiday.js";
import Branch from "../../models/Branch.js";
import Member from "../../models/Member.js";
import { scopeFilter, scopedBranch } from "../../middlewares/branchScope.js";
import { holidayReadFilter, holidayWriteBranch } from "../../services/holidayScope.js";
import {
  startOfDay,
  addDays,
  holidayCoversDay,
  overlapFilter,
  monthRange,
} from "../../services/holidayDate.js";

/**
 * Holiday Master — gym closure days.
 *
 * Three audiences, one collection, same split classes.routes.js and
 * attendance.routes.js already use:
 *
 *   ADMIN (session)      the Holiday Master screen — list, calendar, CRUD.
 *   MEMBER PORTAL (JWT)  read-only "closed today / closed this week" widget.
 *
 * BRANCH SCOPING throughout reads req.session.user via
 * middlewares/branchScope.js and services/holidayScope.js — NEVER req.user,
 * which carries no branch (see the header of middlewares/branchScope.js).
 *
 * DATES are normalised through services/holidayDate.js's startOfDay(), the
 * same local-midnight convention Attendance and BodyMetric already use — see
 * that file's header for the IST reasoning.
 */

// Same helper as every other list controller here (classSession.controller.js,
// etc.): a user-supplied `match` becomes part of a $regex, so its
// metacharacters must be neutralised or a search for "(" is a crash.
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ isOk: false, status, message, ...extra });

const toBool = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || v === "true" || v === "1" || v === 1;
};

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * `null` passes straight through — that IS "all branches" and needs no
 * Branch-master lookup. A non-null name must resolve to an ACTIVE PHYSICAL
 * branch, same rule classSession.controller.js's resolvePhysicalBranch()
 * applies: "Common" is a bookkeeping bucket, not a floor that can be shut.
 *
 * @param {string|null} name
 * @returns {Promise<string|null|undefined>} the canonical name, null (passed
 *   through), or undefined when `name` was given but does not resolve
 */
const resolveHolidayBranch = async (name) => {
  if (name === null) return null;
  const branch = await Branch.findOne({
    name,
    isActive: true,
    isPhysical: true,
  })
    .select("name")
    .lean();
  return branch?.name || undefined;
};

/**
 * Validates and normalises the writable fields shared by create and update.
 * Returns `{ error }` rather than throwing, matching classSession.controller.js.
 *
 * @param {object} body
 * @param {object} [existing] the current document, for an update
 * @returns {{values?: object, error?: string}}
 */
const buildHolidayValues = (body, existing = null) => {
  const values = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { error: "title is required" };
    values.title = title.slice(0, 200);
  } else if (!existing) {
    return { error: "title is required" };
  }

  if (body.date !== undefined) {
    const date = startOfDay(body.date);
    if (!date) return { error: "date must be a valid date" };
    values.date = date;
  } else if (!existing) {
    return { error: "date is required" };
  }

  if (body.endDate !== undefined) {
    if (body.endDate === null || body.endDate === "") {
      values.endDate = null;
    } else {
      const endDate = startOfDay(body.endDate);
      if (!endDate) return { error: "endDate must be a valid date" };
      const startRef = values.date || existing?.date;
      if (startRef && endDate.getTime() < startOfDay(startRef).getTime()) {
        return { error: "endDate cannot be before date" };
      }
      values.endDate = endDate;
    }
  }

  if (body.note !== undefined) {
    values.note = String(body.note ?? "").trim().slice(0, 1000);
  }

  if (body.isActive !== undefined) {
    values.isActive = toBool(body.isActive, true);
  }

  return { values };
};

/**
 * ADMIN — paged list, house `…-by-params` convention.
 *
 * BRANCH SCOPING: holidayReadFilter() — a branch admin sees their own
 * branch's holidays AND the all-branches ones; a super admin sees whatever
 * `branch` in the body asks for, or everything.
 *
 * `from`/`to` filter by OVERLAP with the window, not by the start date alone
 * — a multi-day closure that started before `from` and is still running is
 * still found (services/holidayDate.js's overlapFilter()).
 *
 * POST /api/v1/holidays-by-params
 */
export const listHolidaysByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, from, to, branch, isActive } =
      req.body || {};

    const safeSkip = Math.max(0, toInt(skip, 0));
    const safePerPage = Math.min(Math.max(toInt(per_page, 20), 1), 200);

    const conditions = [];

    if (isActive !== undefined && isActive !== "") {
      conditions.push({ isActive: toBool(isActive, true) });
    }

    // startOfDay() treats a falsy input as "now" (it is built for a REQUIRED
    // date field, matching Attendance's own startOfDay) — so it must only be
    // called when `from`/`to` were actually supplied, or a plain "list
    // everything" call would silently gain a "from today" filter nobody asked
    // for.
    const fromDate = from ? startOfDay(from) : null;
    const toDateVal = to ? startOfDay(to) : null;
    if (fromDate && toDateVal) {
      conditions.push(overlapFilter(fromDate, toDateVal));
    } else if (fromDate) {
      conditions.push({
        $or: [
          { endDate: null, date: { $gte: fromDate } },
          { endDate: { $gte: fromDate } },
        ],
      });
    } else if (toDateVal) {
      conditions.push({ date: { $lte: toDateVal } });
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      conditions.push({
        $or: [
          { title: { $regex: escaped, $options: "i" } },
          { note: { $regex: escaped, $options: "i" } },
        ],
      });
    }

    // Applied LAST so it is authoritative over anything above.
    const effectiveBranch = holidayReadFilter(req, branch);
    if (Object.keys(effectiveBranch).length) conditions.push(effectiveBranch);

    // Every condition above is its own object (some carrying their own $or),
    // so they are combined with $and rather than Object.assign()d together —
    // a plain merge would let a later $or silently clobber an earlier one.
    const matchCondition =
      conditions.length === 0
        ? {}
        : conditions.length === 1
          ? conditions[0]
          : { $and: conditions };

    const allowed = ["date", "title", "branch", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "date";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await Holiday.countDocuments(matchCondition);
    const data = await Holiday.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing holidays:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — one month's holidays, for the calendar widget (and the employee
 * dashboard calendar, behind the same read permission).
 *
 * GET /api/v1/holidays/calendar?year=2026&month=9
 */
export const getHolidayCalendar = async (req, res) => {
  try {
    const { year, month, branch } = req.query || {};
    const range = monthRange(year, month);
    if (!range) {
      return fail(res, 400, "year and month are required (month 1-12)");
    }

    const conditions = [overlapFilter(range.from, range.to), { isActive: true }];
    const effectiveBranch = holidayReadFilter(req, branch);
    if (Object.keys(effectiveBranch).length) conditions.push(effectiveBranch);

    const matchCondition = { $and: conditions };

    const holidays = await Holiday.find(matchCondition).sort({ date: 1 }).lean();

    return ok(res, 200, "Holiday calendar fetched successfully", {
      year: Number(year),
      month: Number(month),
      from: range.from,
      to: range.to,
      holidays,
    });
  } catch (error) {
    console.error("Error fetching holiday calendar:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — mark a new closure.
 *
 * BRANCH COMES FROM THE SESSION for a branch admin (holidayWriteBranch()),
 * never the body — a Gotri admin posting `branch: "Vasna"` (or `branch:
 * null`, an attempt to widen to "all branches") gets a Gotri holiday, same
 * reasoning createSession() applies in classSession.controller.js.
 *
 * POST /api/v1/holidays
 */
export const createHoliday = async (req, res) => {
  try {
    // Cheap, synchronous validation FIRST — fail fast on bad input before
    // spending a database round-trip resolving the branch.
    const { values, error } = buildHolidayValues(req.body || {});
    if (error) return fail(res, 400, error);

    const branchDecision = holidayWriteBranch(req, req.body?.branch);
    if (!branchDecision.ok) return fail(res, 400, branchDecision.error);

    const resolvedBranch = await resolveHolidayBranch(branchDecision.branch);
    if (resolvedBranch === undefined) {
      return fail(
        res,
        400,
        `'${branchDecision.branch}' is not an active physical branch`,
      );
    }

    const holiday = await Holiday.create({ ...values, branch: resolvedBranch });

    return ok(res, 201, "Holiday created successfully", holiday);
  } catch (error) {
    console.error("Error creating holiday:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — edit a closure.
 *
 * THE LOOKUP USES scopeFilter(req), NOT holidayReadFilter(). This is the line
 * the owner drew explicitly: a branch admin may VIEW an all-branches holiday
 * but may not EDIT or DELETE one, and may never touch the other branch's.
 * scopeFilter() narrows to exactly the admin's own branch (`{}` for a super
 * admin), so a lookup for a `branch: null` or other-branch document simply
 * finds nothing and this returns 404 — never a silent cross-branch write.
 *
 * PUT /api/v1/holidays/:id
 */
export const updateHoliday = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return fail(res, 400, "Invalid holiday id");
    }

    const holiday = await Holiday.findOne({ _id: id, ...scopeFilter(req) });
    if (!holiday) return fail(res, 404, "Holiday not found");

    const { values, error } = buildHolidayValues(req.body || {}, holiday);
    if (error) return fail(res, 400, error);

    // Only a super admin may move a holiday between branches, or to/from "all
    // branches". scopedBranch() is null only for them.
    if (req.body?.branch !== undefined && !scopedBranch(req)) {
      const branchDecision = holidayWriteBranch(req, req.body.branch);
      if (!branchDecision.ok) return fail(res, 400, branchDecision.error);

      const resolvedBranch = await resolveHolidayBranch(branchDecision.branch);
      if (resolvedBranch === undefined) {
        return fail(
          res,
          400,
          `'${branchDecision.branch}' is not an active physical branch`,
        );
      }
      values.branch = resolvedBranch;
    }

    Object.assign(holiday, values);
    await holiday.save();

    return ok(res, 200, "Holiday updated successfully", holiday);
  } catch (error) {
    console.error("Error updating holiday:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — remove a closure.
 *
 * Same scopeFilter(req) lookup as updateHoliday(), for the same reason: a
 * branch admin may delete their own branch's holidays and nothing else.
 *
 * DELETE /api/v1/holidays/:id
 */
export const deleteHoliday = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return fail(res, 400, "Invalid holiday id");
    }

    const holiday = await Holiday.findOneAndDelete({ _id: id, ...scopeFilter(req) });
    if (!holiday) return fail(res, 404, "Holiday not found");

    return ok(res, 200, "Holiday deleted successfully", { id: holiday._id });
  } catch (error) {
    console.error("Error deleting holiday:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * MEMBER PORTAL — "closed today" / "closed this week", read-only.
 *
 * ============================================================================
 * IDENTITY AND BRANCH COME ONLY FROM THE VERIFIED TOKEN.
 * ============================================================================
 * req.member.id is set by requireMember from the JWT claim, and the member's
 * branch is then read off THEIR OWN Member row. Nothing in req.query can name
 * a different member or a different branch — there is no memberId or branch
 * parameter read anywhere in this handler, on purpose, matching every other
 * member-portal handler in this codebase (bodyMetrics.controller.js,
 * attendance.controller.js). A member who edits the querystring changes
 * nothing about which holidays come back.
 *
 * WINDOW: today PLUS the next 7 days, inclusive of today, i.e.
 * [today, today+7]. `overlapFilter` — the same helper the admin calendar uses
 * — finds a multi-day closure that started before today and is still
 * running, not just one whose START falls in the window.
 *
 * `isToday` is computed per holiday with holidayCoversDay() rather than a
 * plain `date === today` equality, for the same multi-day reason: a 3-day
 * closure that started yesterday must show as "closed today", not only on the
 * day it started.
 *
 * GET /api/v1/member-portal/holidays/upcoming
 */
export const getUpcomingHolidaysForMember = async (req, res) => {
  try {
    const member = await Member.findById(req.member.id).select("branch").lean();
    if (!member) return fail(res, 404, "Member not found");

    const today = startOfDay();
    const windowEnd = addDays(today, 7);

    const matchCondition = {
      $and: [
        overlapFilter(today, windowEnd),
        { isActive: true },
        // Own branch + the all-branches ones — same view rule staff get.
        { branch: { $in: [member.branch, null] } },
      ],
    };

    const holidays = await Holiday.find(matchCondition).sort({ date: 1 }).lean();

    return ok(res, 200, "Upcoming holidays fetched successfully", {
      today,
      windowEnd,
      holidays: holidays.map((h) => ({
        _id: h._id,
        title: h.title,
        date: h.date,
        endDate: h.endDate,
        note: h.note,
        branch: h.branch,
        isToday: holidayCoversDay(h, today),
      })),
    });
  } catch (error) {
    console.error("Error fetching upcoming holidays:", error);
    return fail(res, 500, "Internal server error");
  }
};
