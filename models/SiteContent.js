import mongoose from "mongoose";

/**
 * Editable copy for the public marketing site (Gym-frontend `(marketing)`
 * route group).
 *
 * WHY A GENERIC (pageKey, sectionKey) ROW RATHER THAN ONE DOCUMENT PER PAGE:
 * the marketing pages are a handful of independent blocks — a hero, a feature
 * strip, a call-to-action. A single "home page" document would mean the whole
 * page is one optimistic-lock target: two staff editing different blocks at the
 * same time silently overwrite each other, and adding a block is a schema
 * change. One row per block makes each block independently editable,
 * independently sortable (`sortOrder`) and independently switch-off-able
 * (`isActive`) with no migration.
 *
 * DELIBERATELY NOT BRANCH-SCOPED: there is one public website, not one per
 * branch. A Vasna admin editing the hero edits the hero everyone sees. Adding a
 * `branch` field here would imply per-branch sites that do not exist, so
 * middlewares/branchScope.js is intentionally not applied to this collection.
 */
const SiteContentSchema = new mongoose.Schema(
  {
    /**
     * Which page the block belongs to, e.g. "home" | "about" | "programs" |
     * "contact".
     *
     * Not an enum: the marketing site adds pages far more often than the API
     * ships, and an enum here would make "add a page" a server deploy. The
     * frontend asks for the keys it knows about and ignores the rest.
     */
    pageKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    /**
     * Which block on that page, e.g. "hero" | "features" | "cta".
     *
     * One value is reserved rather than free-form: `"seo"` — see
     * `SEO_FALLBACK_SECTION_KEY` in config/cmsMenus.js for the full contract
     * (which two fields it reads and why). Nothing in this schema or in the
     * controllers enforces that contract; it is enforced only by the two
     * field names agreeing with what Gym-frontend reads, which is exactly why
     * it is written down there and pinned by
     * scripts/tests/cmsReservedKeys.test.mjs.
     */
    sectionKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    title: { type: String, trim: true, default: "" },
    subtitle: { type: String, trim: true, default: "" },
    /** Plain text or limited HTML — rendered by the marketing site as-is. */
    body: { type: String, default: "" },
    /**
     * Opaque storage reference from storage/fileStore.js: a relative
     * "uploads/..." path on the PM2 deployment, an absolute Vercel Blob URL on
     * serverless. Callers must not parse it (see fileStore.js).
     */
    imageUrl: { type: String, trim: true, default: "" },
    ctaLabel: { type: String, trim: true, default: "" },
    ctaHref: { type: String, trim: true, default: "" },
    /** Render order within a page. Ties fall back to creation order. */
    sortOrder: { type: Number, default: 0 },
    /** Hides a block from the public site without deleting the copy. */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/**
 * One block per (page, section). The uniqueness is the point: it is what lets
 * the frontend address a block by name ("home"/"hero") instead of by id, and it
 * is what stops a second "hero" row appearing after a double-submit and
 * rendering twice.
 */
SiteContentSchema.index({ pageKey: 1, sectionKey: 1 }, { unique: true });

/** The public read is always "active rows for a page, in order". */
SiteContentSchema.index({ pageKey: 1, isActive: 1, sortOrder: 1 });

export default mongoose.model("SiteContent", SiteContentSchema);
