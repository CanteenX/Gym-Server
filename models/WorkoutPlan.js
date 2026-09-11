import mongoose from "mongoose";

/**
 * One exercise inside one day of a plan.
 *
 * Targets are what the admin PRESCRIBES, not what the member did — the actual
 * performance lives in WorkoutLog. Keeping the two apart is what lets an admin
 * raise a target without rewriting anybody's history.
 */
const ExerciseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    targetSets: {
      type: Number,
      default: 4,
    },
    /**
     * A String, not a Number: real programmes prescribe ranges ("8-10"),
     * open-ended sets ("AMRAP") and per-side counts ("12 each"). Forcing this
     * into an integer would lose the instruction the member actually needs.
     */
    targetReps: {
      type: String,
      trim: true,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

/** One training day of the split. */
const DaySchema = new mongoose.Schema(
  {
    dayNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 6,
    },
    /** Human label the portal shows, e.g. "Chest & Triceps". */
    label: {
      type: String,
      trim: true,
      default: "",
    },
    exercises: {
      type: [ExerciseSchema],
      default: [],
    },
  },
  { _id: false },
);

/**
 * An admin-configured workout programme.
 *
 * WHY ONE SHARED PLAN RATHER THAN A COPY PER MEMBER:
 * the gym runs one standard split that most members follow. Copying it onto
 * every member at signup would freeze each copy at the moment it was made, so
 * improving the programme would mean rewriting hundreds of documents — and any
 * member the rewrite missed would silently drift onto a stale version. Members
 * instead POINT at a plan (Member.workoutPlanId), so editing the default
 * improves it for everyone still on it, immediately. Only a member who needs
 * something bespoke gets their own plan document.
 */
const WorkoutPlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    /** The plan followed by every member without an explicit assignment. */
    isDefault: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    days: {
      type: [DaySchema],
      default: [],
    },
  },
  { timestamps: true },
);

/**
 * Exactly ONE plan may be the default.
 *
 * The "which plan does this member follow" lookup falls back to
 * findOne({ isDefault: true }) — with two defaults that returns an arbitrary
 * one, so the same member could get different programmes on consecutive loads.
 * The index makes a second default impossible at the database level rather than
 * relying on every future writer to check first.
 *
 * PARTIAL, not plain unique: a plain unique index treats `false` as a value and
 * would allow only ONE non-default plan in the whole collection. Restricting it
 * to isDefault:true constrains only the rows that matter. (Same trap the
 * member loginId index had to avoid.)
 */
WorkoutPlanSchema.index(
  { isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true },
  },
);

export default mongoose.model("WorkoutPlan", WorkoutPlanSchema);
