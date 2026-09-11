import mongoose from "mongoose";

/**
 * What a member actually did for one exercise on one day.
 *
 * WHY exerciseName IS DENORMALISED RATHER THAN AN EXERCISE ID:
 * a log is a historical record of what the member lifted. If this referenced a
 * subdocument id in WorkoutPlan, then an admin renaming "Incline DB Press" or
 * deleting it from the plan would retroactively rename or blank out every past
 * log that pointed at it — rewriting history the member can see. Copying the
 * name at log time means the record still reads correctly years later, however
 * much the plan has since been edited.
 */
const EntrySchema = new mongoose.Schema(
  {
    exerciseName: {
      type: String,
      required: true,
      trim: true,
    },
    done: {
      type: Boolean,
      default: false,
    },
    /**
     * ONE weight for the whole exercise, not per set.
     *
     * Null until the member enters something — distinct from 0, which would
     * claim they lifted an empty bar.
     */
    weightKg: {
      type: Number,
      default: null,
    },
    /**
     * Which split day THIS exercise came from.
     *
     * A real session is not always one day of the split: a member doing two leg
     * exercises and two shoulder exercises is logging one session spanning Day 3
     * and Day 4. The document-level dayNumber can only name one of them, so the
     * attribution has to live per entry.
     *
     * BACKWARD COMPATIBILITY — THIS IS THE MIGRATION STRATEGY, AND THERE IS NO
     * MIGRATION SCRIPT: every entry written before this field existed has no
     * dayNumber, and null therefore MEANS "came from the document-level
     * dayNumber". Readers must apply that fallback rather than treating null as
     * unknown, which is what lets old single-day logs keep reading exactly as
     * they did without anyone rewriting stored documents.
     */
    dayNumber: {
      type: Number,
      default: null,
    },
    /**
     * The day's label copied at log time, e.g. "Legs".
     *
     * Copied for the SAME reason exerciseName is copied (see above): if an admin
     * later renames "Legs" to "Lower Body", or deletes the day from the plan, a
     * past log must still read as it did on the day it was written. Resolving
     * the label against the current plan instead would retroactively relabel
     * history the member can see.
     */
    dayLabel: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

/**
 * One member's logged workout session for one day.
 *
 * Entries are OWNED BY THE MEMBER: memberId always comes from the verified JWT,
 * never from the request body, so nobody can write into another member's log.
 */
const WorkoutLogSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
      index: true,
    },

    /**
     * The training DAY, normalised to local midnight.
     *
     * Normalised rather than stored as an instant so "what did I do today" is
     * one indexed equality match, and so the per-day unique index below can
     * work at all.
     */
    date: {
      type: Date,
      required: true,
    },

    /**
     * Which plan this session came from, kept for context on old logs.
     *
     * Not used to resolve exercise names — see the EntrySchema comment; the
     * names are already copied in.
     */
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkoutPlan",
      default: null,
    },

    /**
     * The day of the split the member PRIMARILY selected. They choose it
     * manually.
     *
     * Kept as a single number even though a session can span several days: it
     * is the session's headline day, and it is the fallback every entry with a
     * null entry-level dayNumber reads from (see EntrySchema.dayNumber), which
     * is what keeps logs written before per-entry attribution correct. The full
     * per-day breakdown lives on the entries.
     */
    dayNumber: {
      type: Number,
      default: null,
    },

    entries: {
      type: [EntrySchema],
      default: [],
    },
  },
  { timestamps: true },
);

/**
 * One logged session per member per day.
 *
 * A member ticks a few exercises, leaves, and comes back mid-workout to tick
 * the rest — that is the SAME session, so re-opening updates the existing row
 * rather than creating a second one. The handler upserts against this key; the
 * index guarantees it even if a future caller forgets to.
 */
WorkoutLogSchema.index({ memberId: 1, date: 1 }, { unique: true });

export default mongoose.model("WorkoutLog", WorkoutLogSchema);
