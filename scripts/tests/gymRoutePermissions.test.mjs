/**
 * The member and trainer routes are permission-gated like everything else.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY TRUE UNTIL 2026-09-14
 * ============================================================================
 * `checkPermission` was applied to transactions, attendance, classes, holidays
 * and employees — and NOT to members or trainers. Both route files carried the
 * same note: "deliberately NOT applied yet — it resolves a menu by URL and
 * 403s when the menu row is missing from MenuMaster".
 *
 * That reason was real when it was written and had since expired. `/members`
 * and `/trainers` both have ACTIVE MenuMaster rows now, and both tiers carry
 * flags for them, so the 403-on-missing-menu risk the note describes no longer
 * exists. The note outlived the condition it documented, which is the most
 * common way a temporary exception becomes permanent.
 *
 * Measured live against production as the front desk (`read` only on both):
 *
 *     DELETE /members/<id>    -> 404, reached the handler
 *     POST   /members         -> 400, reached the handler
 *     DELETE /trainers/<id>   -> 404, reached the handler
 *     DELETE /transactions/<id> -> 403, properly gated
 *
 * So the admin panel hid the buttons and the API did not enforce them. Any
 * signed-in staff account could enrol, edit, renew, take payments on, and
 * delete members and trainers within its own branch, whatever its role said.
 *
 * ============================================================================
 * THE ACTIONS ARE NOT UNIFORM, AND THAT IS THE POINT
 * ============================================================================
 * The owner's decision: the front desk keeps the job it actually does — enrol
 * a walk-in, correct a detail, renew, take cash — and does not get `delete`.
 * So renew and payments are gated on `edit`, not on `write`: they change an
 * existing member rather than creating one, and a desk that may edit a member
 * may certainly record the payment that member just made. Gating them on
 * `delete` would be absurd and gating them on `write` would tie taking cash to
 * the unrelated right to create records.
 *
 * Trainers stay `read` for the desk. Nobody asked the front desk to hire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");

/**
 * One route registration, whichever layout it uses.
 *
 * These files mix two: the multi-line form and the single-line
 * `router.post("/trainers", authMiddleware(...), createTrainer);`. The first
 * version of this helper only understood the multi-line one, so it could not
 * see `POST /trainers` at all — and a route the test cannot find is a route the
 * test cannot protect. It ends at whichever comes first: the closing `\n);` of
 * a multi-line block, or the end of the line for a single-line one.
 */
const routeBlock = (src, method, path) => {
  const multi = `router.${method}(\n  "${path}"`;
  const single = `router.${method}("${path}"`;
  const i = src.indexOf(multi) !== -1 ? src.indexOf(multi) : src.indexOf(single);
  assert.ok(i !== -1, `${method.toUpperCase()} ${path} not found`);

  const nextRoute = src.indexOf("\nrouter.", i + 1);
  const limit = nextRoute === -1 ? src.length : nextRoute;
  return src.slice(i, limit);
};

const members = read("routes/v1/members.routes.js");
const trainers = read("routes/v1/trainers.routes.js");

/** [file, method, path, menuUrl, action] */
const GATED = [
  [members, "post", "/members-by-params", "/members", "read"],
  [members, "post", "/members", "/members", "write"],
  [members, "put", "/members/:id", "/members", "edit"],
  [members, "delete", "/members/:id", "/members", "delete"],
  // Both change an EXISTING member, so both ride on `edit` — see the header.
  [members, "post", "/members/:id/renew", "/members", "edit"],
  [members, "post", "/members/:id/payments", "/members", "edit"],

  [trainers, "post", "/trainers-by-params", "/trainers", "read"],
  [trainers, "post", "/trainers-unassigned-members", "/trainers", "read"],
  [trainers, "post", "/trainers", "/trainers", "write"],
  [trainers, "put", "/trainers/:id", "/trainers", "edit"],
  [trainers, "delete", "/trainers/:id", "/trainers", "delete"],
  [trainers, "post", "/trainers/:id/assign-members", "/trainers", "edit"],
  [trainers, "delete", "/trainers/:id/members/:memberId", "/trainers", "edit"],
];

for (const [src, method, path, menuUrl, action] of GATED) {
  test(`${method.toUpperCase()} ${path} requires ${action} on ${menuUrl}`, () => {
    const block = routeBlock(src, method, path);
    assert.match(
      block,
      new RegExp(`checkPermission\\(\\s*"${menuUrl}",\\s*"${action}"`),
      "any signed-in staff account could otherwise reach this regardless of role",
    );
  });

  test(`${method.toUpperCase()} ${path} checks permission before the handler`, () => {
    const block = routeBlock(src, method, path);
    const authAt = block.search(/authMiddleware/);
    const permAt = block.search(/checkPermission/);
    assert.ok(
      authAt !== -1 && permAt > authAt,
      "authMiddleware must run first — checkPermission reads the session it builds",
    );
  });
}

