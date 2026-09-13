import mongoose from "mongoose";
import Attendance from "../../models/Attendance.js";
import { scopeFilter } from "../../middlewares/branchScope.js";
import { subjectFilter } from "./attendanceStaff.controller.js";

/**
 * The staff override of a refusal: "mark as allowed".
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL.
 * ============================================================================
 * Check-in is unattended (plan.md D2). A member whose record says expired, or
 * who has a stale balance on a membership they actually settled last week, taps
 * the sticker and is told on their own phone that their membership has lapsed —
 * with nobody standing there to say "that's wrong, come in". They go to
 * reception, reception takes the payment or fixes the record, and until now the
 * refusal simply stood in the attendance history with nothing pointing at its
 * resolution. That is the gap this closes.
 *
 * ============================================================================
 * THIS IS THE ONLY WRITE ON THE STAFF SIDE OF ATTENDANCE, WHICH IS WHY IT IS
 * IN ITS OWN FILE.
 * ============================================================================
 * attendanceStaff.controller.js opens by promising "Nothing here writes", and
 * that promise is worth more than the two saved imports — a reader who has to
 * ask "does this reporting file also mutate rows?" has already lost time.
 *
 * ============================================================================
 * WHAT IT MEANS FOR THE SESSION, AND WHY.
 * ============================================================================
 * An override is not a check-in performed by staff; the member checked in
 * themselves and was refused. So the row is not recreated, it is UPGRADED — the
 * same upgrade attendanceScan.controller.js already performs when a denied
 * member settles up and re-scans (its `wasDenied && !denied` branch). Both
 * doors have to write the same shape of row or footfall collected through one
 * cannot be compared with footfall collected through the other.
 *
 * With one qualification, on the date:
 *
 *   - A refusal FROM TODAY becomes a LIVE SESSION. The member is standing at
 *     reception right now, which is the only reason anybody is pressing this
 *     button; checkInAt is re-stamped to now and checkOutAt cleared, exactly as
 *     the re-scan path does. They appear on the floor in the live feed and the
 *     normal auto-close applies.
 *
 *   - An OLDER refusal only has the refusal cleared. The row keeps its original
 *     checkInAt, its original `date`, and its closed checkOutAt. Opening a
 *     session dated last Tuesday and stamped "now" would put checkInAt and
 *     `date` in different days — `date` is the normalised midnight of
 *     checkInAt and every calendar and footfall query depends on that holding —
 *     and it would claim somebody is on the floor because a clerk tidied up an
 *     old row.
 *
 * The response says which happened, in `sessionOpened`, rather than leaving the
 * caller to infer it from a date.
 *
 * WHAT DOES MOVE, STATED PLAINLY: an overridden row stops being a refusal, so
 * it starts counting as one check-in in footfall and in the exports for its own
 * day. That is the point — it was a real visit that had been recorded as a
 * refusal. It moves by exactly one row, once, and never again however many
 * times this endpoint is called (see the idempotency branch below).
 *
 * ============================================================================
 * THE AUDIT ROW IS WRITTEN BY THE GLOBAL PLUGIN, NOT BY THIS FILE.
 * ============================================================================
 * `row.save()` below goes through the save hooks that services/auditLog.js
 * installs on every schema, which read the actor out of AsyncLocalStorage
 * (middlewares/requestContext.js) and write an `AuditLog` UPDATE row naming the
 * staff member, the fields that changed and the before/after values. There is
 * deliberately no hand-written audit call here: a call site can be forgotten by
 * the next person to touch this file, a hook cannot.
 *
 * That is a claim, not an assumption — scripts/tests/attendanceOverride.test.mjs
 * pulls the real hooks off the real Attendance schema and asserts the row comes
 * out with `action: "UPDATE"`, `collectionName: "Attendance"` and both
 * `deniedReason` and `denialOverride` in changedFields.
 */

/** Midnight local — Attendance.date is stored normalised the same way. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Reception's note is a memo, not a document. Long enough for a receipt no. */
const MAX_NOTE = 300;

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ isOk: false, status, message, ...extra });

/**
 * The payload shape both the success and the already-done paths return, so a
 * caller never has to branch on which one it got.
 */
const overrideView = (row) => ({
  _id: row._id,
  subjectType: row.subjectType || "MEMBER",
  branch: row.branch,
  date: row.date,
  checkInAt: row.checkInAt,
  checkOutAt: row.checkOutAt,
  deniedReason: row.deniedReason,
  denialOverride: row.denialOverride || null,
  sessionOpened: Boolean(row.denialOverride?.sessionOpened),
});

/**
 * POST /api/v1/attendance/:id/mark-allowed
 *
 * Body: { note?: string }
 * Query: { subjectType?: "MEMBER" | "TRAINER" | "ALL" }  (default MEMBER)
 *
 * Converts one denied attendance row into an allowed one.
 */
