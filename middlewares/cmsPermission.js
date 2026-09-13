import SiteContent from "../models/SiteContent.js";
import SiteItem from "../models/SiteItem.js";
import {
  CMS_FALLBACK_MENU_URL,
  menuUrlForPageKey,
  menuUrlForCollectionKey,
} from "../config/cmsMenus.js";
import {
  ensurePermissionsFresh,
  hasMenuPermission,
} from "./checkPermission.js";
import { isSuperAdminSession } from "./superAdmin.js";

/**
 * Per-page permission for the CMS writes, replacing the single
 * checkPermission("/website-pages", …) that governed all of them.
 *
 * THE PROBLEM THIS SOLVES, stated precisely.
 * The admin sidebar now lists one screen per CMS page (/cms/faqs,
 * /cms/pricing, …) and the client gates each route on that row. If the server
 * kept checking one shared permission, the two would disagree in BOTH
 * directions: a staffer granted only /cms/faqs would pass the client check,
 * open the editor, and 403 on Save; and a staffer granted /website-pages but
 * not /cms/pricing would be refused a screen the server would have let them
 * save. A client and a server that disagree about who may edit what is worse
 * than having no granularity at all, because the panel has already promised the
 * user the screen by the time the server says no.
 *
 * THE RULE, in one sentence: a CMS write is authorised if the session holds
 * `action` on the menu row for the page actually being edited, OR on
 * /website-pages, which is the "all CMS pages" grant (see config/cmsMenus.js).
 *
 * WHY THE FALLBACK IS NOT A HOLE. /website-pages is an existing, seeded,
 * already-granted permission whose meaning has always been "may edit the
 * website's content". Nothing gains access that did not have it; per-page rows
 * only ever ADD narrower ways to be allowed. It also makes this change safe to
 * deploy BEFORE scripts/seedCmsMenus.js has run — an unseeded /cms/* row is
 * simply not found, and the fallback carries every request exactly as today.
 *
 * THE SUPER ADMIN bypasses entirely, identically to checkPermission — and
 * identically to checkPermission, that is `isSuperAdmin`, NOT `role ===
 * "ADMIN"`. This gate is the one that matters most for the change: the whole
 * point of the owner's model is that the CMS is theirs alone and is never
 * granted to a branch. While this bypassed on the role string, creating a
 * second CompanyMaster admin for a branch handed that branch the entire website
 * — every page, every collection — because /cms/* is granted to nobody and the
 * bypass meant nobody needed a grant.
 *
 * ALWAYS READS req.session.user. req.user is built by authMiddleware from four
 * fields (id, role, email, name) and carries no permissions whatsoever, so code
 * written against it sees an empty permission list and denies everything — or,
 * worse, reads `undefined` and concludes "unrestricted".
 */

/** Trim-and-lowercase, matching both CMS controllers' key normalisation. */
const normalizeKey = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Reads a content key off a `…-by-params` body.
 *
 * MIRRORS THE CONTROLLERS' OWN PRECEDENCE and must keep mirroring it: both
 * listSiteContentByParams and listSiteItemsByParams accept the key at the top
 * level AND nested inside `match`, with the top level winning when both are
 * sent. If this helper picked the other one, a request could be permission-
 * checked against `faqs` and then answered with `plans` — the exact
 * client/server disagreement this file exists to remove.
 *
 * @param {object} body req.body
 * @param {string} field "pageKey" | "collectionKey"
 * @returns {string} normalised key, or "" when the request asks for everything
 */
const readKeyFromListBody = (body, field) => {
  const source = body && typeof body === "object" ? body : {};

  const topLevel = normalizeKey(source[field]);
  if (topLevel) return topLevel;

  const match = source.match;
  const matchIsObject =
    match && typeof match === "object" && !Array.isArray(match);
  return matchIsObject ? normalizeKey(match[field]) : "";
};

/**
 * Loads the stored content key for a `:id` route.
 *
 * THE EXTRA QUERY IS DELIBERATE AND IS ACCEPTED COST. On PUT, DELETE and the
 * image upload the key is NOT in the request — the client sends `/site/items/:id`
 * and a body of changed fields — so the only way to know which page the caller
 * is about to change is to read the row first. That is one extra indexed
 * findById, projected to a single field, on a WRITE path (never on the public
 * read path, which stays untouched). The alternative is to keep one blanket CMS
 * permission, which is the thing being fixed.
 *
 * A missing row, or an id that is not a valid ObjectId, resolves to "" — the
 * caller then falls back to the all-pages permission. Two reasons: we genuinely
 * cannot know which page a nonexistent row belonged to, and returning a 404
 * from here would let an unprivileged staff account probe which CMS ids exist.
 * With the fallback grant the request proceeds and the controller returns its
 * own honest 404; without it the request is denied. Neither leaks anything.
 *
 * @param {typeof SiteContent | typeof SiteItem} model
 * @param {unknown} id req.params.id
 * @param {string} field "pageKey" | "collectionKey"
 * @returns {Promise<string>} normalised stored key, or ""
 */
const readStoredKey = async (model, id, field) => {
  if (typeof id !== "string" || !id.trim()) return "";
  try {
    const doc = await model.findById(id).select(field).lean();
    return normalizeKey(doc?.[field]);
  } catch {
    // A CastError on a malformed id is not an authorisation answer; treat it the
    // same as "not found" and let the controller produce the real error.
    return "";
  }
};

