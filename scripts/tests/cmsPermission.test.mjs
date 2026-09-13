/**
 * OFFLINE tests for the CMS per-page permission derivation.
 *
 * Run:  node --test scripts/tests/cmsPermission.test.mjs
 *
 * NO DATABASE, following scripts/tests/scoping.test.mjs: Mongoose schemas
 * compile without a connection, so the real middleware and the real models are
 * imported and the models' static query methods are replaced with stubs that
 * CAPTURE WHICH MENU URL WAS LOOKED UP and return fixtures. That capture is the
 * whole point — the assertion these tests exist to make is "editing the FAQs
 * checked /cms/faqs and never /cms/pricing", which is a statement about the
 * query that reached Mongo, not about the response.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE
 * The failure being guarded against is silent in both directions. If the server
 * kept checking one blanket permission, a staff member granted only /cms/faqs
 * would be handed the screen by the client and refused by the server on Save —
 * and nothing in the code would look wrong, because both halves are individually
 * correct. And if the derivation picked the wrong key (the nested `match` form
 * instead of the top-level one, say), the request would be authorised against
 * one page and answered with another, which no amount of careful reading
 * catches.
 */
import test from "node:test";
import assert from "node:assert/strict";

import MenuMaster from "../../models/MenuMaster.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";
import SiteContent from "../../models/SiteContent.js";
import SiteItem from "../../models/SiteItem.js";

import {
  cmsPermission,
  siteContentListTargets,
  siteContentCreateTargets,
  siteContentDocTargets,
  siteItemListTargets,
  siteItemCreateTargets,
  siteItemDocTargets,
} from "../../middlewares/cmsPermission.js";
import { checkPermission } from "../../middlewares/checkPermission.js";

import {
  CMS_FALLBACK_MENU_URL,
  CMS_MENU_TREE,
  menuUrlForPageKey,
  menuUrlForCollectionKey,
  cmsLeafMenuUrls,
  CMS_PAGE_MENUS,
  CMS_COLLECTION_MENUS,
} from "../../config/cmsMenus.js";

// ===================================================================
// Harness
// ===================================================================

/**
 * Every menu URL the server may resolve, with a stable fake _id. A URL absent
 * from here behaves exactly like an unseeded MenuMaster row: not found.
 */
const MENU_IDS = {
  "/website-pages": "menu-website-pages",
  "/cms/home": "menu-cms-home",
  "/cms/about": "menu-cms-about",
  "/cms/contact": "menu-cms-contact",
  "/cms/programs": "menu-cms-programs",
  "/cms/pricing": "menu-cms-pricing",
  "/cms/faqs": "menu-cms-faqs",
  "/cms/trainers": "menu-cms-trainers",
  "/cms/testimonials": "menu-cms-testimonials",
  "/cms/classes": "menu-cms-classes",
  "/cms/header": "menu-cms-header",
  "/cms/footer": "menu-cms-footer",
  "/cms/social": "menu-cms-social",
  // Not a CMS screen. Present so a fixture can hold a real permission on
  // something ELSE, which is what puts the session on the normal code path.
  "/seo-manager": "menu-seo-manager",
};

/** Menu URLs looked up during the call under test, in order. */
let lookedUp = [];
/** The stored document readStoredKey will find, or null for "not found". */
let storedDoc = null;
/** Set when a stub is asked for something these tests should never need. */
let unexpected = [];

MenuMaster.findOne = (filter) => ({
  lean: async () => {
    lookedUp.push(filter.menuUrl);
    const id = MENU_IDS[filter.menuUrl];
    return id ? { _id: id } : null;
  },
});

// Present so that an accidental permission RELOAD is loud rather than silent:
// every fixture below carries permissions and no roleId, so neither
// refreshPermissions nor isPermissionStale should ever reach the database.
EmployeeRoles.findOne = () => {
  unexpected.push("EmployeeRoles.findOne");
  return { select: () => ({ lean: async () => null }) };
};

const docStub = () => ({ select: () => ({ lean: async () => storedDoc }) });
SiteContent.findById = docStub;
SiteItem.findById = docStub;

