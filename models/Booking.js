import mongoose from "mongoose";
import { BOOKING_STATUSES } from "./ClassSession.js";

export { BOOKING_STATUSES };

/** Where the booking came in from. Not security-relevant; it is for the roster. */
export const BOOKING_SOURCES = ["WEBSITE", "PORTAL", "ADMIN"];

/**
 * One person's place in one ClassSession.
 *
 * ============================================================================
 * A BOOKING BELONGS TO A MEMBER **OR** A LEAD — EXACTLY ONE, NEVER BOTH.
 * ============================================================================
 * The free trial is the reason. A prospect who has never walked in has no
 * Member row and must not be given one: models/Lead.js explains at length why a
 * half-populated Member poisons every member count, every renewal report and
 * every attendance denominator in the system. So a prospect books as a `lead`,
 * and if they later join, the Lead converts and their history is still here.
 *
 * Enforced by a pre-validate hook below rather than by two `required` flags,
 * because "exactly one of these two" is not something a Mongoose field-level
 * validator can express.
 *
 * ============================================================================
 * WHY name / phone / email ARE COPIED ONTO THE ROW
 * ============================================================================
 * Not laziness about populate(). The roster is read at the door, on a phone,
 * sometimes months after the class — and a Lead can be deleted, a Member's
 * mobile can change when they update their profile. The copy records who
 * booked, as they identified themselves at the time. The reference records who
 * they are now. Both questions are real and they have different answers.
 *
 * ============================================================================
 * BRANCH IS COPIED FROM THE SESSION, ON PURPOSE
 * ============================================================================
 * Denormalised so that every admin query over bookings can spread
 * scopeFilter(req) LAST without a $lookup. The alternative — resolving the
 * branch through `session` on every read — means branch scoping depends on a
 * join, and a join that is forgotten once silently returns the other branch's
 * roster. A copied string cannot be forgotten. It is set by the server from the
 * looked-up ClassSession and is never read from the request body.
 */
const BookingSchema = new mongoose.Schema(
  {
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClassSession",
      required: true,
    },

    /** Set for a member booking; null for a prospect. */
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },

    /** Set for a prospect booking a free trial; null for a member. */
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    /** Identity as given at booking time — see the header note. */
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: "" },

    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: "BOOKED",
    },

    source: {
      type: String,
      enum: BOOKING_SOURCES,
      default: "WEBSITE",
    },

    /** Copied from ClassSession.branch. The scoping key — see the header. */
    branch: { type: String, required: true, trim: true },

    /** Copied from ClassSession.start, so a roster sorts without a join. */
    sessionStart: { type: Date, required: true },

    cancelledAt: { type: Date, default: null },

    /**
     * Free text, staff- or member-supplied. Kept because "cancelled, ill" and
     * "cancelled, class moved" are different facts to whoever reads the roster.
     */
    cancelReason: { type: String, trim: true, default: "" },

    /** Set when a staff member marks the row ATTENDED or NO_SHOW. */
    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    markedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * Exactly one subject. See the header for why this is not two `required` flags.
 *
 * A `pre("validate")` hook rather than `pre("save")` so the failure surfaces as
 * a normal ValidationError alongside every other field problem, and so it also
 * fires for `Model.create()`.
 */
BookingSchema.pre("validate", function (next) {
  const hasMember = Boolean(this.member);
  const hasLead = Boolean(this.lead);
  if (hasMember === hasLead) {
    return next(
      new Error(
        "A booking must reference exactly one of `member` or `lead` — " +
          (hasMember ? "both were set" : "neither was set"),
      ),
    );
  }
  return next();
});

/**
 * ============================================================================
 * THE SECOND HALF OF THE OVERSELL DEFENCE — AND THE WHOLE OF THE DOUBLE-BOOK
 * DEFENCE.
 * ============================================================================
 * services/bookingCapacity.js stops a class going past its capacity. These two
 * indexes stop ONE PERSON taking two of the seats, which a capacity counter
 * cannot see: two simultaneous submissions of the same form are two legitimate
 * reservations as far as the counter is concerned.
 *
 * A unique index is the right tool because it is the only check that is
 * evaluated by the server at write time. A `findOne` before the insert is a
 * read-then-write and loses the race exactly the way a capacity read would; the
 * controller does that lookup anyway, but only as a fast path for the common
 * (uncontended) case — the index is what actually guarantees it.
 *
 * PARTIAL, because `member` is null on every lead booking and `lead` is null on
 * every member booking. A plain unique index treats null as a value, so the
 * SECOND lead booking for any session would collide with the first on
 * `{ session, member: null }` — the same trap models/Member.js documents for
 * `loginId` and Transaction.receiptNo fell into.
 *
 * CONSEQUENCE, and it is handled in the controller rather than worked around
 * here: the constraint covers CANCELLED rows too, so a member who books,
 * cancels and rebooks would hit a duplicate key. The booking controller
 * therefore REVIVES a cancelled row instead of inserting a second one. That is
 * the better behaviour anyway — one row per (person, class) is a history you
 * can read, whereas three rows for one seat is not.
 */
BookingSchema.index(
  { session: 1, member: 1 },
  {
    unique: true,
    partialFilterExpression: { member: { $type: "objectId" } },
    name: "uniq_session_member",
  },
);
BookingSchema.index(
  { session: 1, lead: 1 },
  {
    unique: true,
    partialFilterExpression: { lead: { $type: "objectId" } },
    name: "uniq_session_lead",
  },
);

/** The roster view: everyone on one session, active bookings first. */
BookingSchema.index({ session: 1, status: 1, createdAt: 1 });

/** The admin list: one branch's bookings, newest first. */
BookingSchema.index({ branch: 1, sessionStart: -1 });

/** "What has this member booked" — the portal's own list. */
BookingSchema.index({ member: 1, sessionStart: -1 });

export default mongoose.model("Booking", BookingSchema);
