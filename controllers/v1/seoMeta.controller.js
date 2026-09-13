import { revalidateSite } from "../../services/siteRevalidate.js";
import SeoMeta, {
  SEO_CATEGORIES,
  normalizeSlug,
  isValidCanonicalUrl,
} from "../../models/SeoMeta.js";

// Same helper as every other list controller here: a user-supplied `match`
// becomes part of a $regex, so its metacharacters must be neutralised or a
// search for "(" is a crash and ".*" is a full table scan.
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Plain string fields a client may set. Anything else in the body is ignored,
 * not echoed. `slug`, `category`, `keywords`, `canonicalUrl`, `noIndex` and
 * `isActive` are handled individually because each needs coercion.
 */
const TEXT_FIELDS = [
  "pageTitle",
  "icon",
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "ogImage",
  "ogType",
];

/** Defensive ceilings so one paste cannot put a megabyte in a meta tag. */
const MAX_KEYWORDS = 30;
const MAX_KEYWORD_LENGTH = 80;

/**
 * Accepts the admin's array AND a comma-separated string.
 *
 * The editor sends ["gym in vadodara", "zumba"], but a chip input that has not
 * been committed, a CSV import or a hand-written API call all send
 * "gym in vadodara, zumba" instead — and storing that as a single keyword is
 * the kind of bug nobody notices until the meta tag is read. Both shapes are
 * normalised here to one de-duplicated list.
 *
 * @param {unknown} value array, comma-separated string, or anything else
 * @returns {string[]} cleaned keywords
 */
const normalizeKeywords = (value) => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    // An array element may itself still be "a, b" — flatten that too.
    for (const part of entry.split(",")) {
      const keyword = part.trim().slice(0, MAX_KEYWORD_LENGTH);
      if (!keyword) continue;
      const key = keyword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(keyword);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
};

/** Unknown categories fall back to the default rather than 500ing on the enum. */
const normalizeCategory = (value) => {
  if (typeof value !== "string") return undefined;
  const match = SEO_CATEGORIES.find(
    (c) => c.toLowerCase() === value.trim().toLowerCase(),
  );
  return match || "Marketing";
};

/** Accepts real booleans and the "true"/"false" strings a form sends. */
const toBoolean = (value) => value === true || value === "true";

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/**
 * Tell the public site to rebuild the affected route(s).
 *
 * Metadata is baked into the prerendered HTML, so unlike a copy change this is
 * not merely stale-looking: a crawler that fetches the cached page sees the old
 * title, description and canonical until the ISR window expires. Awaited and
 * best-effort, exactly like the SiteContent writes — a failed revalidation must
 * never fail the save.
 *
 * @param {...string} slugs one or more already-normalised route paths
 */
const revalidateSlugs = async (...slugs) => {
  const paths = [...new Set(slugs.filter(Boolean))];
  if (!paths.length) return;
  await revalidateSite({ paths });
};

/**
 * PUBLIC — the metadata read for `generateMetadata()` and the sitemap.
 *
 * No auth and no session: this is what is printed in the <head> of
 * midcitygym.in, so it is public by definition. `.lean()` and a projection
 * because it runs on every prerender of every route.
 *
 * Only ACTIVE rows are returned. `isActive: false` is how staff retire a row;
 * serving it anyway would make that switch meaningless. Note that `noIndex`
 * rows ARE returned — the frontend needs the flag in order to emit
 * `robots: noindex`, and it is the sitemap builder that filters them out.
 *
 * GET /api/v1/site/seo            -> every active row (array)
 * GET /api/v1/site/seo?slug=/x    -> that one row (object) or null
 */