/**
 * A staff session holding `action` on exactly the menus listed.
 *
 * `user` is present ON PURPOSE and carries no permissions, mirroring what
 * authMiddleware really builds: if the middleware ever reads req.user instead
 * of req.session.user these tests fail loudly rather than the panel failing
 * quietly in production.
 */
const staff = (grants, { body = {}, params = {} } = {}) => ({
  session: {
    user: {
      id: "emp-1",
      role: "EMPLOYEE",
      name: "Content Editor",
      email: "editor@example.com",
      // No roleId: ensurePermissionsFresh must take the "already loaded" path.
      permissions: Object.entries(grants).map(([menuUrl, actions]) => ({
        menuId: MENU_IDS[menuUrl],
        menuGroupId: "group-cms",
        read: actions.includes("read"),
        write: actions.includes("write"),
        edit: actions.includes("edit"),
        delete: actions.includes("delete"),
        print: false,
        mail: false,
      })),
      permissionsUpdatedAt: new Date().toISOString(),
    },
  },
  user: { id: "emp-1", role: "EMPLOYEE", email: "editor@example.com", name: "Content Editor" },
  body,
  params,
  query: {},
  headers: {},
});

/**
 * A super admin.
 *
 * `isSuperAdmin: true` is the field the gates actually read — NOT `role`. The
 * role string says only which table the account lives in ("ADMIN" =
 * CompanyMaster), and a branch-level CompanyMaster admin carries the same role
 * with isSuperAdmin: false. See middlewares/superAdmin.js, and
 * scripts/tests/superAdminGate.test.mjs for the branch-admin half of this.
 */
const superAdmin = (opts = {}) => ({
  ...staff({}, opts),
  session: {
    user: { id: "owner", role: "ADMIN", name: "Owner", isSuperAdmin: true },
  },
});

/** Minimal res double capturing the terminal status and payload. */
const makeRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
};

/**
 * Runs one middleware and reports what happened.
 *
 * @returns {Promise<{passed: boolean, status: number|null, message: string|undefined, lookedUp: string[]}>}
 */
const run = async (middleware, req, doc = null) => {
  lookedUp = [];
  unexpected = [];
  storedDoc = doc;

  const res = makeRes();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });

  assert.deepEqual(unexpected, [], "a stub was called that should not have been");

  return {
    passed,
    status: res.statusCode,
    message: res.payload?.message,
    lookedUp: [...lookedUp],
  };
};

// ===================================================================
// 1. The mapping itself
// ===================================================================

test("pageKey maps to its own CMS menu, not to another page's", () => {
  assert.equal(menuUrlForPageKey("faqs"), "/cms/faqs");
  assert.equal(menuUrlForPageKey("home"), "/cms/home");
  assert.equal(menuUrlForPageKey("footer"), "/cms/footer");
  assert.notEqual(menuUrlForPageKey("faqs"), "/cms/pricing");
});

test("collectionKey maps to its own CMS menu; 'plans' is the Pricing screen", () => {
  assert.equal(menuUrlForCollectionKey("faqs"), "/cms/faqs");
  assert.equal(menuUrlForCollectionKey("plans"), "/cms/pricing");
  assert.equal(menuUrlForCollectionKey("classes"), "/cms/classes");
  // `transformations` got a screen of its own after the original twelve, so it
  // now resolves to a real row instead of the all-pages fallback. Pinned here
  // because the whole point of giving it a screen was the narrower permission.
  assert.equal(
    menuUrlForCollectionKey("transformations"),
    "/cms/transformations",
  );
  assert.notEqual(menuUrlForCollectionKey("faqs"), "/cms/pricing");
});

test("keys are normalised: whitespace and case cannot dodge the mapping", () => {
  assert.equal(menuUrlForPageKey("  FAQs "), "/cms/faqs");
  assert.equal(menuUrlForCollectionKey("PLANS"), "/cms/pricing");
});

test("an unmapped key falls back to the all-pages permission, never to none", () => {
  // Neither collectionKey nor pageKey is an enum, so a key invented in the data
  // must still land on a REAL check rather than on no check at all. This used to
  // be demonstrated with `transformations`; that key now has its own screen, so
  // the case is made with a list that genuinely has no row.
  assert.equal(
    menuUrlForCollectionKey("a-list-invented-tomorrow"),
    CMS_FALLBACK_MENU_URL,
  );
  assert.equal(menuUrlForCollectionKey(undefined), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForPageKey("a-page-invented-tomorrow"), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForPageKey(undefined), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForPageKey(null), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForPageKey({ $ne: null }), CMS_FALLBACK_MENU_URL);
});

