import { revalidateSite } from "../../services/siteRevalidate.js";
import SiteNotice, {
  NOTICE_KINDS,
  NOTICE_TONES,
  NOTICE_PLACEMENTS,
  liveWindowFilter,
  isCurrentlyLive,
  liveStatus,
} from "../../models/SiteNotice.js";

/**
 * Announcements and banners — the gym talking to its members, and the gym
 * promoting itself. See models/SiteNotice.js for why neither is an advert.
 *
 * MODELLED LINE-FOR-LINE ON advertisement.controller.js, deliberately: the two
 * collections share a scheduling rule, a multipart edge-case set and an admin
 * list shape, and an editor who has learned one screen should find the other
 * behaves identically. Where this file differs from that one, it is because
 * `kind` makes a rule conditional, and each of those places says so.
 *
 * THE SCHEDULING RULE IS NOT RE-IMPLEMENTED HERE. liveWindowFilter() and
 * isCurrentlyLive() come from models/liveWindow.js via the model, which is the
 * SAME pair the advert controller uses. That is the whole point: the admin
 * badge and the public endpoint must agree about what a two-minute window
 * means, because they have already disagreed once in this product's life.
 */

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Multipart bodies arrive as strings — `isActive` is "false", `sortOrder` is
 * "3". Coercing at the edge keeps every comparison below honest; without it
 * `Boolean("false")` is true and a notice switched off in the UI stays live.
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

/** The stored enums are SCREAMING_SNAKE, so normalisation uppercases. */
const toEnum = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");

const toText = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * The projection the public endpoint returns.
 *
 * EXPLICIT RATHER THAN THE WHOLE ROW, exactly as getPublicAds is: an unlisted
 * field cannot leak, and pinning the shape here means adding an internal field
 * to the schema later cannot silently publish it to the marketing site.
 * `_id` is included by default and is wanted — the frontend keys its dismissal
 * memory on it.
 */
const PUBLIC_FIELDS =
  "kind title body tone imageUrl ctaLabel ctaUrl placement dismissible sortOrder";

/**
 * PUBLIC — the marketing site's notice read.
 *
 * Returns ONLY currently-live notices. A scheduled or expired notice must never
 * reach the public endpoint, because the frontend caches under ISR and would
 * keep serving it well past its end date — which is exactly how a "we are shut
 * today" banner survives into next week.
 *
 * GET /api/v1/site/notices?kind=ANNOUNCEMENT
 * GET /api/v1/site/notices?kind=BANNER&placement=HOME_TOP
 *
 * `kind` IS EFFECTIVELY REQUIRED and omitting it returns every live notice of
 * both kinds. That is deliberate rather than a 400: the frontend renders the
 * announcement strip and the banner slabs from two different components, so it
 * always sends a kind, while a one-shot debugging fetch of "everything live"
 * stays possible.
 */
