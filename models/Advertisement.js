import mongoose from "mongoose";

/**
 * THE LIVE-WINDOW RULE NOW LIVES IN models/liveWindow.js and is re-exported
 * here unchanged, so every existing importer of this module keeps working.
 *
 * It moved because a second content type (models/SiteNotice.js — announcements
 * and banners) needed the identical rule, and the comment below had always said
 * never to re-write it inline. Honouring that meant either making a notice
 * import the advert model — a dependency that would misdescribe the domain — or
 * copying the expression, which is the thing forbidden. One shared module is
 * the only answer that keeps ONE definition of "currently live" in the
 * codebase.
 */
export { liveWindowFilter, isCurrentlyLive, liveStatus } from "./liveWindow.js";

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
 * (endAt unset or >= now). `liveWindowFilter()` in models/liveWindow.js, which
 * this file re-exports, is the single expression of that rule — never re-write
 * it inline, or the admin "is it live?" badge and the public endpoint will
 * eventually disagree.
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

export default mongoose.model("Advertisement", AdvertisementSchema);
