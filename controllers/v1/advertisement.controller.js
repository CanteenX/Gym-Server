import { revalidateSite } from "../../services/siteRevalidate.js";
import Advertisement, {
  AD_PLACEMENTS,
  liveWindowFilter,
  isCurrentlyLive,
} from "../../models/Advertisement.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Multipart bodies arrive as strings — `isActive` is "false", `sortOrder` is
 * "3". Coercing at the edge keeps every comparison below honest; without it
 * `Boolean("false")` is true and an advert switched off in the UI stays live.
 *
 * @param {unknown} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
const toBool = (v, fallback) => {
  if (v === undefined || v === "") return fallback;
  return v === true || v === "true" || v === "1" || v === 1;
};

/**
 * An empty string from a cleared date picker must become null (open-ended), not
 * an Invalid Date — which Mongo stores and every comparison then fails against.
 *
 * @param {unknown} v
 * @returns {Date|null|undefined} undefined means "field not supplied"
 */
const toDateOrNull = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * PUBLIC — the marketing site's advert read.
 *
 * Returns ONLY currently-live adverts (see models/Advertisement.js). A scheduled
 * or expired advert must never reach the public endpoint, because the frontend
 * caches under ISR and would keep serving it well past its end date.
 *
 * GET /api/v1/site/ads?placement=HOME_HERO
 */
export const getPublicAds = async (req, res) => {
  try {
    const { placement } = req.query;

    const filter = liveWindowFilter();
    const safePlacement =
      typeof placement === "string" ? placement.trim().toUpperCase() : "";
    if (safePlacement) {
      // An unknown placement returns nothing rather than everything — silently
      // widening a typo'd filter is how the wrong banner ends up in the hero.
      if (!AD_PLACEMENTS.includes(safePlacement)) {
        return res.status(200).json({
          isOk: true,
          status: 200,
          message: "No adverts for that placement",
          data: [],
        });
      }
      filter.placement = safePlacement;
    }

    const data = await Advertisement.find(filter)
      .select("title imageUrl targetUrl placement sortOrder")
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Adverts fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching public adverts:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * ADMIN — paged list. Each row carries a derived `isLive` so the panel can show
 * the live/scheduled/expired badge without re-implementing the window rule.
 */
export const listAdsByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, placement, isActive } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 10;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    const safePlacement =
      typeof placement === "string" ? placement.trim().toUpperCase() : "";
    if (safePlacement && AD_PLACEMENTS.includes(safePlacement)) {
      matchCondition.placement = safePlacement;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { targetUrl: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowed = ["title", "placement", "sortOrder", "startAt", "endAt", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await Advertisement.countDocuments(matchCondition);
    const rows = await Advertisement.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    const now = new Date();
    const data = rows.map((ad) => ({ ...ad, isLive: isCurrentlyLive(ad, now) }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing adverts by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * ADMIN — create. Multipart, field `image`.
 *
 * `req.file.path` is the opaque reference returned by persistBuffer (relative
 * path locally, Blob URL on serverless) — stored verbatim, exactly as
 * member.controller.js stores photos. Never rebuild a URL from it here.
 */
export const createAd = async (req, res) => {
  try {
    const { title, targetUrl, placement, sortOrder, isActive } = req.body || {};

    const safeTitle = typeof title === "string" ? title.trim() : "";
    const safePlacement =
      typeof placement === "string" ? placement.trim().toUpperCase() : "";

    if (!safeTitle) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Title is required",
      });
    }
    if (!AD_PLACEMENTS.includes(safePlacement)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `Placement must be one of: ${AD_PLACEMENTS.join(", ")}`,
      });
    }
    if (!req.file?.path) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "An advert image is required (field name: image)",
      });
    }

    const startAt = toDateOrNull(req.body?.startAt);
    const endAt = toDateOrNull(req.body?.endAt);
    if (startAt && endAt && endAt < startAt) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "endAt must not be earlier than startAt",
      });
    }

    const ad = new Advertisement({
      title: safeTitle,
      imageUrl: req.file.path,
      targetUrl: typeof targetUrl === "string" ? targetUrl.trim() : "",
      placement: safePlacement,
      startAt: startAt ?? null,
      endAt: endAt ?? null,
      sortOrder: sortOrder !== undefined ? Number(sortOrder) || 0 : 0,
      isActive: toBool(isActive, true),
    });

    await ad.save();

    // Adverts are placed across pages rather than owned by one, so refresh
    // every marketing route.
    await revalidateSite({});

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Advert created successfully",
      data: { ...ad.toObject(), isLive: isCurrentlyLive(ad) },
    });
  } catch (error) {
    console.error("Error creating advert:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * ADMIN — update. Multipart, field `image` OPTIONAL: no file means "keep the
 * current creative", which is what editing only the schedule must do.
 */
export const updateAd = async (req, res) => {
  try {
    const { id } = req.params;
    const ad = await Advertisement.findById(id);

    if (!ad) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Advert not found",
      });
    }

    const { title, targetUrl, placement, sortOrder, isActive } = req.body || {};

    if (typeof title === "string" && title.trim()) ad.title = title.trim();
    // "" here IS meaningful: clearing the link field must make the banner
    // non-clickable, and the schema's empty-string default is exactly that.
    if (typeof targetUrl === "string") ad.targetUrl = targetUrl.trim();
    // "" is NOT meaningful for placement — a multipart form sends every field,
    // so an untouched (or non-rendered) placement input arrives empty. Treating
    // that as a value would 400 a perfectly valid "just change the dates" edit.
    if (placement !== undefined && String(placement).trim() !== "") {
      const safePlacement = String(placement).trim().toUpperCase();
      if (!AD_PLACEMENTS.includes(safePlacement)) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: `Placement must be one of: ${AD_PLACEMENTS.join(", ")}`,
        });
      }
      ad.placement = safePlacement;
    }
    // Same multipart rule: "" is an untouched field, not "reset ordering to 0".
    if (sortOrder !== undefined && String(sortOrder).trim() !== "") {
      ad.sortOrder = Number(sortOrder) || 0;
    }
    if (isActive !== undefined) ad.isActive = toBool(isActive, ad.isActive);

    const startAt = toDateOrNull(req.body?.startAt);
    const endAt = toDateOrNull(req.body?.endAt);
    if (startAt !== undefined) ad.startAt = startAt;
    if (endAt !== undefined) ad.endAt = endAt;
    if (ad.startAt && ad.endAt && ad.endAt < ad.startAt) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "endAt must not be earlier than startAt",
      });
    }

    if (req.file?.path) ad.imageUrl = req.file.path;

    await ad.save();

    // Adverts are placed across pages rather than owned by one, so refresh
    // every marketing route.
    await revalidateSite({});

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Advert updated successfully",
      data: { ...ad.toObject(), isLive: isCurrentlyLive(ad) },
    });
  } catch (error) {
    console.error("Error updating advert:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * ADMIN — delete the row.
 *
 * The stored image is NOT removed: on serverless it lives in Vercel Blob behind
 * an immutable URL that other rows (or a cached page) may still reference, and
 * a delete that half-succeeds leaves an advert pointing at nothing. Orphaned
 * blobs are cheap; broken creatives are not.
 */
export const deleteAd = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Advertisement.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Advert not found",
      });
    }

    // A pulled advert must leave the live pages immediately - that is usually
    // exactly why it was pulled.
    await revalidateSite({});

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Advert deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting advert:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