export const getPublicNotices = async (req, res) => {
  try {
    const { kind, placement } = req.query;

    const filter = liveWindowFilter();

    const safeKind = toEnum(kind);
    if (safeKind) {
      // An unknown kind returns nothing rather than everything — silently
      // widening a typo'd filter is how a draft banner ends up on the home page.
      if (!NOTICE_KINDS.includes(safeKind)) {
        return res.status(200).json({
          isOk: true,
          status: 200,
          message: "No notices for that kind",
          data: [],
        });
      }
      filter.kind = safeKind;
    }

    const safePlacement = toEnum(placement);
    if (safePlacement) {
      if (!NOTICE_PLACEMENTS.includes(safePlacement)) {
        return res.status(200).json({
          isOk: true,
          status: 200,
          message: "No notices for that placement",
          data: [],
        });
      }
      /**
       * A placement filter can only ever match banners, because the model forces
       * placement to null on every announcement. Applying it while `kind` says
       * ANNOUNCEMENT therefore returns [] rather than quietly ignoring one of
       * the two filters the caller asked for — which is the correct answer to a
       * contradictory question.
       */
      filter.placement = safePlacement;
    }

    const data = await SiteNotice.find(filter)
      .select(PUBLIC_FIELDS)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Notices fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching public notices:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * ADMIN — paged list. Each row carries a derived `isLive` and a `status`
 * (LIVE / SCHEDULED / EXPIRED / INACTIVE) so the panel can show the badge
 * without re-implementing the window rule. Both come from models/liveWindow.js.
 */
export const listSiteNoticesByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, kind, placement, isActive } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 10;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }

    /**
     * MIRRORS middlewares/cmsPermission.js readKindFromListBody: top-level
     * `kind` wins over the nested `match.kind` form. The two MUST agree — a
     * request authorised against /cms/announcements and then answered with
     * banners is the exact client/server disagreement cmsPermission exists to
     * prevent.
     */
    const bodyMatch =
      match && typeof match === "object" && !Array.isArray(match) ? match : null;
    const safeKind = toEnum(kind) || (bodyMatch ? toEnum(bodyMatch.kind) : "");
    if (safeKind && NOTICE_KINDS.includes(safeKind)) {
      matchCondition.kind = safeKind;
    }

    const safePlacement = toEnum(placement);
    if (safePlacement && NOTICE_PLACEMENTS.includes(safePlacement)) {
      matchCondition.placement = safePlacement;
    }

    // `match` doubles as the free-text search when it is a string, which is the
    // shape every other …-by-params endpoint in this codebase uses.
    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { body: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowed = [
      "title",
      "kind",
      "tone",
      "placement",
      "sortOrder",
      "startAt",
      "endAt",
      "createdAt",
    ];
    const safeSortField = allowed.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await SiteNotice.countDocuments(matchCondition);
    const rows = await SiteNotice.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    const now = new Date();
    const data = rows.map((row) => ({
      ...row,
      isLive: isCurrentlyLive(row, now),
      status: liveStatus(row, now),
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing site notices by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * Validates the kind-conditional fields and returns a 400 message, or null.
 *
 * DUPLICATES THE MODEL'S pre-validate HOOK ON PURPOSE, and the duplication is
 * one-directional: the hook is the floor that no code path (seed, import job,
 * future endpoint) can get under, while this produces the friendly, specific
 * message the admin panel shows an editor. A schema ValidationError would
 * surface as a wall of Mongoose prose.
 *
 * @param {string} kind already uppercased
 * @param {{body?: string, placement?: string}} values
 * @returns {string|null} the message to 400 with, or null when valid
 */
const kindRuleError = (kind, { body, placement }) => {
  if (kind === "ANNOUNCEMENT" && !body) {
    return "An announcement requires a body — the message members will read";
  }
  if (kind === "BANNER" && !placement) {
    return `A banner requires a placement — one of: ${NOTICE_PLACEMENTS.join(", ")}`;
  }
  return null;
};

/**
 * ADMIN — create.
 *
 * JSON, NOT MULTIPART, unlike createAd — and this is the one shape difference
 * from the advert routes worth knowing about. An advert is its creative, so
 * there is nothing to create before the file exists. A notice is its words: an
 * announcement never has an image at all, and a banner's is optional. So a row
 * is created from JSON and a creative is attached afterwards through
 * POST /site/notices/:id/image.
 *
 * There is a permission reason too, spelled out in cmsPermission.js: the
 * uploader runs after the permission check, so on a multipart create `req.body`
 * is still unparsed and `kind` cannot be read — meaning a multipart create
 * could only ever be checked against the all-pages grant, never against
 * /cms/announcements or /cms/banners. Creating from JSON keeps the narrow
 * grants meaningful.
 */
export const createSiteNotice = async (req, res) => {
  try {
    const { title, body, tone, ctaLabel, ctaUrl, imageUrl, sortOrder, isActive } =
      req.body || {};

    const safeKind = toEnum(req.body?.kind);
    if (!NOTICE_KINDS.includes(safeKind)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `Kind must be one of: ${NOTICE_KINDS.join(", ")}`,
      });
    }

    const safeTitle = toText(title);
    if (!safeTitle) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Title is required",
      });
    }

    const safeTone = toEnum(tone);
    if (safeTone && !NOTICE_TONES.includes(safeTone)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `Tone must be one of: ${NOTICE_TONES.join(", ")}`,
      });
    }

    const safePlacement = toEnum(req.body?.placement);
    if (safePlacement && !NOTICE_PLACEMENTS.includes(safePlacement)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `Placement must be one of: ${NOTICE_PLACEMENTS.join(", ")}`,
      });
    }

    const safeBody = toText(body);
    const ruleError = kindRuleError(safeKind, {
      body: safeBody,
      placement: safePlacement,
    });
    if (ruleError) {
      return res.status(400).json({ isOk: false, status: 400, message: ruleError });
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

    const notice = new SiteNotice({
      kind: safeKind,
      title: safeTitle,
      body: safeBody,
      tone: safeTone || "INFO",
      // Free text is accepted here as well as the upload route, matching
      // SiteContent.imageUrl: an already-hosted creative should not have to be
      // re-uploaded to be used.
      imageUrl: toText(imageUrl),
      ctaLabel: toText(ctaLabel),
      ctaUrl: toText(ctaUrl),
      // The model forces this to null for an announcement; passing it through
      // unconditionally keeps that rule in exactly one place.
      placement: safePlacement || null,
      dismissible: toBool(req.body?.dismissible, true),
      startAt: startAt ?? null,
      endAt: endAt ?? null,
      sortOrder: sortOrder !== undefined ? Number(sortOrder) || 0 : 0,
      isActive: toBool(isActive, true),
    });

    await notice.save();

    // Announcements are site-wide and banners are placed across pages, so
    // neither is owned by one route — refresh every marketing page, exactly as
    // the advert controller does.
    await revalidateSite({});

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Notice created successfully",
      data: {
        ...notice.toObject(),
        isLive: isCurrentlyLive(notice),
        status: liveStatus(notice),
      },
    });
  } catch (error) {
    console.error("Error creating site notice:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * ADMIN — update. JSON. Every field optional; an absent field is untouched.
 *
 * THE EMPTY-STRING RULE differs per field and each case is commented, the same
 * way updateAd's is. The short version: "" is meaningful for the text fields an
 * editor can deliberately clear (ctaUrl, ctaLabel, imageUrl) and is NOT
 * meaningful for enums and numbers, where an empty value means "the form sent a
 * field it was not editing".
 */
export const updateSiteNotice = async (req, res) => {
  try {
    const { id } = req.params;
    const notice = await SiteNotice.findById(id);

    if (!notice) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Notice not found",
      });
    }

    const { title, body, tone, ctaLabel, ctaUrl, imageUrl, sortOrder, isActive } =
      req.body || {};

    /**
     * A KIND CHANGE IS ALLOWED — an announcement that should have been a banner
     * is a real edit, and forcing delete-and-recreate would lose its schedule.
     * cmsPermission requires the grant for BOTH the old and the new kind, so
     * the conversion is exactly as privileged as editing either end of it.
     */
    if (req.body?.kind !== undefined && String(req.body.kind).trim() !== "") {
      const safeKind = toEnum(req.body.kind);
      if (!NOTICE_KINDS.includes(safeKind)) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: `Kind must be one of: ${NOTICE_KINDS.join(", ")}`,
        });
      }
      notice.kind = safeKind;
    }

    if (typeof title === "string" && title.trim()) notice.title = title.trim();
    // "" IS meaningful: a banner may legitimately drop its second sentence. The
    // model refuses an empty body on an announcement, so this cannot empty one.
    if (typeof body === "string") notice.body = body.trim();

    if (tone !== undefined && String(tone).trim() !== "") {
      const safeTone = toEnum(tone);
      if (!NOTICE_TONES.includes(safeTone)) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: `Tone must be one of: ${NOTICE_TONES.join(", ")}`,
        });
      }
      notice.tone = safeTone;
    }

    // "" IS meaningful for all three: clearing the link makes the notice
    // non-clickable (the same contract as Advertisement.targetUrl), and
    // clearing the image removes the creative from a banner.
    if (typeof ctaLabel === "string") notice.ctaLabel = ctaLabel.trim();
    if (typeof ctaUrl === "string") notice.ctaUrl = ctaUrl.trim();
    if (typeof imageUrl === "string") notice.imageUrl = imageUrl.trim();

    // "" is NOT meaningful for placement — an untouched or non-rendered
    // placement input arrives empty, and treating that as a value would 400 a
    // perfectly valid "just change the dates" edit on a banner.
    if (req.body?.placement !== undefined && String(req.body.placement).trim() !== "") {
      const safePlacement = toEnum(req.body.placement);
      if (!NOTICE_PLACEMENTS.includes(safePlacement)) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: `Placement must be one of: ${NOTICE_PLACEMENTS.join(", ")}`,
        });
      }
      notice.placement = safePlacement;
    }

    if (req.body?.dismissible !== undefined) {
      notice.dismissible = toBool(req.body.dismissible, notice.dismissible);
    }
    // Same rule: "" is an untouched field, not "reset ordering to 0".
    if (sortOrder !== undefined && String(sortOrder).trim() !== "") {
      notice.sortOrder = Number(sortOrder) || 0;
    }
    if (isActive !== undefined) notice.isActive = toBool(isActive, notice.isActive);

    const startAt = toDateOrNull(req.body?.startAt);
    const endAt = toDateOrNull(req.body?.endAt);
    if (startAt !== undefined) notice.startAt = startAt;
    if (endAt !== undefined) notice.endAt = endAt;
    if (notice.startAt && notice.endAt && notice.endAt < notice.startAt) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "endAt must not be earlier than startAt",
      });
    }

    /**
     * Re-check the kind rules against the POST-EDIT row, not the request. A
     * conversion from BANNER to ANNOUNCEMENT is only valid if the row that
     * results has a body, and that body may have been set three edits ago
     * rather than in this request.
     */
    const ruleError = kindRuleError(notice.kind, {
      body: toText(notice.body),
      placement: notice.placement,
    });
    if (ruleError) {
      return res.status(400).json({ isOk: false, status: 400, message: ruleError });
    }

    await notice.save();

    await revalidateSite({});

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Notice updated successfully",
      data: {
        ...notice.toObject(),
        isLive: isCurrentlyLive(notice),
        status: liveStatus(notice),
      },
    });
  } catch (error) {
    console.error("Error updating site notice:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * ADMIN — attach a creative to an existing BANNER. Multipart, field `image`.
 *
 * `req.file.path` is the opaque reference returned by the shared uploader
 * (relative path locally, Blob URL on serverless) — stored verbatim, exactly as
 * createAd stores it. Never rebuild a URL from it here.
 *
 * REFUSED ON AN ANNOUNCEMENT, and that is a 400 rather than a silent no-op:
 * an announcement renders as a line of text with no image slot, so accepting
 * the upload would take the editor's file, charge them the storage, and show
 * them nothing. Note the bytes have already been written by the time this runs
 * — multer is the last middleware — so this refuses the ASSOCIATION, not the
 * upload. Orphaning a blob is the cheap half of that trade.
 */
export const uploadSiteNoticeImage = async (req, res) => {
  try {
    const { id } = req.params;
    const notice = await SiteNotice.findById(id);

    if (!notice) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Notice not found",
      });
    }
    if (!req.file?.path) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "An image file is required (field name: image)",
      });
    }
    if (notice.kind !== "BANNER") {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Only a BANNER can carry an image; an announcement is text",
      });
    }

    notice.imageUrl = req.file.path;
    await notice.save();

    await revalidateSite({});

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Image uploaded successfully",
      data: {
        ...notice.toObject(),
        isLive: isCurrentlyLive(notice),
        status: liveStatus(notice),
      },
    });
  } catch (error) {
    console.error("Error uploading site notice image:", error);
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
 * The stored image is NOT removed, identically to deleteAd and for the same
 * reason: on serverless it lives in Vercel Blob behind an immutable URL that
 * other rows (or a cached page) may still reference, and a delete that
 * half-succeeds leaves a banner pointing at nothing. Orphaned blobs are cheap;
 * broken creatives are not.
 */
export const deleteSiteNotice = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await SiteNotice.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Notice not found",
      });
    }

    // A pulled notice must leave the live pages immediately — that is usually
    // exactly why it was pulled.
    await revalidateSite({});

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Notice deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting site notice:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
