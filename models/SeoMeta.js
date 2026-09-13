import mongoose from "mongoose";

/**
 * Per-route SEO metadata for the public site and the member portal.
 *
 * WHY A ROW PER ROUTE RATHER THAN FIELDS ON SiteContent: SiteContent is one row
 * per *block* on a page (hero, features, cta) and a page owns several of them.
 * Metadata is one set of values per *page*, so hanging it off a block would
 * mean picking an arbitrary "primary" block and would break the moment that
 * block is deleted. It also has to cover routes that have no editable copy at
 * all — the six portal routes carry no SiteContent rows but still need
 * `noIndex: true` so a member's dashboard never lands in a search index.
 *
 * DELIBERATELY NOT BRANCH-SCOPED, same reasoning as SiteContent: there is one
 * public website, not one per branch, so middlewares/branchScope.js does not
 * apply to this collection.
 */

/** The three buckets the admin list filters by. Keep in sync with the chips. */
export const SEO_CATEGORIES = ["Marketing", "Portal", "Other"];

/**
 * Turns whatever the admin typed into the exact string the frontend will look
 * the row up by.
 *
 * THIS IS THE WHOLE CONTRACT OF THE COLLECTION. The frontend asks for a row by
 * the route it is currently rendering — `/programs`, straight out of the router
 * — so a row stored as "programs", "/Programs" or "/programs/" is a row that is
 * never found, and the page silently ships the layout's default title instead
 * of the one someone edited. There is no error to notice; it just does not
 * work. So every write path in the controller and the seed funnels through
 * here, and the rules are:
 *
 *   - exactly one leading slash: "programs" becomes "/programs", and internal
 *     runs of slashes are collapsed. A value that STARTS "//" is rejected
 *     outright rather than collapsed, because "//evil.com" is a
 *     protocol-relative URL, not a sloppy path;
 *   - no trailing slash, except the root, which IS "/";
 *   - lowercased, because every route in Gym-frontend is lowercase and a
 *     capital letter would otherwise be an invisible mismatch;
 *   - query string and hash dropped — they are not part of a route;
 *   - an absolute URL is rejected (returns ""), not silently truncated, since
 *     pasting "https://midcitygym.in/programs" in the slug field means the
 *     admin misunderstood the field and should be told.
 *
 * @param {unknown} value raw input
 * @returns {string} normalised slug, or "" when the input is unusable
 */
export const normalizeSlug = (value) => {
  if (typeof value !== "string") return "";

  let slug = value.trim();
  if (!slug) return "";

  // A full URL is a different kind of value, not a sloppy slug. Reject it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(slug) || slug.startsWith("//")) return "";
  // Whitespace inside a path is always a mistake.
  if (/\s/.test(slug)) return "";

  slug = slug.split("?")[0].split("#")[0];
  slug = slug.replace(/\/{2,}/g, "/");
  if (!slug.startsWith("/")) slug = `/${slug}`;
  if (slug.length > 1) slug = slug.replace(/\/+$/, "");

  return (slug || "/").toLowerCase();
};

/**
 * Validates a canonical URL.
 *
 * A canonical pointing somewhere wrong is worse than no canonical at all: it
 * tells Google "the real version of this page lives over there", and the page
 * drops out of the index. So the field is validated rather than stored as typed.
 *
 * Two shapes are accepted:
 *   - an absolute http(s) URL — the normal case, what the admin editor defaults
 *     to (the route's own absolute URL);
 *   - a root-relative path — valid in Next metadata, which resolves it against
 *     `metadataBase`.
 * Anything else (mailto:, javascript:, a bare "midcitygym.in" with no scheme, a
 * relative "../x") is rejected.
 *
 * @param {unknown} value raw input
 * @returns {boolean} whether the value may be stored
 */
export const isValidCanonicalUrl = (value) => {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url) return true; // empty means "no canonical", which is legal

  if (url.startsWith("/")) return !url.startsWith("//") && !/\s/.test(url);

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // "http:///x" parses but has no host.
    return Boolean(parsed.hostname) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
};

const SeoMetaSchema = new mongoose.Schema(
  {
    /** Route path, always normalised by `normalizeSlug` before it is stored. */
    /*
     * NOTE: uniqueness is declared once, on the explicit index below, and not
     * also as `unique: true` here — Mongoose 8 treats the two as two separate
     * index definitions and logs a duplicate-index warning on every boot.
     */
    slug: {
      type: String,
      required: true,
      trim: true,
    },
    /** Human label for the admin list ("Home", "Member Dashboard"). */
    pageTitle: {
      type: String,
      required: true,
      trim: true,
    },
    /**
     * An enum here, unlike SiteContent.pageKey: this is a fixed three-way UI
     * taxonomy the admin's filter chips are built from, not an open-ended key.
     * The controller coerces unknown values to the default rather than letting
     * a bad chip value turn a save into a 500.
     */
    category: {
      type: String,
      enum: SEO_CATEGORIES,
      default: "Marketing",
    },
    /** remixicon class, picked with the admin's IconPicker. */
    icon: { type: String, trim: true, default: "" },

    metaTitle: { type: String, trim: true, default: "" },
    metaDescription: { type: String, trim: true, default: "" },
    /** Normalised to a de-duplicated array of non-empty strings on write. */
    keywords: { type: [String], default: [] },
    canonicalUrl: { type: String, trim: true, default: "" },

    ogTitle: { type: String, trim: true, default: "" },
    ogDescription: { type: String, trim: true, default: "" },
    /**
     * Opaque storage reference or an absolute URL — same rule as
     * SiteContent.imageUrl: callers must not parse it.
     */
    ogImage: { type: String, trim: true, default: "" },
    ogType: { type: String, trim: true, default: "website" },

    /**
     * Emits `robots: noindex`. True for every portal route: those pages sit
     * behind member auth, and an indexed /dashboard is both useless to a
     * searcher and a hint about the shape of the private app.
     */
    noIndex: { type: Boolean, default: false },
    /** Hides the row from the public read without deleting the copy. */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/**
 * One row per route. The uniqueness is what lets the frontend address a row by
 * the path it is rendering, and it is what stops a double-submit creating a
 * second "/programs" whose values would then be chosen at random.
 */
SeoMetaSchema.index({ slug: 1 }, { unique: true });

/** The admin list is "rows in a category, by slug"; the chips page through it. */
SeoMetaSchema.index({ category: 1, slug: 1 });

export default mongoose.model("SeoMeta", SeoMetaSchema);