test("the seeded tree and the two key maps cannot drift apart", () => {
  const leaves = cmsLeafMenuUrls();
  assert.equal(new Set(leaves).size, leaves.length, "duplicate menuUrl in the tree");

  // Every URL either map can produce must be a row the seed actually creates,
  // or checkPermission resolves nothing and the fallback silently takes over.
  for (const url of [
    ...Object.values(CMS_PAGE_MENUS),
    ...Object.values(CMS_COLLECTION_MENUS),
  ]) {
    assert.ok(leaves.includes(url), `${url} is mapped but never seeded`);
  }

  // And the routes the restructure specified are all present — the original
  // twelve plus /cms/transformations, added when the before/after gallery was
  // given a screen instead of living on the all-pages grant.
  assert.deepEqual(
    [...leaves].sort(),
    [
      "/cms/about",
      "/cms/classes",
      "/cms/contact",
      "/cms/faqs",
      "/cms/footer",
      "/cms/header",
      "/cms/home",
      "/cms/pricing",
      "/cms/programs",
      "/cms/social",
      "/cms/testimonials",
      "/cms/trainers",
      "/cms/transformations",
    ],
    "the CMS tree no longer matches the specified routes",
  );

  const parent = CMS_MENU_TREE.find((r) => r.menuName === "Content Management");
  assert.ok(parent, "the Content Management parent row is missing");
  assert.equal(parent.menuUrl, "#", "a parent row must not carry a real path");
  assert.equal(parent.children.length, 7);
});

// ===================================================================
// 2. Editing FAQs checks /cms/faqs and not /cms/pricing
// ===================================================================

test("editing a FAQs list row checks /cms/faqs — and never /cms/pricing", async () => {
  const req = staff({ "/cms/faqs": ["edit"] }, { params: { id: "row-1" } });
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, true, "a faqs editor must be allowed to edit a faq");
  assert.ok(result.lookedUp.includes("/cms/faqs"));
  assert.ok(
    !result.lookedUp.includes("/cms/pricing"),
    "the pricing permission must never be consulted for a faqs edit",
  );
});

test("the same faqs-only editor is refused a pricing row", async () => {
  const req = staff({ "/cms/faqs": ["edit"] }, { params: { id: "row-2" } });
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "plans" },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.match(result.message, /\/cms\/pricing/, "the 403 must name the page");
  assert.ok(result.lookedUp.includes("/cms/pricing"));
  assert.ok(
    !result.lookedUp.includes("/cms/faqs"),
    "a pricing edit must not be satisfiable by a faqs grant",
  );
});

test("a pricing-only editor is refused a FAQ row — the mirror case", async () => {
  const req = staff({ "/cms/pricing": ["edit"] }, { params: { id: "row-3" } });
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
});

// ===================================================================
// 3. Super admin bypass
// ===================================================================

test("a super admin bypasses entirely — no menu is even resolved", async () => {
  const req = superAdmin({ params: { id: "row-4" } });
  const result = await run(
    cmsPermission("delete", siteItemDocTargets),
    req,
    { collectionKey: "plans" },
  );

  assert.equal(result.passed, true);
  assert.deepEqual(
    result.lookedUp,
    [],
    "the super-admin short-circuit must happen before any lookup, as checkPermission does",
  );
});

test("a super admin bypasses the content routes too, with no session permissions", async () => {
  const req = superAdmin({ body: { pageKey: "footer" } });
  const result = await run(cmsPermission("write", siteContentCreateTargets), req);

  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, []);
});

// ===================================================================
// 4. /website-pages is the "all CMS pages" grant
// ===================================================================

test("/website-pages still authorises every CMS page, so nothing that works today breaks", async () => {
  for (const collectionKey of ["faqs", "plans", "trainers", "classes"]) {
    const req = staff({ "/website-pages": ["edit"] }, { params: { id: "row-5" } });
    const result = await run(
      cmsPermission("edit", siteItemDocTargets),
      req,
      { collectionKey },
    );
    assert.equal(result.passed, true, `/website-pages must cover ${collectionKey}`);
  }
});