test("the expired 'not applied yet' note is gone from both files", () => {
  for (const [name, src] of [["members", members], ["trainers", trainers]]) {
    assert.doesNotMatch(
      src,
      /checkPermission is deliberately NOT applied/,
      `${name}.routes.js still claims it is ungated — a stale note is worse than ` +
        "none, because the next reader trusts it instead of checking",
    );
  }
});

test("the member PORTAL routes are untouched by this", () => {
  /**
   * Members authenticate with a JWT and hold no MenuMaster permissions at all,
   * so a checkPermission on a portal route would 403 every member on every
   * request. They live in memberAuth/classes route files behind requireMember;
   * this test exists so a later sweep to "gate everything" does not reach them.
   */
  assert.doesNotMatch(
    read("routes/v1/memberAuth.routes.js"),
    /checkPermission/,
    "portal routes are guarded by requireMember, never by staff menu permissions",
  );
});

/**
 * ============================================================================
 * THE BASELINES BEHIND THE GATES
 * ============================================================================
 * Turning the gates on is only half the change. A gate is only as good as the
 * flags behind it, and the LIVE rows did not match the baselines in
 * repairRbac.js — because `planBaselineTopUp` only ever ADDS a missing url and
 * never reshapes an existing row's flags. Measured before this change:
 *
 *     Gym Branch Admin  /members -> read, write, edit          (no delete)
 *     Gym Branch Staff  /members -> read                       (no write/edit)
 *
 * With gates on and those flags, the front desk would have lost the ability to
 * enrol a walk-in or record a payment — the exact job the owner says they do.
 * So `/members` and `/trainers` join the reconciled set, which is the only
 * mechanism that repairs an existing row's flags.
 */
import {
  TIER_BASELINES,
  RECONCILED_FLAGS_URLS,
} from "../repairRbac.js";

test("the front desk can enrol, edit, renew and take payments", () => {
  const m = TIER_BASELINES.staff["/members"];
  assert.ok(m, "the staff tier must carry /members");
  assert.equal(m.read, true, "they answer questions about members all day");
  assert.equal(m.write, true, "enrolling a walk-in is the front desk's job");
  assert.equal(
    m.edit,
    true,
    "renew and add-payment are gated on `edit` — without it the desk can " +
      "create a member but not take the money for the membership",
  );
});

test("the front desk cannot delete a member or manage trainers", () => {
  assert.notEqual(
    TIER_BASELINES.staff["/members"].delete,
    true,
    "the owner's decision: removal stays with a branch admin",
  );
  const t = TIER_BASELINES.staff["/trainers"];
  assert.equal(t.read, true, "the desk must be able to look a trainer up");
  for (const action of ["write", "edit", "delete"]) {
    assert.notEqual(t[action], true, "nobody asked the front desk to hire");
  }
});

test("a branch admin can delete a member", () => {
  assert.equal(
    TIER_BASELINES.admin["/members"].delete,
    true,
    "with the gate on, deletion now requires this flag — and the live row " +
      "did not have it, so it has to be reconciled rather than topped up",
  );
});

test("/members and /trainers have their flags reconciled, not just topped up", () => {
  for (const url of ["/members", "/trainers", "/attendance-overview"]) {
    assert.ok(
      RECONCILED_FLAGS_URLS.includes(url),
      `${url} must be reconciled — top-up alone never repairs an existing ` +
        "row's flags, so the live rows would keep their pre-gate values",
    );
  }
});

test("reconciling /members and /trainers ADDS delete without stripping print or mail", () => {
  /**
   * Reconciliation rewrites a row to match the baseline EXACTLY, in both
   * directions — so a flag the baseline omits is a flag it takes away.
   *
   * Live, a branch admin held print and mail on both screens. The owner asked
   * for one change: branch admins may delete a member. Had the baselines been
   * left as they were, the same run would also have stripped `mail` from
   * /members and `print` and `mail` from /trainers — an unrequested removal of
   * working capability, arriving as a side effect of a security fix. This
   * script's own header warns about precisely that.
   *
   * So the admin baselines name every flag those roles already hold, and
   * reconciliation has exactly one thing left to do: add `delete`.
   */
  for (const url of ["/members", "/trainers"]) {
    const admin = TIER_BASELINES.admin[url];
    for (const action of ["read", "write", "edit", "delete", "print", "mail"]) {
      assert.equal(
        admin[action],
        true,
        `admin ${url} must keep ${action} — reconciliation removes what the ` +
          "baseline does not name, and a branch admin already had this",
      );
    }
  }
});
