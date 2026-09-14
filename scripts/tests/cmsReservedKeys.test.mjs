/**
 * OFFLINE tests for todo.md items 3 and 4 — the two reserved CMS keys.
 *
 * Item 3, `pageKey: "about"`: the SERVER's half of the contract is that it
 * passes `pageKey` through to services/siteRevalidate.js VERBATIM, for every
 * row, never substituting or guessing a path — routing `pageKey` to an actual
 * public URL is Gym-frontend's job
 * (`src/app/internal/revalidate/route.ts`, out of scope here and already
 * explicit there: `about: "/"`, with its own comment). What this file proves
 * is the part that would silently regress on the server side: editing the
 * "about" content that is ACTUALLY LIVE today — `pageKey: "home"`,
 * `sectionKey: "about"` — revalidates `"home"`, the page a visitor really
 * sees, and a future standalone `pageKey: "about"` row would revalidate
 * `"about"` unchanged (matching the frontend's already-built fallback).
 *
 * Item 4, `sectionKey: "seo"`: pins the reserved key string, and the two field
 * names (`title`, `body`) Gym-frontend reads off it — a rename of either would
 * break the fallback with no error on this side.
 *
 * Same no-DB technique as attendanceOverride.test.mjs: SiteContent.findById is
 * stubbed to return a fake document (`save()` recorded, not performed), and
 * `services/siteRevalidate.js`'s OWN outbound fetch is observed — that module
 * cannot be stubbed directly (its export is a `const`, and ESM bindings are
 * read-only to importers), so PUBLIC_SITE_ORIGIN/REVALIDATE_SECRET are set for
 * the duration of the test and `global.fetch` is replaced, which is the one
 * seam revalidateSite actually has.
 */
import test from "node:test";
import assert from "node:assert/strict";

import SiteContent from "../../models/SiteContent.js";
import {
  updateSiteContent,
  EDITABLE_FIELDS,
} from "../../controllers/v1/siteContent.controller.js";
import {
  CMS_PAGE_MENUS,
  SEO_FALLBACK_SECTION_KEY,
} from "../../config/cmsMenus.js";

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

/** A stand-in for the SiteContent document the controller loads and saves. */
const fakeDoc = (overrides = {}) => {
  const doc = {
    _id: "content1",
    pageKey: "home",
    sectionKey: "about",
    title: "",
    subtitle: "",
    body: "",
    imageUrl: "",
    ctaLabel: "",
    ctaHref: "",
    sortOrder: 0,
    isActive: true,
    saves: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saves += 1;
    return doc;
  };
  return doc;
};

const stubFindById = (doc) => {
  const original = SiteContent.findById;
  SiteContent.findById = async () => doc;
  return () => {
    SiteContent.findById = original;
  };
};

/**
 * Runs updateSiteContent with the outbound revalidation network call
 * captured, and PUBLIC_SITE_ORIGIN/REVALIDATE_SECRET set for the duration —
 * without them, revalidateSite short-circuits before it would ever reach
 * fetch, which is not what this test is checking.
 */
const runUpdateAndCaptureRevalidate = async (doc, body) => {
  const restoreFind = stubFindById(doc);
  const prevOrigin = process.env.PUBLIC_SITE_ORIGIN;
  const prevSecret = process.env.REVALIDATE_SECRET;
  const prevHook = process.env.SITE_DEPLOY_HOOK_URL;
  process.env.PUBLIC_SITE_ORIGIN = "https://example.test";
  process.env.REVALIDATE_SECRET = "test-secret";
  delete process.env.SITE_DEPLOY_HOOK_URL;

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };

  try {
    const req = { params: { id: doc._id }, body };
    const res = fakeRes();
    await updateSiteContent(req, res);
    return { res, calls };
  } finally {
    restoreFind();
    global.fetch = originalFetch;
    if (prevOrigin === undefined) delete process.env.PUBLIC_SITE_ORIGIN;
    else process.env.PUBLIC_SITE_ORIGIN = prevOrigin;
    if (prevSecret === undefined) delete process.env.REVALIDATE_SECRET;
    else process.env.REVALIDATE_SECRET = prevSecret;
    if (prevHook !== undefined) process.env.SITE_DEPLOY_HOOK_URL = prevHook;
  }
};