test("the fallback is per-ACTION, not a blanket pass", async () => {
  // Holding read on /website-pages does not authorise a delete anywhere.
  const req = staff({ "/website-pages": ["read"] }, { params: { id: "row-6" } });
  const result = await run(
    cmsPermission("delete", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
});

test("an unseeded /cms/* row degrades to today's behaviour rather than locking everyone out", async () => {
  // Simulates the deploy window before scripts/seedCmsMenus.js has been run:
  // the per-page row does not resolve, and the existing grant carries the write.
  const saved = MENU_IDS["/cms/faqs"];
  delete MENU_IDS["/cms/faqs"];
  try {
    const req = staff({ "/website-pages": ["edit"] }, { params: { id: "row-7" } });
    const result = await run(
      cmsPermission("edit", siteItemDocTargets),
      req,
      { collectionKey: "faqs" },
    );
    assert.equal(result.passed, true);
  } finally {
    MENU_IDS["/cms/faqs"] = saved;
  }
});

test("a role holding some OTHER permission is refused, after trying page then fallback", async () => {
  // Granted a non-CMS screen, so the session has a non-empty permission list
  // and takes the normal path — the interesting case, because it proves the
  // order of the two lookups.
  const req = staff({ "/seo-manager": ["edit"] }, { params: { id: "row-8" } });
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.deepEqual(result.lookedUp, ["/cms/faqs", "/website-pages"]);
});

test("a role with NO permissions at all is refused before any menu is resolved", async () => {
  // Same wording and same short-circuit as checkPermission: an empty permission
  // list means "this role was never configured", which is a different problem
  // from "this role lacks this page" and says so.
  const req = staff({}, { params: { id: "row-8b" } });
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.equal(result.message, "No permissions found for this role");
  assert.deepEqual(result.lookedUp, []);
});

// ===================================================================
// 5. PUT / DELETE — the key comes from the stored document
// ===================================================================

test("PUT/DELETE derive the page from the STORED row, because the body has no key", async () => {
  const req = staff({ "/cms/footer": ["edit"] }, { params: { id: "block-1" } });
  const result = await run(
    cmsPermission("edit", siteContentDocTargets),
    req,
    { pageKey: "footer" }, // nothing in the body says "footer"
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, ["/cms/footer"]);
});

test("DELETE uses the delete flag on the stored row's page", async () => {
  const granted = staff({ "/cms/social": ["delete"] }, { params: { id: "block-2" } });
  const allowed = await run(
    cmsPermission("delete", siteContentDocTargets),
    granted,
    { pageKey: "social" },
  );
  assert.equal(allowed.passed, true);

  const editOnly = staff({ "/cms/social": ["edit"] }, { params: { id: "block-2" } });
  const refused = await run(
    cmsPermission("delete", siteContentDocTargets),
    editOnly,
    { pageKey: "social" },
  );
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
});

test("moving a block to another page requires BOTH pages — not just the one it is leaving", async () => {
  // updateSiteContent lets pageKey change. Checking only the stored key would
  // make "edit a FAQ" a way to write onto the home page.
  const req = staff(
    { "/cms/faqs": ["edit"] },
    { params: { id: "block-3" }, body: { pageKey: "home" } },
  );
  const result = await run(
    cmsPermission("edit", siteContentDocTargets),
    req,
    { pageKey: "faqs" },
  );

  assert.equal(result.passed, false, "a move must not be an escalation");
  assert.equal(result.status, 403);
  assert.match(result.message, /\/cms\/home/);
});

test("the same move succeeds when both pages are granted", async () => {
  const req = staff(
    { "/cms/faqs": ["edit"], "/cms/home": ["edit"] },
    { params: { id: "block-4" }, body: { pageKey: "home" } },
  );
  const result = await run(
    cmsPermission("edit", siteContentDocTargets),
    req,
    { pageKey: "faqs" },
  );

  assert.equal(result.passed, true);
  assert.deepEqual([...result.lookedUp].sort(), ["/cms/faqs", "/cms/home"]);
});

test("moving a LIST row between collections requires both collections", async () => {
  const req = staff(
    { "/cms/faqs": ["edit"] },
    { params: { id: "row-9" }, body: { collectionKey: "plans" } },
  );
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /\/cms\/pricing/);
});

test("a body key identical to the stored key is not queried twice", async () => {
  const req = staff(
    { "/cms/faqs": ["edit"] },
    { params: { id: "row-10" }, body: { collectionKey: "FAQs" } },
  );
  const result = await run(
    cmsPermission("edit", siteItemDocTargets),
    req,
    { collectionKey: "faqs" },
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, ["/cms/faqs"]);
});

test("a row that no longer exists falls back to the all-pages permission", async () => {
  // We cannot know which page a missing row belonged to, and answering 404 from
  // the middleware would let an ungranted account probe which CMS ids exist.
  const granted = staff({ "/website-pages": ["delete"] }, { params: { id: "gone" } });
  const allowed = await run(
    cmsPermission("delete", siteItemDocTargets),
    granted,
    null,
  );
  assert.equal(allowed.passed, true, "the controller should get to answer its own 404");
  assert.deepEqual(allowed.lookedUp, ["/website-pages"]);

  const narrow = staff({ "/cms/faqs": ["delete"] }, { params: { id: "gone" } });
  const refused = await run(cmsPermission("delete", siteItemDocTargets), narrow, null);
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
});

test("a malformed id is treated as not-found, not as an authorisation answer", async () => {
  const saved = SiteItem.findById;
  SiteItem.findById = () => ({
    select: () => ({
      lean: async () => {
        const err = new Error("Cast to ObjectId failed");
        err.name = "CastError";
        throw err;
      },
    }),
  });
  try {
    const req = staff({ "/website-pages": ["edit"] }, { params: { id: "not-an-id" } });
    const result = await run(cmsPermission("edit", siteItemDocTargets), req);
    assert.equal(result.passed, true);
    assert.deepEqual(result.lookedUp, ["/website-pages"]);
  } finally {
    SiteItem.findById = saved;
  }
});

// ===================================================================
// 6. Create and list — the key comes from the body
// ===================================================================

test("create checks the page named in the body", async () => {
  const req = staff({ "/cms/header": ["write"] }, { body: { pageKey: "header" } });
  const result = await run(cmsPermission("write", siteContentCreateTargets), req);

  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, ["/cms/header"]);
});