export const markAttendanceAllowed = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "A valid attendance id is required");
    }

    const rawNote = req.body?.note;
    if (rawNote !== undefined && typeof rawNote !== "string") {
      return fail(res, 400, "note must be text");
    }
    const note = String(rawNote || "").trim().slice(0, MAX_NOTE);

    /**
     * BRANCH SCOPING. `scopeFilter(req)` reads req.session.user — never
     * req.user, which authMiddleware builds from four fields and which carries
     * no branch at all, so scope code written against it reads "unrestricted"
     * for every branch admin (middlewares/branchScope.js). Spread LAST so it
     * beats anything else in this object.
     *
     * It is applied to the LOOKUP rather than checked after loading the row:
     * a Gotri admin must not be able to confirm that a given Vasna attendance
     * id exists, and the difference between "no such row" and "not yours" is
     * exactly that confirmation. Both come back as the same 404.
     *
     * SUBJECT SCOPING is here too, even though `_id` is unique and nothing can
     * be over-counted by a single-document lookup. The house rule for this
     * collection has no silent exceptions (models/Attendance.js) — a query with
     * no subjectType is the thing a future reader must never find in this file
     * and copy. A trainer's refused shift is reachable with
     * `?subjectType=TRAINER`, deliberately by name.
     */
    const filter = {
      _id: id,
      ...subjectFilter(req),
      ...scopeFilter(req),
    };

    // A document, not .lean(): the save hooks are what write the audit row.
    const row = await Attendance.findOne(filter);
    if (!row) {
      return fail(res, 404, "Attendance record not found");
    }

    /**
     * IDEMPOTENCY. Two people at the desk, or one double-click, must not open
     * two sessions or count the visit twice.
     *
     * The check is "is it still a refusal", not "have I seen this before":
     * deniedReason is already null on an overridden row, so the second call
     * finds nothing to do, writes nothing, and therefore produces no second
     * audit row either. It returns 200 with the same body as the first call
     * plus `alreadyOverridden`, because from the caller's point of view the
     * thing they asked for is true.
     */
    if (!row.deniedReason) {
      if (row.denialOverride) {
        return res.status(200).json({
          isOk: true,
          status: 200,
          message: "This refusal has already been overridden",
          data: { ...overrideView(row), alreadyOverridden: true },
        });
      }

      /**
       * Never a refusal in the first place. A 409 rather than a 200: silently
       * accepting it would let a mis-wired screen "override" ordinary
       * check-ins, and each one would re-stamp a real session's start time.
       */
      return fail(
        res,
        409,
        "This check-in was not refused, so there is nothing to override",
      );
    }

    const now = new Date();
    const originalReason = row.deniedReason;
    const deniedAt = row.checkInAt;

    /**
     * Today's refusal or an older one — see the file header. `date` is the
     * normalised midnight, so this is an exact comparison and not a window.
     */
    const rowDay = startOfDay(row.date || row.checkInAt);
    const today = startOfDay(now);
    const sessionOpened = Boolean(
      rowDay && today && rowDay.getTime() === today.getTime(),
    );

    const actor = req.session?.user || {};

    /**
     * Clear the refusal and move it into denialOverride in the same save. The
     * evidence is not deleted, it is relocated — "was denied for EXPIRED,
     * overridden by Gotri Manager at 07:12" — while every existing
     * `deniedReason: null` query keeps working with no change at all. See
     * models/Attendance.js for why that trade is the right way round.
     */
    row.deniedReason = null;
    row.denialOverride = {
      originalReason,
      deniedAt,
      // Copied, never referenced: this has to still read correctly after the
      // employee is renamed, moved branch or deleted, which is precisely when
      // somebody goes looking.
      actorId: String(actor.id || ""),
      actorName: String(actor.name || ""),
      actorRole: String(actor.role || ""),
      overriddenAt: now,
      note,
      sessionOpened,
    };

    if (sessionOpened) {
      // The same re-stamp attendanceScan.controller.js performs on the
      // equivalent re-scan: the real session starts now, not at the refusal.
      row.checkInAt = now;
      row.checkOutAt = null;
      row.autoClosed = false;
    }
    // Otherwise checkInAt, date and checkOutAt are left exactly as they were.
    // A denied row is written closed (checkOutAt === checkInAt), so it stays a
    // recorded arrival rather than becoming an open session dated last week.

    await row.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: sessionOpened
        ? "Marked as allowed. A session is now open for this member."
        : "Marked as allowed. The refusal is cleared; no new session was opened because it was not from today.",
      data: {
        ...overrideView(row),
        alreadyOverridden: false,
        // Spelled out rather than left to be inferred from the dates.
        sessionOpened,
        effect: sessionOpened
          ? "The refusal is resolved and the member is now shown as in the gym."
          : "The refusal is resolved. The visit stays recorded on its original day and no session was opened.",
      },
    });
  } catch (error) {
    console.error("Error overriding attendance denial:", error);
    return fail(res, 500, "Internal server error");
  }
};

export default markAttendanceAllowed;
