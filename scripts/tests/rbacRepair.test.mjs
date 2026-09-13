/**
 * OFFLINE tests for scripts/repairRbac.js.
 *
 * Run:  node --test scripts/tests/rbacRepair.test.mjs
 *
 * NO DATABASE, following scripts/tests/superAdminGate.test.mjs: every planner
 * in repairRbac.js is a pure function precisely so the invariants can be pinned
 * without a connection and without standing the server up.
 *
 * ============================================================================
 * WHY THESE ARE TESTS AND NOT A COMMENT IN THE SEED SCRIPT
 * ============================================================================
 *
 * The bug this script was written for was invisible from every angle except
 * one. All four branch accounts had a complete, correct-looking permission set;
 * `EmployeeRoles.findOne({ roleId })` matched it; the admin sidebar rendered
 * every screen. The ONLY thing wrong was that no RoleMaster row existed at that
 * `roleId`, and the only code that notices is `.populate("roleId")` inside
 * `loginEmployee`, which nulls the path for a dangling reference and thereby
 * nulls the permission lookup that follows it. The account logs in fine and is
 * then 403'd everywhere.
 *
 * Nothing about that fails loudly, so nothing about it stays fixed on its own:
 *
 *   - Create the next role by writing an EmployeeRoles document and pointing an
 *     Employee at a fresh ObjectId (which is how these four were made) and the
 *     bug is back, with no error at any point. Test 1 pins the invariant
 *     itself — a referenced roleId with no RoleMaster row means ZERO
 *     permissions — so the consequence is written down as executable fact
 *     rather than as a paragraph someone may or may not read.
 *
 *   - "Repair" it by re-pointing the roleId at the EmployeeRoles document's own
 *     `_id` — the obvious-looking fix, since that id is right there in the
 *     document — and every one of those accounts is locked out of everything,
 *     because checkPermission looks the set up by the roleId FIELD. That has
 *     already happened once in this codebase. Test 2 pins the detector.
 *
 *   - Widen a tier baseline with a reserved menu and two branches quietly gain
 *     the CMS, because a permission that is wrongly GRANTED produces no error
 *     anywhere — the same failure mode superAdminGate.test.mjs exists for.
 *     Tests 3 and 4 pin the reserved set, including the `/cms/*` PREFIX rule,
 *     which matters because config/cmsMenus.js is owned elsewhere and keeps
 *     growing; a hardcoded list would stop covering new CMS screens silently.
 *
 *   - Make the top-up "authoritative" by resetting rows to the baseline and
 *     every per-role flag the owner ticked by hand is erased on the next run of
 *     a script whose whole selling point is that it is safe to re-run. Test 5
 *     pins that an existing row is never reshaped.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  grant,
  isReservedMenuUrl,
  RESERVED_TO_SUPER_ADMIN,
  BRANCH_ACCOUNTS,
  TIER_BASELINES,
  assertPolicyIsSelfConsistent,
  simulateLoginPermissions,
  planRoleMasterRepairs,
  detectLinkingTrap,
  planRowRemovals,
  planBaselineTopUp,
  planSuperAdminRepair,
  SUPER_ADMIN_EMAIL,
} from "../repairRbac.js";

// ===================================================================
// Fixtures
// ===================================================================

const menu = (id, menuUrl) => ({ _id: id, menuUrl, menuGroup: `grp-${id}` });

const MENUS = [
  menu("m-members", "/members"),
  menu("m-reports", "/reports"),
  menu("m-class", "/class-sessions"),
  menu("m-attend", "/attendance-overview"),
  menu("m-roles", "/employee-roles"),
  menu("m-rolemaster", "/role-master"),
  menu("m-cms-home", "/cms/home"),
  menu("m-cms-new", "/cms/a-screen-added-next-month"),
  menu("m-audit", "/audit-log"),
];

const menuById = new Map(MENUS.map((m) => [String(m._id), m]));
const menuByUrl = new Map(MENUS.map((m) => [m.menuUrl, m]));

const row = (menuId, ...on) => ({ menuId, menuGroupId: null, ...grant(...on) });

// ===================================================================
// 1. The invariant the whole script exists for
// ===================================================================

test("a roleId with no RoleMaster row yields ZERO permissions at login", () => {
  const employeeRolesDoc = {
    roleId: "role-1",
    roles: [row("m-members", "read"), row("m-reports", "read", "print")],
  };

  // This is the live BEFORE state of all four branch accounts: a complete
  // permission set, correctly linked by the roleId FIELD, and no RoleMaster.
  const broken = simulateLoginPermissions({
    employeeRoleId: "role-1",
    roleMasterExists: false,
    employeeRolesDoc,
  });

  assert.equal(
    broken.roleId,
    null,
    'populate("roleId") nulls a dangling reference, so the session gets roleId: null',
  );
  assert.equal(broken.permissionCount, 0);
  assert.equal(
    broken.lockedOut,
    true,
    'the account is 403"d on every checkPermission route despite a full EmployeeRoles document',
  );
});

test("creating the RoleMaster row at the SAME id is what restores permissions", () => {
  const employeeRolesDoc = {
    roleId: "role-1",
    roles: [row("m-members", "read"), row("m-reports", "read", "print")],
  };

  const fixed = simulateLoginPermissions({
    employeeRoleId: "role-1",
    roleMasterExists: true,
    employeeRolesDoc,
  });

  assert.equal(fixed.roleId, "role-1");
  assert.equal(fixed.permissionCount, 2);
  assert.equal(fixed.lockedOut, false);
});

test("the permission set is found by the roleId FIELD, never by the document _id", () => {
  // The linking trap, stated as behaviour. The document below IS the right
  // permission set, but it is reached through `roleId`, so an Employee pointed
  // at the document's own `_id` resolves to nothing at all.
  const employeeRolesDoc = {
    _id: "empRoles-doc-1",
    roleId: "role-1",
    roles: [row("m-members", "read")],
  };

  const viaField = simulateLoginPermissions({
    employeeRoleId: "role-1",
    roleMasterExists: true,
    employeeRolesDoc,
  });
  assert.equal(viaField.permissionCount, 1);

  const viaDocId = simulateLoginPermissions({
    employeeRoleId: "empRoles-doc-1",
    roleMasterExists: true,
    employeeRolesDoc,
  });
  assert.equal(
    viaDocId.permissionCount,
    0,
    "linking to the EmployeeRoles _id locks the account out of everything",
  );
});

// ===================================================================
// 2. Detectors
// ===================================================================

test("planRoleMasterRepairs reports every dangling roleId once, with all its referrers", () => {
  const plan = planRoleMasterRepairs({
    roleMasterIds: ["role-known"],
    references: [
      { id: "role-known", source: "Employee a@x" },
      { id: "role-missing", source: "Employee b@x" },
      { id: "role-missing", source: "Employee c@x" },
      { id: "role-missing", source: "EmployeeRoles doc-9" },
    ],
  });

  assert.equal(plan.length, 1, "one entry per missing id, not per referrer");
  assert.equal(plan[0].id, "role-missing");
  assert.deepEqual(plan[0].sources, [
    "Employee b@x",
    "Employee c@x",
    "EmployeeRoles doc-9",
  ]);
});

test("detectLinkingTrap flags a roleId that is actually an EmployeeRoles document _id", () => {
  const trapped = detectLinkingTrap({
    employeeRolesDocIds: ["doc-1", "doc-2"],
    references: [
      { id: "role-1", source: "Employee ok@x" },
      { id: "doc-2", source: "Employee trapped@x" },
    ],
  });

  assert.equal(trapped.length, 1);
  assert.equal(trapped[0].source, "Employee trapped@x");
});

test("planSuperAdminRepair catches both total-failure flags, and passes a healthy row", () => {
  assert.equal(planSuperAdminRepair({ isSuperAdmin: true, isActive: true }).ok, true);

  const demoted = planSuperAdminRepair({ isSuperAdmin: false, isActive: true });
  assert.equal(demoted.ok, false);
  assert.deepEqual(demoted.fix, { isSuperAdmin: true });

  const disabled = planSuperAdminRepair({ isSuperAdmin: true, isActive: false });
  assert.equal(disabled.ok, false);
  assert.deepEqual(disabled.fix, { isActive: true });

  // Absent is not false: a missing flag is still not a recorded `true`, and
  // isSuperAdminSession() tests `=== true`, so it must be repaired.
  const absent = planSuperAdminRepair({});
  assert.equal(absent.ok, false);
  assert.deepEqual(absent.fix, { isSuperAdmin: true, isActive: true });

  assert.equal(planSuperAdminRepair(null).ok, false);
});

// ===================================================================
// 3. The reserved set
// ===================================================================

test("every reserved menu is reserved, and /cms/* is matched by PREFIX", () => {
  for (const url of RESERVED_TO_SUPER_ADMIN) {
    assert.equal(isReservedMenuUrl(url), true, `${url} must be reserved`);
  }

  // The prefix rule is the point: config/cmsMenus.js is owned elsewhere and
  // gains screens, and a menu seeded next month must be reserved on the day it
  // appears, without anyone editing this file.
  assert.equal(isReservedMenuUrl("/cms/home"), true);
  assert.equal(isReservedMenuUrl("/cms/a-screen-added-next-month"), true);

  // Operational screens are NOT reserved — over-reserving locks the branches
  // out of their own gym, which fails just as badly in the other direction.
  for (const url of ["/members", "/reports", "/class-sessions", "/attendance-overview", "/cash-flow"]) {
    assert.equal(isReservedMenuUrl(url), false, `${url} must NOT be reserved`);
  }

  // Not a prefix match on the whole word: "/cmsx" is a different menu.
  assert.equal(isReservedMenuUrl("/cms-something"), false);
  assert.equal(isReservedMenuUrl(null), false);
  assert.equal(isReservedMenuUrl(undefined), false);
});

test("no tier baseline may name a reserved menu — asserted, not trusted", () => {
  assert.equal(assertPolicyIsSelfConsistent(), true);

  assert.throws(
    () =>
      assertPolicyIsSelfConsistent({
        admin: { "/members": grant("read"), "/cms/home": grant("read") },
      }),
    /reserved menus appear in a tier baseline/,
  );

  assert.throws(
    () => assertPolicyIsSelfConsistent({ staff: { "/employee-roles": grant("edit") } }),
    /employee-roles/,
  );
});

test("the shipped baselines grant operational screens and nothing reserved", () => {
  for (const [tier, baseline] of Object.entries(TIER_BASELINES)) {
    const urls = Object.keys(baseline);
    assert.ok(urls.length > 0, `${tier} baseline must not be empty`);
    for (const url of urls) {
      assert.equal(isReservedMenuUrl(url), false, `${tier} must not hold ${url}`);
    }
    for (const [url, flags] of Object.entries(baseline)) {
      for (const action of Object.keys(flags)) {
        assert.ok(ACTIONS.includes(action), `${tier}:${url} has unknown action '${action}'`);
      }
    }
  }

  // Staff is narrower than admin, per screen. If this ever inverts, the front
  // desk silently gained the branch admin's writes.
  for (const [url, staffFlags] of Object.entries(TIER_BASELINES.staff)) {
    const adminFlags = TIER_BASELINES.admin[url];
    assert.ok(adminFlags, `admin baseline must also cover ${url}`);
    for (const action of ACTIONS) {
      if (staffFlags[action]) {
        assert.equal(adminFlags[action], true, `staff holds ${action} on ${url} but admin does not`);
      }
    }
  }
});

test("the four branch accounts are specified exactly, two per branch, neither a super admin", () => {
  assert.deepEqual(Object.keys(BRANCH_ACCOUNTS).sort(), [
    "nventra011@gmail.com",
    "nventra01@gmail.com",
    "nventra021@gmail.com",
    "nventra02@gmail.com",
  ]);

  const byBranch = {};
  for (const [email, spec] of Object.entries(BRANCH_ACCOUNTS)) {
    assert.ok(TIER_BASELINES[spec.tier], `${email} has unknown tier '${spec.tier}'`);
    (byBranch[spec.branch] ||= []).push(spec.tier);
  }
  assert.deepEqual(byBranch.Vasna.sort(), ["admin", "staff"]);
  assert.deepEqual(byBranch.Gotri.sort(), ["admin", "staff"]);

  // A branch spec is never `null` — null means ALL branches in
  // middlewares/branchScope.js, and a branch account with it is a silent
  // cross-branch leak rather than a 403 anybody would report.
  for (const spec of Object.values(BRANCH_ACCOUNTS)) {
    assert.ok(spec.branch, "a branch account must name a branch, never null");
  }

  assert.equal(SUPER_ADMIN_EMAIL in BRANCH_ACCOUNTS, false);
});

// ===================================================================
// 4. Row removal
// ===================================================================

test("planRowRemovals revokes reserved menus and drops rows pointing at no menu", () => {
  const rows = [
    row("m-members", "read", "write"),
    row("m-roles", "read", "write", "edit"),
    row("m-rolemaster", "read", "write"),
    row("m-cms-new", "read"),
    row("m-audit", "read"),
    row(null, "read", "write", "edit", "delete", "print", "mail"),
    row("m-deleted-menu", "read"),
    row("m-reports", "read", "print"),
  ];

  const { keep, revoked, junk } = planRowRemovals({
    rows,
    menuById,
    revokeReserved: true,
  });

  assert.deepEqual(
    keep.map((r) => menuById.get(String(r.menuId)).menuUrl).sort(),
    ["/members", "/reports"],
  );
  assert.deepEqual(revoked.sort(), [
    "/audit-log",
    "/cms/a-screen-added-next-month",
    "/employee-roles",
    "/role-master",
  ]);
  assert.deepEqual(junk.sort(), ["menuId: null", "unknown menu m-deleted-menu"]);

  // The kept rows are the SAME objects, flags untouched.
  assert.equal(keep[0].write, true);
});

test("a role held only by the super admin is left alone — the bypass already governs it", () => {
  const rows = [row("m-roles", "read", "write"), row("m-cms-home", "read")];

  const { keep, revoked } = planRowRemovals({
    rows,
    menuById,
    revokeReserved: false,
  });

  assert.equal(revoked.length, 0);
  assert.equal(keep.length, 2, "reshaping a super admin's own role would be noise");
});

// ===================================================================
// 5. Top-up
// ===================================================================

test("planBaselineTopUp adds only what is missing and NEVER reshapes an existing row", () => {
  // The owner tuned /reports down to read-only by hand. A re-run must not
  // restore `print` — that is the difference between an idempotent repair and a
  // script that quietly reverts every manual decision.
  const existing = [row("m-reports", "read")];

  const { added, addedUrls, kept } = planBaselineTopUp({
    rows: existing,
    baseline: {
      "/reports": grant("read", "print"),
      "/members": grant("read", "write"),
    },
    menuByUrl,
  });

  assert.deepEqual(kept, ["/reports"]);
  assert.deepEqual(addedUrls, ["/members"]);
  assert.equal(existing[0].print, false, "the hand-tuned row is untouched");
  assert.equal(added.length, 1);
  assert.equal(added[0].write, true);
  assert.equal(added[0].menuGroupId, "grp-m-members", "a new row carries its menu's group");
});

test("planBaselineTopUp skips a baseline URL with no MenuMaster row rather than inventing one", () => {
  const { added, addedUrls, missingMenus } = planBaselineTopUp({
    rows: [],
    baseline: { "/members": grant("read"), "/not-seeded-yet": grant("read") },
    menuByUrl,
  });

  assert.deepEqual(addedUrls, ["/members"]);
  assert.deepEqual(missingMenus, ["/not-seeded-yet"]);
  assert.equal(added.length, 1);
});

test("the planners are idempotent: a second pass over their own output is a no-op", () => {
  const baseline = TIER_BASELINES.staff;
  const seed = { rows: [], baseline, menuByUrl };

  const first = planBaselineTopUp(seed);
  const afterFirst = [...first.added];

  const second = planBaselineTopUp({ rows: afterFirst, baseline, menuByUrl });
  assert.equal(second.added.length, 0, "nothing left to add on a re-run");
  assert.deepEqual(second.kept.sort(), first.addedUrls.sort());

  // And removal is idempotent too: nothing reserved survives the first pass, so
  // the second finds nothing to revoke.
  const removedOnce = planRowRemovals({ rows: afterFirst, menuById, revokeReserved: true });
  assert.equal(removedOnce.revoked.length, 0);
  assert.equal(removedOnce.junk.length, 0);
  assert.equal(removedOnce.keep.length, afterFirst.length);
});