test("create into a page you were not granted is refused", async () => {
  const req = staff({ "/cms/header": ["write"] }, { body: { pageKey: "home" } });
  const result = await run(cmsPermission("write", siteContentCreateTargets), req);

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
});

test("a list scoped to one page checks that page, in both body shapes the controllers accept", async () => {
  for (const body of [
    { pageKey: "faqs" },
    { match: { pageKey: "faqs" } },
    { match: { pageKey: "faqs", match: "hours" } },
  ]) {
    const req = staff({ "/cms/faqs": ["read"] }, { body });
    const result = await run(cmsPermission("read", siteContentListTargets), req);
    assert.equal(result.passed, true, `body shape not handled: ${JSON.stringify(body)}`);
    assert.deepEqual(result.lookedUp, ["/cms/faqs"]);
  }
});

test("the list resolver mirrors the controller's precedence: top level beats nested", async () => {
  // listSiteContentByParams narrows to the TOP-LEVEL pageKey when both are
  // sent. If this resolver preferred the nested one, the request would be
  // authorised against faqs and answered with home.
  const req = staff(
    { "/cms/faqs": ["read"] },
    { body: { pageKey: "home", match: { pageKey: "faqs" } } },
  );
  const result = await run(cmsPermission("read", siteContentListTargets), req);

  assert.equal(result.passed, false, "it must check the page actually returned");
  assert.ok(result.lookedUp.includes("/cms/home"));
});

test("an unscoped list — every page at once — takes the all-pages permission", async () => {
  const narrow = staff({ "/cms/faqs": ["read"] }, { body: { per_page: 500 } });
  const refused = await run(cmsPermission("read", siteContentListTargets), narrow);
  assert.equal(refused.passed, false);
  assert.deepEqual(refused.lookedUp, ["/website-pages"]);

  const broad = staff({ "/website-pages": ["read"] }, { body: { per_page: 500 } });
  const allowed = await run(cmsPermission("read", siteContentListTargets), broad);
  assert.equal(allowed.passed, true);
});

