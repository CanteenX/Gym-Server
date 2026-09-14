import mongoose from "mongoose";

/**
 * Holiday Master — a day (or run of days) the gym is CLOSED.
 *
 * ============================================================================
 * DATE STORAGE: LOCAL MIDNIGHT, THE SAME CONVENTION Attendance.date AND
 * BodyMetric.recordedOn ALREADY USE. DO NOT STORE A RAW TIMESTAMP HERE.
 * ============================================================================
 * A holiday is a CALENDAR DAY, not an instant. The gym is in Vadodara
 * (IST, UTC+5:30). `controllers/v1/attendance.controller.js` and
 * `controllers/v1/bodyMetrics.controller.js` both normalise with
 * `d.setHours(0, 0, 0, 0)` on the server's own local clock — never
 * `setUTCHours` — precisely so a day belongs to itself rather than sliding to
 * the previous day the moment it is rendered in IST. `services/holidayDate.js`
 * is the SAME function, reused rather than reinvented, and every controller
 * here writes `date`/`endDate` through it. See that file's header for the
 * boundary case this is protecting against and the assumption it rests on
 * (the Node process itself running in IST, exactly as Attendance already
 * assumes).
 *
 * `endDate: null` is a single-day holiday. `endDate` set is an INCLUSIVE
 * range — a 3-day Diwali closure is one row, not three.
 */
const HolidaySchema = new mongoose.Schema(
  {
    /** e.g. "Ganesh Chaturthi". */
    title: {
      type: String,
      required: true,
      trim: true,
    },

    /** The day itself (or the first day of a range), normalised to local midnight. */
    date: {
      type: Date,
      required: true,
      index: true,
    },

    /**
     * Null for a single-day holiday. Set for an inclusive range — the last day
     * the gym is still closed, also normalised to local midnight.
     */
    endDate: {
      type: Date,
      default: null,
    },

    /** Optional detail shown on hover/detail — "Half day", "Confirm with front desk", etc. */
    note: {
      type: String,
      trim: true,
      default: "",
    },

    /**
     * `null` = ALL branches — the same sentinel `Employee.branch` and every
     * other branch-bearing model in this codebase already uses (see
     * middlewares/branchScope.js). A gym-wide closure (a national holiday, a
     * festival both branches observe) is the common case, so this is the
     * default rather than something an admin has to opt into per branch.
     *
     * Stored as a plain string, matching Member/Trainer/Transaction/Attendance
     * — see models/Branch.js for why the master is not a foreign key here.
     */
    branch: {
      type: String,
      default: null,
      index: true,
    },

    /**
     * Soft-disable rather than delete: a holiday that turns out to be wrong
     * (or is cancelled) stays in the audit trail instead of vanishing, matching
     * the deactivate-don't-delete convention Branch and every master here uses.
     */
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

/**
 * Every read here asks "what closes this branch in this window" — branch is
 * the equality match, date the range — so branch leads, matching the compound
 * index order Attendance uses for the same shape of question.
 */
HolidaySchema.index({ branch: 1, date: 1 });

export default mongoose.model("Holiday", HolidaySchema);