// ===================================================================
// Item 3: "about" — the server passes pageKey through faithfully
// ===================================================================

test("about: editing the LIVE about content (home/about) revalidates 'home' — the page that actually renders it", async () => {
  const doc = fakeDoc({ pageKey: "home", sectionKey: "about" });
  const { res, calls } = await runUpdateAndCaptureRevalidate(doc, {
    title: "New About Heading",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(doc.saves, 1);
  assert.equal(calls.length, 1, "revalidateSite must have called out exactly once");
  assert.equal(calls[0].url, "https://example.test/internal/revalidate");
  const sentBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(sentBody, { pageKey: "home" });
});

test("about: a future standalone pageKey:'about' row still revalidates 'about', unchanged — matching the frontend's documented fallback", async () => {
  // RESERVED today (0 rows, per docs/todo.md) but the server's own contract
  // must not special-case it: whatever pageKey the row carries is what gets
  // sent, verbatim, and Gym-frontend's own PAGE_PATHS map (out of scope here)
  // is what turns that into "/" — a decision recorded on that side, not
  // guessed at on this one.
  const doc = fakeDoc({ pageKey: "about", sectionKey: "hero" });
  const { calls } = await runUpdateAndCaptureRevalidate(doc, { title: "About Us" });

  assert.equal(calls.length, 1);
  const sentBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(sentBody, { pageKey: "about" });
});

test("about: still RESERVED in the menu map — /cms/about exists so permissions are already right the day it is used", () => {
  assert.equal(CMS_PAGE_MENUS.about, "/cms/about");
});

// ===================================================================
// Item 4: sectionKey "seo" — the reserved key, formalised and pinned
// ===================================================================

test("seo: the reserved sectionKey string is exactly 'seo'", () => {
  assert.equal(SEO_FALLBACK_SECTION_KEY, "seo");
});

test("seo: the two fields the fallback reads (title, body) still exist on EDITABLE_FIELDS", () => {
  // Gym-frontend/src/lib/seo.ts reads title -> meta title, body -> meta
  // description off a sectionKey:"seo" row. If either name is ever renamed
  // here without updating that file, this is the test that catches it.
  assert.ok(EDITABLE_FIELDS.includes("title"), "title must stay editable");
  assert.ok(EDITABLE_FIELDS.includes("body"), "body must stay editable");
});

test("seo: a sectionKey:'seo' row saves and revalidates exactly like any other block — nothing server-side special-cases it", async () => {
  const doc = fakeDoc({
    pageKey: "programs",
    sectionKey: SEO_FALLBACK_SECTION_KEY,
    title: "",
    body: "",
  });
  const { res, calls } = await runUpdateAndCaptureRevalidate(doc, {
    title: "Programs at Mid City Gym",
    body: "Strength, hypertrophy and conditioning coaching in Vadodara.",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(doc.title, "Programs at Mid City Gym");
  assert.equal(doc.body, "Strength, hypertrophy and conditioning coaching in Vadodara.");
  assert.deepEqual(JSON.parse(calls[0].init.body), { pageKey: "programs" });
});

test("seo: the schema itself accepts sectionKey 'seo' on every pageKey that uses it", () => {
  for (const pageKey of ["home", "programs", "contact"]) {
    const doc = new SiteContent({
      pageKey,
      sectionKey: SEO_FALLBACK_SECTION_KEY,
      title: "A title",
      body: "A description",
    });
    const err = doc.validateSync();
    assert.equal(err, undefined, err && err.message);
  }
});
