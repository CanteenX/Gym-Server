/**
 * OFFLINE tests for announcements and banners (models/SiteNotice.js).
 *
 * Run:  node --test scripts/tests/siteNotice.test.mjs
 *
 * NO DATABASE, following scripts/tests/scoping.test.mjs and
 * scripts/tests/cmsPermission.test.mjs: Mongoose schemas compile without a
 * connection, so the real model, the real controller and the real permission
 * middleware are imported and the model's static query methods are replaced
 * with stubs that CAPTURE THE FILTER and return fixtures. The capture is the
 * point — what these tests assert is which filter actually reached Mongo, which
 * is the only thing standing between a scheduled notice and the public website.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE.
 * Two failures here are silent, and one of them has already happened.
 *
 *   1. THE ONE THAT HAPPENED. The owner set a two-minute window on a notice and
 *      it vanished after two minutes. That was correct — but it is only ever
 *      correct if the ADMIN BADGE and the PUBLIC FILTER read the same rule. If
 *      they drift, the panel says "live" while the site serves nothing, and
 *      nothing throws, logs, or looks wrong in either file, because both halves
 *      are individually plausible. The first block below pins them to the same
 *      expression.
 *   2. THE LEAK. If the public endpoint's filter stopped requiring the live
 *      window, a notice scheduled for next month, or one that expired in March,
 *      would render on midcitygym.in — and because the frontend caches under
 *      ISR, it would keep rendering long after anyone edited the row. A page
 *      that is stale in the right direction looks exactly like a page that is
 *      fresh.
 */
import test from "node:test";
import assert from "node:assert/strict";

import SiteNotice, {
  NOTICE_KINDS,
  NOTICE_TONES,
  NOTICE_PLACEMENTS,
  liveWindowFilter,
  isCurrentlyLive,
  liveStatus,
} from "../../models/SiteNotice.js";
import Advertisement, {
  liveWindowFilter as adLiveWindowFilter,
  isCurrentlyLive as adIsCurrentlyLive,
} from "../../models/Advertisement.js";

import MenuMaster from "../../models/MenuMaster.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";

import {
  getPublicNotices,
  listSiteNoticesByParams,
} from "../../controllers/v1/siteNotice.controller.js";
import {
  cmsPermission,
  siteNoticeListTargets,
  siteNoticeCreateTargets,
  siteNoticeDocTargets,
} from "../../middlewares/cmsPermission.js";
import {
  CMS_NOTICE_MENUS,
  CMS_FALLBACK_MENU_URL,
  menuUrlForNoticeKind,
  cmsLeafMenuUrls,
} from "../../config/cmsMenus.js";

// ===================================================================
// Harness
// ===================================================================