test("a free-text list search is unscoped, and is not mistaken for a page key", async () => {
  const req = staff({ "/website-pages": ["read"] }, { body: { match: "pricing" } });
  const result = await run(cmsPermission("read", siteItemListTargets), req);

  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, ["/website-pages"]);
});

test("list and create on SiteItem resolve the list's own screen", async () => {
  const list = staff({ "/cms/trainers": ["read"] }, { body: { collectionKey: "trainers" } });
  assert.equal((await run(cmsPermission("read", siteItemListTargets), list)).passed, true);

  const create = staff({ "/cms/pricing": ["write"] }, { body: { collectionKey: "plans" } });
  const created = await run(cmsPermission("write", siteItemCreateTargets), create);
  assert.equal(created.passed, true);
  assert.deepEqual(created.lookedUp, ["/cms/pricing"]);
});

// ===================================================================
// 7. Session plumbing
// ===================================================================

test("an anonymous request is 401, not 403", async () => {
  const req = { session: {}, body: {}, params: {}, query: {}, headers: {} };
  const result = await run(cmsPermission("read", siteContentListTargets), req);

  assert.equal(result.passed, false);
  assert.equal(result.status, 401);
  assert.equal(result.message, "Not logged in");
});

test("permissions are read from req.session.user, never from req.user", async () => {
  // req.user is built by authMiddleware from id/role/email/name only. A
  // middleware reading it would find no permissions and deny everything — or,
  // worse, read undefined and conclude "unrestricted".
  const req = staff({ "/cms/home": ["edit"] }, { params: { id: "block-5" } });
  req.user.permissions = [
    { menuId: MENU_IDS["/cms/pricing"], edit: true },
  ];

  const result = await run(
    cmsPermission("edit", siteContentDocTargets),
    req,
    { pageKey: "home" },
  );
  assert.equal(result.passed, true, "the session grant must be the one that counts");

  const decoy = staff({}, { params: { id: "block-6" } });
  decoy.user.permissions = [{ menuId: MENU_IDS["/cms/home"], edit: true }];
  const refused = await run(
    cmsPermission("edit", siteContentDocTargets),
    decoy,
    { pageKey: "home" },
  );
  assert.equal(refused.passed, false, "a grant on req.user must authorise nothing");
});

// ===================================================================
// 8. checkPermission parity
//
// checkPermission was refactored onto the same two helpers cmsPermission uses
// (ensurePermissionsFresh + hasMenuPermission) so the CMS path could resolve two
// menus without paying twice for the session refresh. That file gates well over
// two hundred routes, so its four outcomes — and their exact messages, which the
// admin panel surfaces to the user — are pinned here.
// ===================================================================

test("checkPermission: the super admin bypasses before any lookup", async () => {
  const result = await run(checkPermission("/employee", "delete"), superAdmin());
  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, []);
});

test("checkPermission: anonymous is 401 'Not logged in'", async () => {
  const req = { session: {}, body: {}, params: {}, query: {}, headers: {} };
  const result = await run(checkPermission("/employee", "read"), req);
  assert.equal(result.status, 401);
  assert.equal(result.message, "Not logged in");
});

test("checkPermission: an unseeded menu row is the distinctive 'not found' 403", async () => {
  const req = staff({ "/seo-manager": ["read"] });
  const result = await run(checkPermission("/never-seeded", "read"), req);
  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.equal(result.message, "Menu '/never-seeded' not found");
});

test("checkPermission: a granted action passes, an ungranted one is the module 403", async () => {
  const granted = staff({ "/seo-manager": ["read"] });
  assert.equal((await run(checkPermission("/seo-manager", "read"), granted)).passed, true);

  const ungranted = staff({ "/seo-manager": ["read"] });
  const refused = await run(checkPermission("/seo-manager", "delete"), ungranted);
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
  assert.equal(
    refused.message,
    "Access denied — no 'delete' permission for this module",
  );
});

test("checkPermission: an empty permission list is the role-level 403", async () => {
  const req = staff({});
  const result = await run(checkPermission("/seo-manager", "read"), req);
  assert.equal(result.status, 403);
  assert.equal(result.message, "No permissions found for this role");
  assert.deepEqual(result.lookedUp, []);
});
