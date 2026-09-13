import { revalidateSite } from "../../services/siteRevalidate.js";
import SiteItem, {
  SITE_ITEM_COLLECTIONS,
  FIELD_SPECS,
  validateItemFields,
} from "../../models/SiteItem.js";

// Same helper as every other list controller here: a user-supplied `match`
// becomes part of a $regex, so its metacharacters must be neutralised or a
// search for "(" is a crash and ".*" is a full table scan.
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Plain string fields a client may set. `collectionKey`, `fields`, `sortOrder`,
 * `isActive` and `branch` are handled individually because each needs coercion.
 */
const TEXT_FIELDS = ["subtitle", "body", "imageUrl", "ctaLabel", "ctaHref"];

/**
 * Multipart bodies arrive as strings — `isActive` is "false", `sortOrder` is
 * "3". Coercing at the edge keeps every comparison below honest; without it
 * `Boolean("false")` is true and a row switched off in the UI stays live.
 * Copied deliberately from advertisement.controller.js rather than shared: the
 * two files are the two halves of the same convention and neither should be
 * able to change it for the other.
 *
 * @param {unknown} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
const toBool = (v, fallback) => {
  if (v === undefined || v === "") return fallback;
  return v === true || v === "true" || v === "1" || v === 1;
};

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/** Trim-and-lowercase, the one place a collectionKey is normalised. */
const normalizeCollectionKey = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Parses the `fields` bag off a request body.
 *
 * Accepts an object (JSON body, the normal case) AND a JSON string, because a
 * multipart form — which is what the admin sends the moment a file input
 * appears on the same screen — cannot carry a nested object and will send
 * `fields` as text. A malformed string is reported rather than silently
 * treated as "no fields", since dropping the whole bag is how a plan loses its
 * price without anyone being told.
 *
 * @param {unknown} raw
 * @returns {{ value?: unknown, error?: string }} value undefined means "not supplied"
 */
const parseFieldsInput = (raw) => {
  if (raw === undefined) return {};
  // A multipart form sends every input it rendered, so "" is an untouched
  // field, not an instruction to empty the bag.
  if (raw === "" || raw === null) return {};
  if (typeof raw !== "string") return { value: raw };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: "fields must be an object or a JSON object string" };
  }
};

/**
 * PUBLIC — the marketing site's read of one list.
 *
 * No auth, no session: these are the programme cards, prices and FAQs printed
 * on midcitygym.in and they are public by definition. Only ACTIVE rows are
 * returned, because `isActive: false` is how staff take a row off the live
 * site; leaking drafts here would make that switch meaningless.
 *
 * `branch` NARROWS rather than filters strictly: a row with no branch belongs
 * to the whole gym and must still appear in a branch-specific timetable, or
 * asking for Gotri's classes would hide every class that runs at both.
 *
 * GET /api/v1/site/items?collectionKey=programs
 * GET /api/v1/site/items?collectionKey=classes&branch=Gotri
 */
