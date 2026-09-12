import { revalidateSite } from "../../services/siteRevalidate.js";
import SiteContent from "../../models/SiteContent.js";

// Same helper as every other list controller here: a user-supplied `match`
// becomes part of a $regex, so its metacharacters must be neutralised or a
// search for "(" is a crash and ".*" is a full table scan.
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Fields a client may set. Anything else in the body is ignored, not echoed. */
const EDITABLE_FIELDS = [
  "title",
  "subtitle",
  "body",
  "imageUrl",
  "ctaLabel",
  "ctaHref",
];

/**
 * PUBLIC — the marketing site's read.
 *
 * No auth, no session: this is the copy on midcitygym.in and it is public by
 * definition. Only ACTIVE rows are returned, because `isActive: false` is how
 * staff take a block off the live site; leaking drafts here would make that
 * switch meaningless.
 *
 * GET /api/v1/site/content?pageKey=home
 */
export const getPublicSiteContent = async (req, res) => {
  try {
    const { pageKey } = req.query;

    const filter = { isActive: true };
    const safePageKey = typeof pageKey === "string" ? pageKey.trim() : "";
    if (safePageKey) filter.pageKey = safePageKey.toLowerCase();

    const data = await SiteContent.find(filter)
      .select("-createdAt -updatedAt -__v")
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Site content fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching public site content:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * ADMIN — paged list, house `…-by-params` convention.
 *
 * Returns inactive rows too: the editor has to be able to see and re-enable a
 * block it has switched off.
 */
export const listSiteContentByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, pageKey, isActive } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 50;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }

    /**
     * `pageKey` is accepted BOTH at the top level and nested inside `match`.
     *
     * The house convention is that `match` is a free-text search string, and it
     * still is — but the admin editor groups by page, and asking for
     * `{ match: { pageKey } }` is the shape it settled on. Supporting both is
     * two lines here and is the difference between that screen paging properly
     * and pulling all 5000 rows with per_page: 500 to group them in the
     * browser. `match` is read as an object OR a string, never both.
     */
    const matchIsObject =
      match && typeof match === "object" && !Array.isArray(match);
    const requestedPageKey = matchIsObject
      ? match.pageKey
      : pageKey;

    const safePageKey =
      typeof requestedPageKey === "string" ? requestedPageKey.trim() : "";
    if (safePageKey) matchCondition.pageKey = safePageKey.toLowerCase();
    // A top-level pageKey still narrows further when both forms are sent.
    if (matchIsObject && typeof pageKey === "string" && pageKey.trim()) {
      matchCondition.pageKey = pageKey.trim().toLowerCase();
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
        { pageKey: { $regex: escaped, $options: "i" } },
        { sectionKey: { $regex: escaped, $options: "i" } },
        { title: { $regex: escaped, $options: "i" } },
        { subtitle: { $regex: escaped, $options: "i" } },
      ];
    }

    // Allowlist, not passthrough: `sorton` reaches a Mongo sort key directly.
    const allowed = ["pageKey", "sectionKey", "sortOrder", "title", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "pageKey";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await SiteContent.countDocuments(matchCondition);
    const data = await SiteContent.find(matchCondition)
      .sort({ [safeSortField]: sortOrder, sortOrder: 1 })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing site content by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/** ADMIN — create one block. */
export const createSiteContent = async (req, res) => {
  try {
    const { pageKey, sectionKey, sortOrder, isActive } = req.body || {};

    const safePageKey = typeof pageKey === "string" ? pageKey.trim() : "";
    const safeSectionKey = typeof sectionKey === "string" ? sectionKey.trim() : "";

    if (!safePageKey) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "pageKey is required",
      });
    }
    if (!safeSectionKey) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "sectionKey is required",
      });
    }

    const doc = new SiteContent({
      pageKey: safePageKey.toLowerCase(),
      sectionKey: safeSectionKey.toLowerCase(),
      sortOrder: sortOrder !== undefined ? Number(sortOrder) || 0 : 0,
      isActive: isActive !== undefined ? isActive === true || isActive === "true" : true,
    });
    EDITABLE_FIELDS.forEach((f) => {
      if (req.body?.[f] !== undefined) doc[f] = req.body[f];
    });

    await doc.save();

    // The site caches this page until something invalidates it; a save that
    // does not do this is live in Mongo and invisible on the website.
    await revalidateSite({ pageKey: doc.pageKey });

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Site content created successfully",
      data: doc,
    });
  } catch (error) {
    // The (pageKey, sectionKey) unique index is the guard against a duplicate
    // "hero" rendering twice. Report it as a conflict rather than a 500 so the
    // editor can say "that section already exists — edit it".
    if (error?.code === 11000) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "A block already exists for that page and section",
      });
    }
    console.error("Error creating site content:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** ADMIN — update one block. */
export const updateSiteContent = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await SiteContent.findById(id);

    if (!doc) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Site content not found",
      });
    }

    const { pageKey, sectionKey, sortOrder, isActive } = req.body || {};
    if (typeof pageKey === "string" && pageKey.trim()) {
      doc.pageKey = pageKey.trim().toLowerCase();
    }
    if (typeof sectionKey === "string" && sectionKey.trim()) {
      doc.sectionKey = sectionKey.trim().toLowerCase();
    }
    if (sortOrder !== undefined) doc.sortOrder = Number(sortOrder) || 0;
    if (isActive !== undefined) {
      doc.isActive = isActive === true || isActive === "true";
    }
    EDITABLE_FIELDS.forEach((f) => {
      if (req.body?.[f] !== undefined) doc[f] = req.body[f];
    });

    await doc.save();

    // The site caches this page until something invalidates it; a save that
    // does not do this is live in Mongo and invisible on the website.
    await revalidateSite({ pageKey: doc.pageKey });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Site content updated successfully",
      data: doc,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "A block already exists for that page and section",
      });
    }
    console.error("Error updating site content:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * ADMIN — replace a block's image.
 *
 * NOT IN THE ORIGINAL PHASE 1 CONTRACT, and ADDITIVE to it: `imageUrl` remains a
 * plain string that can still be typed in by hand (an external CDN, a legacy
 * path), so nothing that was written against the contract breaks. This exists
 * because asking staff to "paste a URL" for a hero image means either the image
 * is hosted somewhere nobody controls, or it is never changed at all.
 *
 * Same pipeline as adverts — middlewares/secureUpload.js -> persistBuffer — so
 * there is exactly one upload path in the codebase, and `req.file.path` is
 * stored verbatim as the opaque storage reference.
 *
 * POST /api/v1/site/content/:id/image  (multipart, field `image`)
 */
export const uploadSiteContentImage = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file?.path) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "No image uploaded (field name: image)",
      });
    }

    const doc = await SiteContent.findById(id);
    if (!doc) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Site content not found",
      });
    }

    doc.imageUrl = req.file.path;
    await doc.save();

    // The site caches this page until something invalidates it; a save that
    // does not do this is live in Mongo and invisible on the website.
    await revalidateSite({ pageKey: doc.pageKey });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Image uploaded successfully",
      data: doc,
    });
  } catch (error) {
    console.error("Error uploading site content image:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** ADMIN — hard delete. `isActive: false` is the reversible option in the UI. */
export const deleteSiteContent = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await SiteContent.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Site content not found",
      });
    }

    // A removed section is as much a content change as an edited one; without
    // this the block stays on the live page until the ISR window expires.
    await revalidateSite({ pageKey: deleted.pageKey });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Site content deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting site content:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
