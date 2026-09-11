import mongoose from "mongoose";

/**
 * One gym visit by one member.
 *
 * WHY A ROW PER SESSION RATHER THAN A COUNTER ON Member:
 * a counter answers "how many times has he trained" and nothing else. The
 * portal asks harder questions — streaks, this month's minutes, "did I train on
 * the 5th" — and every one of those needs the individual visits kept.
 *
 * Rows are OWNED BY THE MEMBER: memberId always comes from the verified JWT,
 * never from the request, so nobody can check in as somebody else.
 */
const AttendanceSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
      index: true,
    },

    checkInAt: {
      type: Date,
      required: true,
    },

    /** Null while the member is still inside. */
    checkOutAt: {
      type: Date,
      default: null,
    },

    /**
     * True when the SERVER closed the session, not the member.
     *
     * Worth recording separately: a run of auto-closed sessions means the
     * check-out button isn't being found, which is a UI problem, not a member
     * problem. Collapsing both into "checked out" would hide that entirely.
     */
    autoClosed: {
      type: Boolean,
      default: false,
    },

    /**
     * Denormalised from the member at check-in — deliberately a copy, not a
     * lookup through memberId.
     *
     * A member who transfers from Vasna to Gotri must not retroactively move
     * every past visit with them. Vasna's footfall for last March happened at
     * Vasna, and a join against the member's CURRENT branch would silently
     * rewrite that history.
     */
    branch: {
      type: String,
      enum: ["Vasna", "Gotri"],
      required: true,
    },

    /**
     * The check-in DAY, normalised to midnight.
     *
     * Stored alongside checkInAt rather than derived from it so "did I train on
     * the 5th" is one indexed equality match, instead of a $gte/$lt range scan
     * built per day — which is what the calendar view would otherwise need for
     * all thirty-odd days it renders at once.
     */
    date: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

/**
 * One session per member per day.
 *
 * A second tap of check-in on the same day is a mistake or a double-tap, not a
 * second workout: the handler resumes/reopens the existing row rather than
 * creating a duplicate. The index guarantees that even if a future caller
 * forgets to check first — and it's what makes the streak maths trustworthy,
 * since a day can never contribute two entries.
 */
AttendanceSchema.index({ memberId: 1, date: 1 }, { unique: true });

/** The recent-activity list reads newest-first for one member. */
AttendanceSchema.index({ memberId: 1, checkInAt: -1 });

export default mongoose.model("Attendance", AttendanceSchema);