export const getPublicSiteItems = async (req, res) => {
  try {
    const { collectionKey, branch } = req.query;

    const filter = { isActive: true };
    const safeKey = normalizeCollectionKey(collectionKey);
    if (safeKey) filter.collectionKey = safeKey;

    const safeBranch = typeof branch === "string" ? branch.trim() : "";
    if (safeBranch) {
      filter.$or = [
        { branch: safeBranch },
        { branch: "" },
        { branch: { $exists: false } },
      ];
    }

    const data = await SiteItem.find(filter)
      .select("-createdAt -updatedAt -__v")
      .sort({ collectionKey: 1, sortOrder: 1, createdAt: 1 })
      .lean();

    return ok(res, 200, "Site items fetched successfully", data);
  } catch (error) {
    console.error("Error fetching public site items:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — paged list, house `…-by-params` convention.
 *
 * Returns inactive rows too: the editor has to be able to see and re-enable a
 * row it has switched off.
 */
export const listSiteItemsByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, collectionKey, isActive } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 50;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }

    /**
     * `collectionKey` is accepted BOTH at the top level and nested inside
     * `match`, exactly as listSiteContentByParams accepts `pageKey` both ways:
     * the house convention is that `match` is a free-text search string, but
     * the admin editor groups by list and settled on `{ match: { ... } }`.
     * Supporting both is the difference between that screen paging properly and
     * pulling every row to group it in the browser.
     */
    const matchIsObject =
      match && typeof match === "object" && !Array.isArray(match);
    const requestedKey = matchIsObject ? match.collectionKey : collectionKey;

    const safeKey = normalizeCollectionKey(requestedKey);
    if (safeKey) matchCondition.collectionKey = safeKey;
    // A top-level collectionKey still narrows further when both forms are sent.
    if (matchIsObject) {
      const topLevel = normalizeCollectionKey(collectionKey);
      if (topLevel) matchCondition.collectionKey = topLevel;
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
        { collectionKey: { $regex: escaped, $options: "i" } },
        { title: { $regex: escaped, $options: "i" } },
        { subtitle: { $regex: escaped, $options: "i" } },
        { body: { $regex: escaped, $options: "i" } },
      ];
    }

    // Allowlist, not passthrough: `sorton` reaches a Mongo sort key directly.
    // `fields` is absent on purpose — sorting on an unvalidated Mixed path is
    // both meaningless and unindexable.
    const allowed = ["collectionKey", "title", "sortOrder", "branch", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "collectionKey";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await SiteItem.countDocuments(matchCondition);
    const data = await SiteItem.find(matchCondition)
      .sort({ [safeSortField]: sortOrder, sortOrder: 1 })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      /**
       * The known collections and their field specs ride along with every
       * page. The admin editor has to render a different form per collection
       * (a plan has a price, a class has a day), and shipping the spec from
       * the server is what stops that form drifting from what the API will
       * accept — a mismatch there is a 400 the user cannot act on.
       */
      collections: SITE_ITEM_COLLECTIONS,
      fieldSpecs: FIELD_SPECS,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing site items by params:", error);
    return fail(res, 500, "Internal server error");
  }
};