/**
 * Turns a resolved set of content keys into the menu URLs that must ALL be
 * satisfied, de-duplicated and never empty.
 *
 * @param {string[]} keys
 * @param {(key: string) => string} toMenuUrl
 * @returns {string[]}
 */
const toTargets = (keys, toMenuUrl) => {
  const urls = keys.filter(Boolean).map(toMenuUrl);
  // No key at all means the request is not scoped to a page — a list of every
  // row, or a row that no longer exists. That is an all-pages request and takes
  // the all-pages permission.
  return urls.length ? [...new Set(urls)] : [CMS_FALLBACK_MENU_URL];
};

// ===================================================================
// Resolvers — each returns the menu URLs one request touches
// ===================================================================

/** POST /site/content-by-params — the key is in the body, or absent. */
export const siteContentListTargets = async (req) =>
  toTargets([readKeyFromListBody(req.body, "pageKey")], menuUrlForPageKey);

/** POST /site/content — create. The key is required by the controller. */
export const siteContentCreateTargets = async (req) =>
  toTargets([normalizeKey(req.body?.pageKey)], menuUrlForPageKey);

/**
 * PUT/DELETE/POST-image /site/content/:id — the key is not in the request.
 *
 * BOTH the stored page AND, when the body moves the block to a different page,
 * the destination page are required. updateSiteContent lets `pageKey` be
 * changed, so checking only the stored key would let somebody granted
 * /cms/faqs pick up a FAQ block, retarget it at `home`, and thereby edit the
 * home page they were never granted. Requiring both permissions makes a move
 * exactly as privileged as editing either end of it.
 *
 * On the multipart image route `req.body` has not been parsed yet (permission
 * runs BEFORE multer on purpose, so no bytes are written for a request that
 * will be refused), so only the stored key is seen there — which is correct,
 * because that route cannot change `pageKey`.
 */
export const siteContentDocTargets = async (req) => {
  const stored = await readStoredKey(SiteContent, req.params?.id, "pageKey");
  const requested = normalizeKey(req.body?.pageKey);
  return toTargets([stored, requested], menuUrlForPageKey);
};

/** POST /site/items-by-params — the key is in the body, or absent. */
export const siteItemListTargets = async (req) =>
  toTargets(
    [readKeyFromListBody(req.body, "collectionKey")],
    menuUrlForCollectionKey,
  );

/** POST /site/items — create. The key is required by the controller. */
export const siteItemCreateTargets = async (req) =>
  toTargets([normalizeKey(req.body?.collectionKey)], menuUrlForCollectionKey);

/**
 * PUT/DELETE/POST-image /site/items/:id — same shape, same reasoning as
 * siteContentDocTargets. updateSiteItem explicitly supports moving a row
 * between collections ("change this FAQ into a pricing plan"), so both ends of
 * the move are checked.
 */
export const siteItemDocTargets = async (req) => {
  const stored = await readStoredKey(SiteItem, req.params?.id, "collectionKey");
  const requested = normalizeKey(req.body?.collectionKey);
  return toTargets([stored, requested], menuUrlForCollectionKey);
};

// ===================================================================
// The middleware
// ===================================================================

/**
 * Builds a CMS permission middleware.
 *
 * @param {string} action read | write | edit | delete
 * @param {(req: import("express").Request) => Promise<string[]>} resolveTargets
 *   one of the resolvers above; returns the menu URLs this request touches
 * @returns {import("express").RequestHandler}
 */
export const cmsPermission = (action, resolveTargets) => {
  return async (req, res, next) => {
    try {
      // The super admin always has full access — identical to checkPermission,
      // and the reason the owner never needs a single CMS grant seeded. A
      // branch admin is NOT a super admin and falls through to the checks.
      if (isSuperAdminSession(req)) {
        return next();
      }

      // Load/refresh the session's permissions ONCE, even though up to two
      // menus are checked below.
      const fresh = await ensurePermissionsFresh(req);
      if (!fresh.ok) {
        return res.status(fresh.status).json({
          isOk: false,
          message: fresh.message,
          status: fresh.status,
        });
      }

      const targets = await resolveTargets(req);

      // EVERY target must pass. A request that touches two pages (a block being
      // moved from one to the other) needs both, or the move is a way to edit a
      // page you were not granted.
      for (const menuUrl of targets) {
        const own = await hasMenuPermission(req, menuUrl, action);
        if (own.allowed) continue;

        // The all-CMS-pages grant. Skipped when it IS the target, so the same
        // menu is never queried twice.
        if (menuUrl !== CMS_FALLBACK_MENU_URL) {
          const all = await hasMenuPermission(
            req,
            CMS_FALLBACK_MENU_URL,
            action,
          );
          if (all.allowed) continue;
        }

        /**
         * NAMES THE PAGE. checkPermission's generic "for this module" was fine
         * when one permission governed the whole CMS; with twelve screens it
         * leaves the owner no way to know which grant is missing. The menuUrl is
         * not sensitive — it is the route the user just navigated to.
         */
        return res.status(403).json({
          isOk: false,
          message: `Access denied — no '${action}' permission for '${menuUrl}'`,
          status: 403,
        });
      }

      return next();
    } catch (error) {
      console.error("cmsPermission error:", error);
      return res.status(500).json({
        isOk: false,
        message: "Permission check failed",
        status: 500,
      });
    }
  };
};
