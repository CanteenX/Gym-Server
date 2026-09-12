import mongoose from "mongoose";

/** The slots on the public site an advert may occupy. */
export const AD_PLACEMENTS = ["HOME_HERO", "HOME_MID", "SIDEBAR", "FOOTER"];

/**
 * A promotional banner rendered on the public marketing site.
 *
 * WHY startAt/endAt RATHER THAN A CRON THAT FLIPS isActive: a scheduled job that
 * toggles a flag is a second source of truth that drifts the moment the job
 * misses a run, and it cannot be reasoned about from the row alone. The live
 * window is evaluated at read time instead, so a row always explains its own
 * visibility and a mis-set date is fixed by editing the row, not by waiting for
 * a job.
 *
 * "Currently live" is therefore: isActive AND (startAt unset or <= now) AND
 * (endAt unset or >= now). `liveWindowFilter()` below is the single expression
 * of that rule — never re-write it inline, or the admin "is it live?" badge and
 * the public endpoint will eventually disagree.
 *
 * Not branch-scoped, for the same reason as SiteContent: one public website.
 */
const AdvertisementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    /**
     * Opaque storage reference produced by middlewares/secureUpload.js ->
     * storage/fileStore.js (relative path locally, Blob URL on serverless).
     * Required: an advert with no creative is not an advert.
     */
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    /** Where clicking the banner goes. Empty means the banner is not a link. */
    targetUrl: {
      type: String,
      trim: true,
      default: "",
    },
    placement: {
      type: String,
      required: true,
      enum: AD_PLACEMENTS,
    },
    /**
     * Both dates are optional and both are open-ended when unset: an advert
     * with neither runs from now until it is switched off, which is the common
     * case and should not require picking arbitrary dates.
     */
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    /** Order within a placement when more than one advert is live. */
    sortOrder: { type: Number, default: 0 },
    /** The manual kill switch, independent of the date window. */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** Public reads are always "live adverts for a placement, in order". */
AdvertisementSchema.index({ placement: 1, isActive: 1, sortOrder: 1 });

/**
 * The Mongo filter fragment for "currently live", as defined above.
 *
 * Kept here, next to the fields it reads, so the public endpoint and any future
 * consumer share one definition of live.
 *
 * @param {Date} [now]
 * @returns {object} filter fragment to spread into a query
 */
export const liveWindowFilter = (now = new Date()) => ({
  isActive: true,
  $and: [
    { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
    { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
  ],
});

/**
 * The same rule applied to an already-loaded row, so the admin list can show a
 * live/scheduled/expired badge without a second query.
 *
 * @param {{isActive: boolean, startAt: Date|null, endAt: Date|null}} ad
 * @param {Date} [now]
 * @returns {boolean}
 */
export const isCurrentlyLive = (ad, now = new Date()) => {
  if (!ad?.isActive) return false;
  if (ad.startAt && new Date(ad.startAt) > now) return false;
  if (ad.endAt && new Date(ad.endAt) < now) return false;
  return true;
};

export default mongoose.model("Advertisement", AdvertisementSchema);