export const getPublicSeoMeta = async (req, res) => {
  try {
    const { slug } = req.query;
    // `updatedAt` is kept, unlike the SiteContent public read: sitemap.xml uses
    // it for <lastmod>, and a sitemap without one is a sitemap Google re-crawls
    // on its own schedule instead of on ours.
    const projection = "-createdAt -__v";

    // A slug was asked for: answer with the single row, or null. The frontend
    // must treat null as "no row yet" and fall back to its own defaults —
    // adding a route without seeding a row must never ship a page with no title.
    if (typeof slug === "string" && slug.trim()) {
      const safeSlug = normalizeSlug(slug);
      if (!safeSlug) {
        return fail(res, 400, "Invalid slug");
      }

      const row = await SeoMeta.findOne({ slug: safeSlug, isActive: true })
        .select(projection)
        .lean();

      return ok(res, 200, "SEO metadata fetched successfully", row || null);
    }

    const data = await SeoMeta.find({ isActive: true })
      .select(projection)
      .sort({ category: 1, slug: 1 })
      .lean();

    return ok(res, 200, "SEO metadata fetched successfully", data);
  } catch (error) {
    console.error("Error fetching public SEO metadata:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — paged list, house `…-by-params` convention.
 *
 * Returns inactive rows too: the manager has to be able to see and re-enable a
 * row it has switched off.
 */
export const listSeoByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, category, isActive } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 50;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = toBoolean(isActive);
    }

    /**
     * `category` is accepted BOTH at the top level and nested inside `match`,
     * for the same reason listSiteContentByParams accepts `pageKey` both ways:
     * the admin screen filters with chips and settled on
     * `{ match: { category } }`, and supporting both here is the difference
     * between that screen paging properly and pulling every row to filter it
     * in the browser.
     */
    const matchIsObject =
      match && typeof match === "object" && !Array.isArray(match);
    const requestedCategory = matchIsObject ? match.category : category;

    // Matched exactly against the known list — never interpolated into a query
    // as free text. An unknown value (or "All", or "") simply means no filter.
    const knownCategory = (value) =>
      typeof value === "string" && value.trim()
        ? SEO_CATEGORIES.find(
            (c) => c.toLowerCase() === value.trim().toLowerCase(),
          )
        : undefined;

    const safeCategory = knownCategory(requestedCategory);
    if (safeCategory) matchCondition.category = safeCategory;
    // A top-level category still narrows further when both forms are sent.
    if (matchIsObject) {
      const topLevel = knownCategory(category);
      if (topLevel) matchCondition.category = topLevel;
    }

    const safeMatch = matchIsObject
      ? typeof match.match === "string"
        ? match.match.trim()
        : ""
      : typeof match === "string"
        ? match.trim()
        : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { slug: { $regex: escaped, $options: "i" } },
        { pageTitle: { $regex: escaped, $options: "i" } },
        { metaTitle: { $regex: escaped, $options: "i" } },
        { metaDescription: { $regex: escaped, $options: "i" } },
        { keywords: { $regex: escaped, $options: "i" } },
      ];
    }

    // Allowlist, not passthrough: `sorton` reaches a Mongo sort key directly.
    const allowed = ["slug", "pageTitle", "category", "createdAt", "updatedAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "category";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await SeoMeta.countDocuments(matchCondition);
    const data = await SeoMeta.find(matchCondition)
      .sort({ [safeSortField]: sortOrder, slug: 1 })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing SEO metadata by params:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * Copies the editable body fields onto a document.
 *
 * Shared by create and update so the two cannot drift — a field added to one
 * and forgotten in the other is a save that silently does nothing.
 *
 * @param {import("mongoose").Document} doc target document
 * @param {object} body request body
 * @returns {string|null} a validation error message, or null when applied
 */
const applyEditableFields = (doc, body) => {
  if (body.canonicalUrl !== undefined) {
    const canonical =
      typeof body.canonicalUrl === "string" ? body.canonicalUrl.trim() : "";
    // Rejected rather than stored: a canonical pointing at the wrong place
    // de-indexes the page, and a silently-dropped one is just as confusing.
    if (!isValidCanonicalUrl(canonical)) {
      return "canonicalUrl must be an absolute http(s) URL or a path starting with /";
    }
    doc.canonicalUrl = canonical;
  }

  if (body.keywords !== undefined) {
    doc.keywords = normalizeKeywords(body.keywords);
  }

  if (body.category !== undefined) {
    const normalized = normalizeCategory(body.category);
    if (normalized) doc.category = normalized;
  }

  if (body.noIndex !== undefined) doc.noIndex = toBoolean(body.noIndex);
  if (body.isActive !== undefined) doc.isActive = toBoolean(body.isActive);

  TEXT_FIELDS.forEach((f) => {
    if (body[f] === undefined) return;
    doc[f] = typeof body[f] === "string" ? body[f].trim() : "";
  });

  return null;
};

/** ADMIN — create one route's metadata. */
export const createSeoMeta = async (req, res) => {
  try {
    const body = req.body || {};

    const safeSlug = normalizeSlug(body.slug);
    if (!safeSlug) {
      return fail(
        res,
        400,
        "slug is required and must be a route path such as / or /programs",
      );
    }

    const safePageTitle =
      typeof body.pageTitle === "string" ? body.pageTitle.trim() : "";
    if (!safePageTitle) {
      return fail(res, 400, "pageTitle is required");
    }

    const doc = new SeoMeta({ slug: safeSlug, pageTitle: safePageTitle });
    const invalid = applyEditableFields(doc, body);
    if (invalid) return fail(res, 400, invalid);

    await doc.save();

    // Metadata is baked into the prerendered HTML — a save that skips this is
    // live in Mongo and invisible to crawlers until the ISR window expires.
    await revalidateSlugs(doc.slug);

    return ok(res, 201, "SEO metadata created successfully", doc);
  } catch (error) {
    // The unique slug index is the guard against two rows claiming one route.
    // Report it as a conflict so the editor can say "edit the existing row".
    if (error?.code === 11000) {
      return fail(res, 409, "SEO metadata already exists for that slug");
    }
    console.error("Error creating SEO metadata:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/** ADMIN — update one route's metadata. */
export const updateSeoMeta = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await SeoMeta.findById(id);

    if (!doc) {
      return fail(res, 404, "SEO metadata not found");
    }

    const body = req.body || {};
    // Captured before the change so a re-pointed row can refresh BOTH paths:
    // the route that no longer owns this metadata is as stale as the one that
    // now does.
    const previousSlug = doc.slug;

    if (body.slug !== undefined) {
      const safeSlug = normalizeSlug(body.slug);
      if (!safeSlug) {
        return fail(res, 400, "slug must be a route path such as / or /programs");
      }
      doc.slug = safeSlug;
    }

    if (body.pageTitle !== undefined) {
      const safePageTitle =
        typeof body.pageTitle === "string" ? body.pageTitle.trim() : "";
      if (!safePageTitle) {
        return fail(res, 400, "pageTitle cannot be empty");
      }
      doc.pageTitle = safePageTitle;
    }

    const invalid = applyEditableFields(doc, body);
    if (invalid) return fail(res, 400, invalid);

    await doc.save();

    // Metadata is baked into the prerendered HTML — a save that skips this is
    // live in Mongo and invisible to crawlers until the ISR window expires.
    await revalidateSlugs(previousSlug, doc.slug);

    return ok(res, 200, "SEO metadata updated successfully", doc);
  } catch (error) {
    if (error?.code === 11000) {
      return fail(res, 409, "SEO metadata already exists for that slug");
    }
    console.error("Error updating SEO metadata:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/** ADMIN — hard delete. `isActive: false` is the reversible option in the UI. */
export const deleteSeoMeta = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await SeoMeta.findByIdAndDelete(id);

    if (!deleted) {
      return fail(res, 404, "SEO metadata not found");
    }

    // A removed row changes the rendered <head> as much as an edited one: the
    // page must rebuild so it falls back to the frontend's own defaults.
    await revalidateSlugs(deleted.slug);

    return ok(res, 200, "SEO metadata deleted successfully");
  } catch (error) {
    console.error("Error deleting SEO metadata:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