/** A fixed clock, so "now" is never a moving target mid-assertion. */
const NOW = new Date("2026-09-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const before = (ms) => new Date(NOW.getTime() - ms);
const after = (ms) => new Date(NOW.getTime() + ms);

/** The filter the last SiteNotice.find() was given. */
let capturedFilter = null;
/** The projection string the last .select() was given. */
let capturedSelect = null;
/** Rows the stubbed find() resolves with. */
let findResult = [];

SiteNotice.find = (filter) => {
  capturedFilter = filter;
  const chain = {
    select: (fields) => {
      capturedSelect = fields;
      return chain;
    },
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => findResult,
  };
  return chain;
};
SiteNotice.countDocuments = async () => findResult.length;

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
 * Calls a controller and returns the filter it built plus its response.
 *
 * @returns {Promise<{filter: object|null, select: string|null, body: object}>}
 */
const callController = async (handler, req, rows = []) => {
  capturedFilter = null;
  capturedSelect = null;
  findResult = rows;
  const res = makeRes();
  await handler(req, res);
  return { filter: capturedFilter, select: capturedSelect, body: res.payload };
};

// ===================================================================
// 1. THE LIVE WINDOW — the rule the owner's two-minute advert proved works,
//    and which must now be shared rather than copied.
// ===================================================================

test("there is exactly ONE definition of 'currently live' in the codebase", () => {
  /**
   * IDENTITY, not equivalence. Two functions that behave the same today are
   * precisely what drifts tomorrow — the advert comment has always said never to
   * re-write the rule inline, and a second content type is exactly the moment
   * somebody would. Asserting the SAME function object makes a copy impossible
   * to introduce without failing here.
   */
  assert.equal(liveWindowFilter, adLiveWindowFilter);
  assert.equal(isCurrentlyLive, adIsCurrentlyLive);
});

test("liveWindowFilter requires isActive AND both open-ended date bounds", () => {
  const filter = liveWindowFilter(NOW);

  assert.equal(filter.isActive, true, "an inactive row is never live");

  /**
   * BOTH bounds must be $or-ed against null, and they must sit inside $and. Two
   * top-level $or keys cannot coexist in one object — the second would silently
   * overwrite the first, and whichever bound lost would stop being enforced.
   * That is a leak that reads as perfectly normal code.
   */
  assert.equal(filter.$and.length, 2);
  assert.deepEqual(filter.$and[0], {
    $or: [{ startAt: null }, { startAt: { $lte: NOW } }],
  });
  assert.deepEqual(filter.$and[1], {
    $or: [{ endAt: null }, { endAt: { $gte: NOW } }],
  });
});

test("isCurrentlyLive: scheduled / live / expired / open-ended / switched off", () => {
  // OPEN-ENDED — neither date set. The common case, and it must not require
  // picking arbitrary dates to be visible.
  assert.equal(
    isCurrentlyLive({ isActive: true, startAt: null, endAt: null }, NOW),
    true,
  );

  // LIVE — inside a closed window.
  assert.equal(
    isCurrentlyLive(
      { isActive: true, startAt: before(HOUR), endAt: after(HOUR) },
      NOW,
    ),
    true,
  );

  // SCHEDULED — starts later. This must NEVER reach the public site.
  assert.equal(
    isCurrentlyLive({ isActive: true, startAt: after(HOUR), endAt: null }, NOW),
    false,
  );

  // EXPIRED — ended already. THE GANESH CHATURTHI CASE: a closure notice whose
  // window has passed must stop rendering, or members read a stale closure.
  assert.equal(
    isCurrentlyLive({ isActive: true, startAt: before(2 * HOUR), endAt: before(HOUR) }, NOW),
    false,
  );

  // OPEN START, future end — running now, stops later.
  assert.equal(
    isCurrentlyLive({ isActive: true, startAt: null, endAt: after(HOUR) }, NOW),
    true,
  );

  // OPEN END, past start — started, runs until switched off.
  assert.equal(
    isCurrentlyLive({ isActive: true, startAt: before(HOUR), endAt: null }, NOW),
    true,
  );

  // THE KILL SWITCH beats a perfectly valid window. isActive is independent of
  // the dates on purpose: "take it down now" must not require editing dates.
  assert.equal(
    isCurrentlyLive(
      { isActive: false, startAt: before(HOUR), endAt: after(HOUR) },
      NOW,
    ),
    false,
  );
});

test("the two-minute window the owner actually set behaves exactly as set", () => {
  // The incident, reproduced: a notice given a two-minute life.
  const start = new Date(NOW.getTime());
  const end = new Date(NOW.getTime() + 2 * 60 * 1000);
  const row = { isActive: true, startAt: start, endAt: end };

  // A second before it opens: scheduled, invisible.
  assert.equal(isCurrentlyLive(row, before(1000)), false);
  assert.equal(liveStatus(row, before(1000)), "SCHEDULED");

  // During: live.
  assert.equal(isCurrentlyLive(row, new Date(NOW.getTime() + 60 * 1000)), true);
  assert.equal(liveStatus(row, new Date(NOW.getTime() + 60 * 1000)), "LIVE");

  // A second after it closes: expired, and it must GO. This is the behaviour
  // that surprised the owner, and it is correct — the fix is the admin badge
  // telling them so, not loosening the rule.
  assert.equal(isCurrentlyLive(row, new Date(end.getTime() + 1000)), false);
  assert.equal(liveStatus(row, new Date(end.getTime() + 1000)), "EXPIRED");
});

test("boundary instants are INCLUSIVE at both ends, matching $lte/$gte", () => {
  /**
   * The in-memory check and the Mongo filter must agree about a row sitting
   * exactly on its own boundary. The filter uses $lte/$gte, so the predicate
   * must use > and < (not >= and <=) — getting that backwards makes the admin
   * badge and the public endpoint disagree for exactly one second, which is
   * unreproducible by hand and therefore never gets fixed.
   */
  assert.equal(isCurrentlyLive({ isActive: true, startAt: NOW, endAt: null }, NOW), true);
  assert.equal(isCurrentlyLive({ isActive: true, startAt: null, endAt: NOW }, NOW), true);
});

test("liveStatus explains WHY a row is not live, and never contradicts isCurrentlyLive", () => {
  const cases = [
    [{ isActive: true, startAt: null, endAt: null }, "LIVE"],
    [{ isActive: true, startAt: after(HOUR), endAt: null }, "SCHEDULED"],
    [{ isActive: true, startAt: null, endAt: before(HOUR) }, "EXPIRED"],
    // Switched off wins over the dates: the fix is "switch it on", not "wait".
    [{ isActive: false, startAt: after(HOUR), endAt: null }, "INACTIVE"],
    [{ isActive: false, startAt: null, endAt: null }, "INACTIVE"],
  ];

  for (const [row, expected] of cases) {
    assert.equal(liveStatus(row, NOW), expected);
    assert.equal(
      liveStatus(row, NOW) === "LIVE",
      isCurrentlyLive(row, NOW),
      "the badge and the predicate disagree about this row",
    );
  }
});

// ===================================================================
// 2. THE PUBLIC ENDPOINT — kind and placement filtering, and the guarantee
//    that a non-live row can never reach it.
// ===================================================================

test("GET /site/notices ALWAYS applies the live window, whatever else is asked", async () => {
  /**
   * THE LEAK THIS PINS: if the window were applied only when no kind was
   * supplied (an easy refactor to make), then the one call the frontend
   * actually makes — always with a kind — would be the one call that leaks
   * expired notices. And it would leak them into an ISR cache.
   */
  for (const query of [{}, { kind: "ANNOUNCEMENT" }, { kind: "BANNER", placement: "HOME_TOP" }]) {
    const { filter } = await callController(getPublicNotices, { query });
    assert.equal(filter.isActive, true, `no isActive for ${JSON.stringify(query)}`);
    assert.equal(filter.$and.length, 2, `no date bounds for ${JSON.stringify(query)}`);
    assert.ok(filter.$and[0].$or.some((c) => c.startAt?.$lte));
    assert.ok(filter.$and[1].$or.some((c) => c.endAt?.$gte));
  }
});

test("?kind filters to that kind and nothing else", async () => {
  const ann = await callController(getPublicNotices, {
    query: { kind: "ANNOUNCEMENT" },
  });
  assert.equal(ann.filter.kind, "ANNOUNCEMENT");
  assert.equal(ann.filter.placement, undefined, "an announcement has no placement");

  const ban = await callController(getPublicNotices, { query: { kind: "BANNER" } });
  assert.equal(ban.filter.kind, "BANNER");
});

test("?kind is case- and whitespace-tolerant, because a URL is typed by hand", async () => {
  const { filter } = await callController(getPublicNotices, {
    query: { kind: "  announcement " },
  });
  assert.equal(filter.kind, "ANNOUNCEMENT");
});

test("an UNKNOWN kind returns [] rather than everything", async () => {
  /**
   * A typo must narrow to nothing, never widen to everything. The opposite
   * behaviour ("unrecognised filter, so ignore it") is how a draft banner ends
   * up on the home page: the frontend asks for one kind, gets both, and renders
   * whatever came back.
   */
  const { filter, body } = await callController(getPublicNotices, {
    query: { kind: "ANNOUNCEMENTS" },
  });
  assert.equal(filter, null, "no query should have been issued at all");
  assert.equal(body.isOk, true);
  assert.deepEqual(body.data, []);
});

test("?kind=BANNER&placement=HOME_TOP filters on BOTH", async () => {
  const { filter } = await callController(getPublicNotices, {
    query: { kind: "BANNER", placement: "HOME_TOP" },
  });
  assert.equal(filter.kind, "BANNER");
  assert.equal(filter.placement, "HOME_TOP");
});

test("every declared placement is accepted, and an undeclared one returns []", async () => {
  for (const placement of NOTICE_PLACEMENTS) {
    const { filter } = await callController(getPublicNotices, {
      query: { kind: "BANNER", placement },
    });
    assert.equal(filter.placement, placement, `${placement} was not accepted`);
  }

  // SIDEBAR and FOOTER are ADVERT placements (AD_PLACEMENTS), not banner ones —
  // a banner is a full-width slab, so those slots are meaningless here. The
  // vocabularies deliberately look alike and are deliberately separate lists.
  for (const wrong of ["SIDEBAR", "FOOTER", "HOME_HERO", "NOT_A_SLOT"]) {
    const { filter, body } = await callController(getPublicNotices, {
      query: { kind: "BANNER", placement: wrong },
    });
    assert.equal(filter, null, `${wrong} should not have produced a query`);
    assert.deepEqual(body.data, []);
  }
});

test("kind=ANNOUNCEMENT with a placement returns [], the honest answer", async () => {
  /**
   * A contradictory question. The model forces placement to null on every
   * announcement, so this combination genuinely matches nothing — and the
   * filter says so rather than dropping one of the two conditions the caller
   * asked for, which would answer a question nobody posed.
   */
  const { filter } = await callController(getPublicNotices, {
    query: { kind: "ANNOUNCEMENT", placement: "HOME_TOP" },
  });
  assert.equal(filter.kind, "ANNOUNCEMENT");
  assert.equal(filter.placement, "HOME_TOP");
});

test("the public projection publishes the render fields and nothing else", async () => {
  const { select } = await callController(getPublicNotices, {
    query: { kind: "ANNOUNCEMENT" },
  });
  for (const field of [
    "kind",
    "title",
    "body",
    "tone",
    "imageUrl",
    "ctaLabel",
    "ctaUrl",
    "placement",
    "dismissible",
    "sortOrder",
  ]) {
    assert.ok(select.includes(field), `${field} is missing from the public read`);
  }
  // An explicit projection means a field added to the schema later cannot
  // silently start appearing on the public website.
  assert.ok(!select.includes("isActive"));
  assert.ok(!select.includes("startAt"));
  assert.ok(!select.includes("endAt"));
});

// ===================================================================
// 3. THE ADMIN LIST — the badge, and the filter/permission agreement.
// ===================================================================

test("the admin list shows scheduled and expired rows, and labels each one", async () => {
  /**
   * THE ADMIN LIST IS THE OPPOSITE OF THE PUBLIC ONE and must stay so: the
   * owner cannot fix a mis-set date on a row the panel hides from them. That is
   * precisely the position the two-minute advert left them in.
   */
  /**
   * FAR dates, not NOW-relative ones. This controller derives its badge from
   * the real clock (as it must — the panel is asking "is this live right now"),
   * so a fixture an hour either side of a hardcoded NOW would pass or fail
   * depending on what time of day the suite runs. That is the flake that gets
   * a test deleted rather than fixed.
   */
  const rows = [
    { _id: "1", title: "Live", isActive: true, startAt: null, endAt: null },
    {
      _id: "2",
      title: "Scheduled",
      isActive: true,
      startAt: new Date("2099-01-01T00:00:00.000Z"),
      endAt: null,
    },
    {
      _id: "3",
      title: "Expired",
      isActive: true,
      startAt: null,
      endAt: new Date("2020-01-01T00:00:00.000Z"),
    },
    { _id: "4", title: "Off", isActive: false, startAt: null, endAt: null },
  ];
  const { filter, body } = await callController(
    listSiteNoticesByParams,
    { body: {} },
    rows,
  );

  assert.equal(filter.isActive, undefined, "the admin list must not hide rows");
  assert.equal(filter.$and, undefined, "the admin list must not apply the window");

  const listed = body.data[0].data;
  assert.equal(listed.length, 4);
  assert.deepEqual(
    listed.map((r) => r.status),
    ["LIVE", "SCHEDULED", "EXPIRED", "INACTIVE"],
  );
  assert.deepEqual(
    listed.map((r) => r.isLive),
    [true, false, false, false],
  );
});

test("the admin list's kind filter takes the SAME key the permission check read", async () => {
  /**
   * MIRRORS middlewares/cmsPermission.js readKindFromListBody: top-level `kind`
   * wins over the nested `match.kind`. If the two ever picked differently, a
   * request would be authorised against /cms/announcements and answered with
   * banners — the exact client/server disagreement cmsPermission exists to
   * remove, and one no amount of careful reading catches.
   */
  const topLevelWins = await callController(
    listSiteNoticesByParams,
    { body: { kind: "BANNER", match: { kind: "ANNOUNCEMENT" } } },
    [],
  );
  assert.equal(topLevelWins.filter.kind, "BANNER");

  const nested = await callController(
    listSiteNoticesByParams,
    { body: { match: { kind: "ANNOUNCEMENT" } } },
    [],
  );
  assert.equal(nested.filter.kind, "ANNOUNCEMENT");

  // And the permission middleware derives the same answer from the same bodies.
  assert.deepEqual(
    await siteNoticeListTargets({ body: { kind: "BANNER", match: { kind: "ANNOUNCEMENT" } } }),
    ["/cms/banners"],
  );
  assert.deepEqual(
    await siteNoticeListTargets({ body: { match: { kind: "ANNOUNCEMENT" } } }),
    ["/cms/announcements"],
  );
});

// ===================================================================
// 4. THE MODEL'S KIND-CONDITIONAL RULES.
// ===================================================================

/** Validates a doc through the real schema, returning the error message or "". */
const validationError = async (attrs) => {
  const doc = new SiteNotice(attrs);
  try {
    await doc.validate();
    return "";
  } catch (err) {
    return err?.message || "unknown";
  }
};

test("an ANNOUNCEMENT requires a body — a headline is not news", async () => {
  // "Ganesh Chaturthi Leave" with no body does not tell anybody which days the
  // gym is shut. That is the whole content of an announcement.
  const err = await validationError({
    kind: "ANNOUNCEMENT",
    title: "Ganesh Chaturthi Leave",
  });
  assert.match(err, /body/i);

  assert.equal(
    await validationError({
      kind: "ANNOUNCEMENT",
      title: "Ganesh Chaturthi Leave",
      body: "Closed Fri 5 Sep. Back to normal hours Sat 6 Sep.",
    }),
    "",
  );
});

test("an ANNOUNCEMENT is site-wide: a supplied placement is dropped, not rejected", async () => {
  const doc = new SiteNotice({
    kind: "ANNOUNCEMENT",
    title: "Holiday hours",
    body: "We close at 2pm on Sunday.",
    placement: "HOME_TOP",
  });
  await doc.validate();
  // Forced to null rather than 400'd: a placement on an announcement is a
  // leftover from a shared admin form, not a hostile input.
  assert.equal(doc.placement, null);
});

test("a BANNER requires a placement, and is never dismissible", async () => {
  const err = await validationError({ kind: "BANNER", title: "20% off annual plans" });
  assert.match(err, /placement/i);

  const doc = new SiteNotice({
    kind: "BANNER",
    title: "20% off annual plans",
    placement: "HOME_TOP",
    dismissible: true,
  });
  await doc.validate();
  // A promo a visitor can close is a promo that is never seen twice.
  assert.equal(doc.dismissible, false);
  // A banner needs no body — the picture and the button are the message.
  assert.equal(doc.body, "");
});

test("a window that ends before it starts is refused at the model", async () => {
  // Such a row is never live and would sit in the list looking scheduled
  // forever. Caught in the schema so no code path — seed, import, endpoint —
  // can store one.
  const err = await validationError({
    kind: "ANNOUNCEMENT",
    title: "Backwards",
    body: "…",
    startAt: after(HOUR),
    endAt: before(HOUR),
  });
  assert.match(err, /endAt/);
});

test("kind, tone and placement are closed enums", async () => {
  assert.match(await validationError({ kind: "ADVERT", title: "x", body: "y" }), /kind/i);
  assert.match(
    await validationError({ kind: "ANNOUNCEMENT", title: "x", body: "y", tone: "PANIC" }),
    /tone/i,
  );
  assert.match(
    await validationError({ kind: "BANNER", title: "x", placement: "SIDEBAR" }),
    /placement/i,
  );

  assert.deepEqual(NOTICE_KINDS, ["ANNOUNCEMENT", "BANNER"]);
  assert.deepEqual(NOTICE_TONES, ["INFO", "SUCCESS", "WARNING", "URGENT"]);
  assert.deepEqual(NOTICE_PLACEMENTS, [
    "HOME_TOP",
    "HOME_MID",
    "PROGRAMS_TOP",
    "CONTACT_TOP",
  ]);
});

test("tone defaults to INFO — the quiet option, not the loud one", async () => {
  const doc = new SiteNotice({ kind: "ANNOUNCEMENT", title: "x", body: "y" });
  await doc.validate();
  assert.equal(doc.tone, "INFO");
  assert.equal(doc.dismissible, true, "a read announcement should be closeable");
  assert.equal(doc.isActive, true);
  assert.equal(doc.startAt, null);
  assert.equal(doc.endAt, null);
});

test("SiteNotice is NOT the Advertisement collection", () => {
  // Separate models, separate collections. The owner's closure notice rendered
  // under a "Sponsored" heading because there was only one scheduled content
  // type; merging them again would reintroduce exactly that.
  assert.notEqual(SiteNotice.modelName, Advertisement.modelName);
  assert.equal(SiteNotice.modelName, "SiteNotice");
});

// ===================================================================
// 5. PERMISSIONS — the kind is the grant boundary.
// ===================================================================

const MENU_IDS = {
  "/website-pages": "menu-website-pages",
  "/cms/announcements": "menu-cms-announcements",
  "/cms/banners": "menu-cms-banners",
};

let lookedUp = [];
let storedNotice = null;

MenuMaster.findOne = (filter) => ({
  lean: async () => {
    lookedUp.push(filter.menuUrl);
    const id = MENU_IDS[filter.menuUrl];
    return id ? { _id: id } : null;
  },
});
EmployeeRoles.findOne = () => ({ select: () => ({ lean: async () => null }) });
SiteNotice.findById = () => ({ select: () => ({ lean: async () => storedNotice }) });

/** A staff session holding `action` on exactly the menus listed. */
const staff = (grants, { body = {}, params = {} } = {}) => ({
  session: {
    user: {
      id: "emp-1",
      role: "EMPLOYEE",
      name: "Desk Staff",
      email: "desk@example.com",
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
  // Carries no permissions, mirroring what authMiddleware really builds: if the
  // middleware ever reads req.user instead of req.session.user, these fail.
  user: { id: "emp-1", role: "EMPLOYEE", email: "desk@example.com", name: "Desk Staff" },
  body,
  params,
  query: {},
  headers: {},
});

const runMw = async (middleware, req, doc = null) => {
  lookedUp = [];
  storedNotice = doc;
  const res = makeRes();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });
  return { passed, status: res.statusCode, lookedUp: [...lookedUp] };
};

test("each kind resolves its OWN screen, and neither falls back", () => {
  assert.equal(menuUrlForNoticeKind("ANNOUNCEMENT"), "/cms/announcements");
  assert.equal(menuUrlForNoticeKind("BANNER"), "/cms/banners");

  // Uppercasing, because the stored enum is SCREAMING_SNAKE — lowercasing (what
  // the CMS key maps do) would miss every row and silently hand both screens to
  // the all-pages grant.
  assert.equal(menuUrlForNoticeKind("  banner "), "/cms/banners");

  for (const kind of NOTICE_KINDS) {
    assert.notEqual(
      menuUrlForNoticeKind(kind),
      CMS_FALLBACK_MENU_URL,
      `${kind} fell back to the all-pages permission`,
    );
  }

  // "No mapping" must never mean "no check".
  assert.equal(menuUrlForNoticeKind("SPONSORED"), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForNoticeKind(undefined), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForNoticeKind(null), CMS_FALLBACK_MENU_URL);
  assert.equal(menuUrlForNoticeKind({ $ne: null }), CMS_FALLBACK_MENU_URL);
});

test("both notice screens are rows the CMS seed actually creates", () => {
  // A mapping without a tree row resolves to a menu that never exists, and
  // checkPermission then falls through to the all-pages grant — which is the
  // exact thing the per-screen split exists to avoid.
  for (const url of Object.values(CMS_NOTICE_MENUS)) {
    assert.ok(cmsLeafMenuUrls().includes(url), `${url} is mapped but never seeded`);
  }
});

test("an announcements-only editor cannot publish a banner, and the mirror case", async () => {
  /**
   * THE PERMISSION THIS SPLIT EXISTS FOR. Posting "we are shut on Thursday" is
   * an operational job somebody at the desk should be able to do today.
   * Publishing "20% off annual plans" changes what the gym charges. One shared
   * /cms/notices row would make the first imply the second.
   */
  const deskStaff = staff({ "/cms/announcements": ["write"] });

  const ownKind = await runMw(cmsPermission("write", siteNoticeCreateTargets), {
    ...deskStaff,
    body: { kind: "ANNOUNCEMENT" },
  });
  assert.equal(ownKind.passed, true);
  assert.deepEqual(ownKind.lookedUp, ["/cms/announcements"]);

  const otherKind = await runMw(cmsPermission("write", siteNoticeCreateTargets), {
    ...deskStaff,
    body: { kind: "BANNER" },
  });
  assert.equal(otherKind.passed, false);
  assert.equal(otherKind.status, 403);
  // Checked /cms/banners, then the all-pages fallback, and held neither.
  assert.deepEqual(otherKind.lookedUp, ["/cms/banners", CMS_FALLBACK_MENU_URL]);

  // The mirror: a marketer granted banners cannot post an announcement.
  const marketer = staff({ "/cms/banners": ["write"] });
  const wrongWay = await runMw(cmsPermission("write", siteNoticeCreateTargets), {
    ...marketer,
    body: { kind: "ANNOUNCEMENT" },
  });
  assert.equal(wrongWay.passed, false);
  assert.equal(wrongWay.status, 403);
});

test("converting an announcement into a banner needs BOTH grants", async () => {
  /**
   * updateSiteNotice permits a kind change. Checking only the STORED kind would
   * let somebody granted /cms/announcements pick up a notice, flip it to
   * BANNER, and thereby publish to a screen they were never granted — a
   * privilege escalation that looks like an ordinary edit in the audit trail.
   */
  const deskStaff = staff({ "/cms/announcements": ["edit"] }, { params: { id: "n1" } });

  const convert = await runMw(
    cmsPermission("edit", siteNoticeDocTargets),
    { ...deskStaff, body: { kind: "BANNER" } },
    { kind: "ANNOUNCEMENT" },
  );
  assert.equal(convert.passed, false);
  assert.equal(convert.status, 403);
  assert.ok(convert.lookedUp.includes("/cms/banners"), "the destination was not checked");

  // Editing it in place, without a conversion, is allowed on the one grant.
  const inPlace = await runMw(
    cmsPermission("edit", siteNoticeDocTargets),
    { ...deskStaff, body: { title: "Updated closure times" } },
    { kind: "ANNOUNCEMENT" },
  );
  assert.equal(inPlace.passed, true);
  assert.deepEqual(inPlace.lookedUp, ["/cms/announcements"]);

  // Holding both grants makes the conversion legitimate.
  const both = staff(
    { "/cms/announcements": ["edit"], "/cms/banners": ["edit"] },
    { params: { id: "n1" } },
  );
  const allowed = await runMw(
    cmsPermission("edit", siteNoticeDocTargets),
    { ...both, body: { kind: "BANNER" } },
    { kind: "ANNOUNCEMENT" },
  );
  assert.equal(allowed.passed, true);
  assert.deepEqual(
    [...allowed.lookedUp].sort(),
    ["/cms/announcements", "/cms/banners"],
  );
});

test("the all-CMS grant still covers both screens", async () => {
  // /website-pages has always meant "may edit the website's content" and is
  // already granted. Per-screen rows only ever ADD narrower ways to be allowed;
  // nothing that works today stops working.
  const allPages = staff({ "/website-pages": ["write"] });
  for (const kind of NOTICE_KINDS) {
    const result = await runMw(cmsPermission("write", siteNoticeCreateTargets), {
      ...allPages,
      body: { kind },
    });
    assert.equal(result.passed, true, `${kind} was refused to the all-pages grant`);
  }
});

test("a deleted or unknown notice id takes the all-pages grant, not a 404 probe", async () => {
  // Returning 404 from the permission layer would let an unprivileged account
  // enumerate which notice ids exist. The fallback lets the request proceed to
  // the controller, which returns its own honest 404.
  const targets = await siteNoticeDocTargets({ params: { id: "gone" }, body: {} });
  assert.deepEqual(targets, [CMS_FALLBACK_MENU_URL]);
});
