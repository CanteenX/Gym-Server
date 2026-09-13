import mongoose from "mongoose";

/**
 * One scheduled class at one branch at one time — a Zumba slot on Tuesday at
 * 6 AM at Vasna, a free trial session on Saturday morning at Gotri.
 *
 * ============================================================================
 * WHY THIS IS NOT A SiteItem WITH collectionKey: "classes"
 * ============================================================================
 * models/SiteItem.js already carries a "classes" list, and that list is the
 * PRINTED TIMETABLE — free strings ("Mon — Sat", "6:00 AM") that the marketing
 * site renders verbatim. It has no instant in time, so it cannot be compared to
 * `now`, cannot be sorted into "upcoming", and cannot hold a booking count.
 *
 * A bookable session needs all three. `start` is a real Date because "is this
 * in the future" and "which slot did I book" are questions a string cannot
 * answer, and `bookedCount` needs a document of its own to be incremented
 * atomically against (see services/bookingCapacity.js). So the two coexist
 * deliberately: SiteItem "classes" is the brochure, ClassSession is the diary.
 *
 * ============================================================================
 * BRANCH IS A TENANCY BOUNDARY HERE, UNLIKE SiteItem.branch
 * ============================================================================
 * SiteItem.branch is a display tag on one public website. This one is real
 * scoping: a Gotri admin schedules Gotri classes and must not see, edit or
 * delete Vasna's diary. Every admin query against this collection therefore
 * spreads scopeFilter(req) LAST (middlewares/branchScope.js), and `branch` is
 * forced from the SESSION on create rather than taken from the body.
 *
 * A plain String, matching Member.branch / Trainer.branch / Employee.branch,
 * because branchScope compares it literally — see models/Branch.js for why
 * branches are data rather than an enum.
 */

/** Booking statuses, in the order a booking moves through them. */
export const BOOKING_STATUSES = ["BOOKED", "ATTENDED", "CANCELLED", "NO_SHOW"];

/** Hard ceilings. A typo in the capacity field must not become a 5,000-seat class. */
export const MAX_CAPACITY = 500;
export const MAX_DURATION_MINUTES = 480;

const ClassSessionSchema = new mongoose.Schema(
  {
    /** "Morning Zumba", "Free Trial — Strength Basics". Shown to the public. */
    title: { type: String, required: true, trim: true },

    /** Optional blurb rendered under the title on the booking form. */
    description: { type: String, trim: true, default: "" },

    /**
     * REQUIRED and session-derived. Nullable would mean "belongs to no branch",
     * which for a physical class is not a real state — somebody has to unlock a
     * door — and it would make every scoped query ambiguous. Validated against
     * the Branch master in the controller, not by an enum here.
     */
    branch: { type: String, required: true, trim: true },

    /**
     * Who runs it. Nullable because a class is often scheduled before the
     * trainer is assigned, and a slot with no trainer is still bookable.
     */
    trainer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trainer",
      default: null,
    },

    /** When it starts. The ONLY thing "upcoming" is computed from. */
    start: { type: Date, required: true },

    durationMinutes: {
      type: Number,
      default: 60,
      min: 5,
      max: MAX_DURATION_MINUTES,
    },

    /**
     * How many people may hold a BOOKED place. Minimum 1: a class with zero
     * seats is a class that should have been switched off with isActive.
     */
    capacity: { type: Number, required: true, min: 1, max: MAX_CAPACITY },

    /**
     * ========================================================================
     * THE COUNTER THE ATOMIC CAPACITY CHECK INCREMENTS. DO NOT SET IT DIRECTLY.
     * ========================================================================
     * It is maintained ONLY by services/bookingCapacity.js, through conditional
     * `findOneAndUpdate` operations that compare it against `capacity` inside
     * the same round trip. Any code that reads it, adds one and saves has
     * reintroduced exactly the race this field exists to prevent: two people
     * booking the last seat both read 49, both write 50, and the class is
     * oversold with nothing anywhere logging a problem.
     *
     * It is therefore a CACHE of "how many BOOKED rows point at this session",
     * and the Booking collection remains the source of truth. If the two ever
     * disagree (a crash between the reservation and the insert, and the
     * compensating release also failing) the error is in the SAFE direction —
     * the counter is too high, so the class under-fills rather than oversells.
     * A reconciliation pass could recompute it from Booking at any time; there
     * is deliberately none wired up, because a reconciler that runs while
     * bookings are being taken would itself have to be atomic.
     *
     * `min: 0` is a schema-level backstop for the release path. The release
     * update also guards on `bookedCount > 0` in its filter, so this should be
     * unreachable — it is here so that if it ever is reached, the write fails
     * loudly instead of storing -1.
     */
    bookedCount: { type: Number, default: 0, min: 0 },

    /**
     * May a prospect with no account book this — the free-trial case.
     *
     * Default true because that is the whole point of publishing a class on the
     * marketing site. Set false for a members-only session; the public booking
     * endpoint then refuses and the portal endpoint still works.
     */
    allowGuests: { type: Boolean, default: true },

    /** Hides the session from the public list without deleting its bookings. */
    isActive: { type: Boolean, default: true },

    /** Internal note for staff. Never returned by the public read. */
    notes: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
    // Virtuals must survive .lean()-less serialisation to the admin panel and
    // the public list, both of which render remainingCapacity.
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * Seats still available, floored at 0.
 *
 * Floored rather than allowed to go negative because a negative number on a
 * booking form reads as a bug to a visitor even when it is the honest value.
 * If bookedCount ever exceeds capacity the class is full, which is the correct
 * user-facing answer either way.
 */
ClassSessionSchema.virtual("remainingCapacity").get(function () {
  return Math.max(0, (this.capacity || 0) - (this.bookedCount || 0));
});

ClassSessionSchema.virtual("isFull").get(function () {
  return (this.bookedCount || 0) >= (this.capacity || 0);
});

ClassSessionSchema.virtual("endsAt").get(function () {
  if (!this.start) return null;
  return new Date(this.start.getTime() + (this.durationMinutes || 0) * 60000);
});

/**
 * The two queries this collection actually serves.
 *
 * The public list is "active sessions at branch X starting after now, in time
 * order" — branch first because it is the equality predicate and `start` is the
 * range one, which is the order a compound index wants.
 *
 * The admin list is the same query without isActive and often without a branch
 * (a super admin), which the second index covers.
 */
ClassSessionSchema.index({ branch: 1, start: 1, isActive: 1 });
ClassSessionSchema.index({ start: 1 });

export default mongoose.model("ClassSession", ClassSessionSchema);
