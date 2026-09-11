import mongoose from "mongoose";

/**
 * A member's body-measurement log.
 *
 * WHY A SEPARATE COLLECTION RATHER THAN AN ARRAY ON Member:
 * this grows without bound — a member weighing in weekly for three years is
 * ~150 entries — and the chart only ever reads a recent window. An unbounded
 * subdocument array would be loaded in full on every member fetch, including
 * the login path, for data almost nobody needs at that moment.
 *
 * Entries are OWNED BY THE MEMBER: memberId is always taken from the verified
 * JWT, never from the request body, so one member cannot write into another's
 * log.
 */
const BodyMetricSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
      index: true,
    },

    weightKg: {
      type: Number,
      required: true,
      // A plausible human range. Rejecting nonsense at the schema level keeps
      // one fat-fingered "700" from wrecking the chart's y-axis forever.
      min: 20,
      max: 400,
    },

    /**
     * The DAY the member weighed in, normalised to midnight.
     *
     * Stored separately from createdAt because a member may record Monday's
     * weight on Tuesday morning, and the chart must plot it against the day it
     * belongs to. Normalising also makes the per-day unique index below work.
     */
    recordedOn: {
      type: Date,
      required: true,
      index: true,
    },

    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },
  },
  { timestamps: true },
);

/**
 * One entry per member per day.
 *
 * Stepping on the scale twice in a morning should correct the day's figure,
 * not add a second point at the same x position. The handler upserts against
 * this key; the index guarantees it even if a future caller forgets to.
 */
BodyMetricSchema.index({ memberId: 1, recordedOn: 1 }, { unique: true });

export default mongoose.model("BodyMetric", BodyMetricSchema);