/** ADMIN — create one row. */
export const createSiteItem = async (req, res) => {
  try {
    const body = req.body || {};

    const safeKey = normalizeCollectionKey(body.collectionKey);
    if (!safeKey) {
      return fail(res, 400, "collectionKey is required");
    }

    const safeTitle = typeof body.title === "string" ? body.title.trim() : "";
    if (!safeTitle) {
      return fail(res, 400, "title is required");
    }

    const parsed = parseFieldsInput(body.fields);
    if (parsed.error) return fail(res, 400, parsed.error);

    const validated = validateItemFields(safeKey, parsed.value, {});
    if (validated.error) return fail(res, 400, validated.error);

    const doc = new SiteItem({
      collectionKey: safeKey,
      title: safeTitle,
      fields: validated.fields,
      sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) || 0 : 0,
      isActive: toBool(body.isActive, true),
      branch: typeof body.branch === "string" ? body.branch.trim() : "",
    });
    TEXT_FIELDS.forEach((f) => {
      if (body[f] === undefined) return;
      doc[f] = typeof body[f] === "string" ? body[f] : "";
    });

    await doc.save();

    // These rows appear across pages — a programme card on /programs and on the
    // home strip, a plan in the pricing table and the CTA — so there is no one
    // page to refresh. Without this the save is live in Mongo and invisible on
    // the website until the ISR window expires.
    await revalidateSite({});

    return ok(res, 201, "Site item created successfully", doc);
  } catch (error) {
    console.error("Error creating site item:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/** ADMIN — update one row. */
export const updateSiteItem = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await SiteItem.findById(id);

    if (!doc) {
      return fail(res, 404, "Site item not found");
    }

    const body = req.body || {};

    // "" is NOT meaningful for collectionKey or title: a multipart form sends
    // every input it rendered, so an untouched (or non-rendered) field arrives
    // empty, and treating that as a value would either move the row into a
    // nameless list or 400 a perfectly valid "just reorder it" edit.
    const previousCollectionKey = doc.collectionKey;
    if (body.collectionKey !== undefined && String(body.collectionKey).trim()) {
      doc.collectionKey = normalizeCollectionKey(body.collectionKey);
    }
    const collectionChanged = doc.collectionKey !== previousCollectionKey;
    if (body.title !== undefined && String(body.title).trim()) {
      doc.title = String(body.title).trim();
    }

    const parsed = parseFieldsInput(body.fields);
    if (parsed.error) return fail(res, 400, parsed.error);
    /**
     * Validated when `fields` was supplied, AND whenever the row is being MOVED
     * to another collection even though no fields came with it — otherwise
     * "change this FAQ into a pricing plan" lands a row in `plans` with no
     * price at all, which is the precise failure FIELD_SPECS exists to stop.
     * An edit that touches neither is left alone, so a row that predates a
     * later spec change can still be reordered or switched off.
     */
    if (parsed.value !== undefined || collectionChanged) {
      /**
       * MERGED over the existing bag, not replacing it, and validated against
       * the row's (possibly just changed) collectionKey. A partial edit that
       * sends only `{ featured: true }` must not drop the price; removing a key
       * is done by sending it as null.
       *
       * Assigning a NEW object rather than mutating `doc.fields` is required,
       * not stylistic: Mongoose cannot detect an in-place change to a Mixed
       * path, and a mutated bag saves as a no-op. `markModified` below is the
       * belt to that braces.
       */
      const validated = validateItemFields(
        doc.collectionKey,
        parsed.value,
        doc.fields || {},
      );
      if (validated.error) return fail(res, 400, validated.error);
      doc.fields = validated.fields;
      doc.markModified("fields");
    }

    TEXT_FIELDS.forEach((f) => {
      if (body[f] === undefined) return;
      // "" IS meaningful for these: clearing the CTA label must remove the
      // button, and the schema's empty-string default is exactly that.
      doc[f] = typeof body[f] === "string" ? body[f] : "";
    });

    // Same multipart rule as adverts: "" is an untouched field, not "reset
    // ordering to 0".
    if (body.sortOrder !== undefined && String(body.sortOrder).trim() !== "") {
      doc.sortOrder = Number(body.sortOrder) || 0;
    }
    if (body.isActive !== undefined) doc.isActive = toBool(body.isActive, doc.isActive);
    // `branch` is the exception: "" is the real value for "shows at every
    // branch", so an emptied select genuinely clears the tag.
    if (typeof body.branch === "string") doc.branch = body.branch.trim();

    await doc.save();

    // These rows appear across pages, so refresh every marketing route.
    await revalidateSite({});

    return ok(res, 200, "Site item updated successfully", doc);
  } catch (error) {
    console.error("Error updating site item:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * ADMIN — replace a row's image.
 *
 * Same pipeline as adverts and site content — middlewares/secureUpload.js ->
 * persistBuffer — so there is exactly one upload path in the codebase, and
 * `req.file.path` is stored verbatim as the opaque storage reference.
 * `imageUrl` remains a plain string that can still be typed in by hand, so this
 * is the option rather than the replacement.
 *
 * `?slot=beforeImage` writes into the `fields` bag instead of `imageUrl`, which
 * is what a transformation needs — it has two images and neither is "the"
 * image. The slot must be a declared `image` field of that collection, so the
 * query string cannot be used to write an arbitrary key.
 *
 * POST /api/v1/site/items/:id/image  (multipart, field `image`)
 */
export const uploadSiteItemImage = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file?.path) {
      return fail(res, 400, "No image uploaded (field name: image)");
    }

    const doc = await SiteItem.findById(id);
    if (!doc) {
      return fail(res, 404, "Site item not found");
    }

    // Accepted from the query string or the multipart body — the admin's
    // FormData carries it more naturally as a body field.
    const rawSlot = req.query?.slot ?? req.body?.slot;
    const slot = typeof rawSlot === "string" ? rawSlot.trim() : "";

    if (slot) {
      const spec = FIELD_SPECS[doc.collectionKey] || {};
      if (spec[slot]?.type !== "image") {
        const imageSlots = Object.entries(spec)
          .filter(([, rule]) => rule.type === "image")
          .map(([key]) => key);
        return fail(
          res,
          400,
          imageSlots.length
            ? `slot must be one of: ${imageSlots.join(", ")}`
            : `'${doc.collectionKey}' has no extra image slots — omit slot to set imageUrl`,
        );
      }
      // A fresh object, for the same Mixed-path reason as updateSiteItem.
      doc.fields = { ...(doc.fields || {}), [slot]: req.file.path };
      doc.markModified("fields");
    } else {
      doc.imageUrl = req.file.path;
    }

    await doc.save();

    // These rows appear across pages, so refresh every marketing route.
    await revalidateSite({});

    return ok(res, 200, "Image uploaded successfully", doc);
  } catch (error) {
    console.error("Error uploading site item image:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/** ADMIN — hard delete. `isActive: false` is the reversible option in the UI. */
export const deleteSiteItem = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await SiteItem.findByIdAndDelete(id);

    if (!deleted) {
      return fail(res, 404, "Site item not found");
    }

    // A removed row is as much a content change as an edited one; without this
    // the card stays on the live page until the ISR window expires.
    await revalidateSite({});

    return ok(res, 200, "Site item deleted successfully");
  } catch (error) {
    console.error("Error deleting site item:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
