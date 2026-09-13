/**
 * OFFLINE tests for the super-admin gate.
 *
 * Run:  node --test scripts/tests/superAdminGate.test.mjs
 *
 * NO DATABASE, following scripts/tests/scoping.test.mjs and
 * scripts/tests/cmsPermission.test.mjs: mongoose schemas compile without a
 * connection, so the real middleware and the real models are imported and the
 * models' static query methods are replaced with stubs that CAPTURE WHAT WAS
 * ASKED and return fixtures.
 *
 * ============================================================================
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE
 * ============================================================================
 *
 * The change under test is one line of behaviour — the permission gates now
 * short-circuit on `isSuperAdmin` instead of on `role === "ADMIN"` — and every
 * way of getting it wrong is SILENT.
 *
 *   - Revert the gate to the role string and nothing throws, no test that
 *     existed before this file fails, and every branch-level admin quietly
 *     regains the CMS, the SEO manager and the audit log. Nobody finds out,
 *     because a permission that is wrongly GRANTED produces no error anywhere.
 *     That is what test 3 pins: a branch admin WITHOUT a grant must be refused.
 *
 *   - Overshoot in the other direction — read the flag with truthiness, or
 *     forget that MongoDB-backed sessions survive a deploy and carry no
 *     isSuperAdmin at all — and the OWNER is locked out of their own system by
 *     a 403 that is indistinguishable from a missing grant. That is what the
 *     "old session" tests pin.
 *
 *   - Conflate the gate with authMiddleware(["ADMIN","EMPLOYEE"]), which asks a
 *     completely different question ("is this a staff session at all?"), and
 *     every employee loses every staff route at once. That is what test 4 pins.
 */
import test from "node:test";
import assert from "node:assert/strict";

import MenuMaster from "../../models/MenuMaster.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";
import Employee from "../../models/Employee.js";
import CompanyMaster from "../../models/CompanyMaster.js";

import { checkPermission } from "../../middlewares/checkPermission.js";
import { cmsPermission, siteContentCreateTargets } from "../../middlewares/cmsPermission.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin.js";
import {
  isSuperAdminSession,
  superAdminFlagMissing,
  resolveSuperAdminFlag,
} from "../../middlewares/superAdmin.js";
import {
  scopedBranch,
  scopeFilter,
  financialScopeFilter,
  isSuperAdmin,
} from "../../middlewares/branchScope.js";

// ===================================================================
// Harness
// ===================================================================

/** Menu URLs the server may resolve, with stable fake ids. */
const MENU_IDS = {
  "/members": "menu-members",
  "/reports": "menu-reports",
  "/class-sessions": "menu-class-sessions",
  "/attendance-overview": "menu-attendance-overview",
  "/cms/home": "menu-cms-home",
  "/website-pages": "menu-website-pages",
  "/audit-log": "menu-audit-log",
};

/** Menu URLs resolved during the call under test, in order. */
let lookedUp = [];
/** Model lookups the middleware made, in order: "Employee.findById" etc. */
let dbCalls = [];

MenuMaster.findOne = (filter) => ({
  lean: async () => {
    lookedUp.push(filter.menuUrl);
    const id = MENU_IDS[filter.menuUrl];
    return id ? { _id: id } : null;
  },
});

/**
 * Every fixture below carries its permissions inline and no roleId, so neither
 * refreshPermissions nor isPermissionStale should ever reach the database. This
 * stub makes an accidental reload LOUD rather than silent — a gate that
 * secretly re-reads permissions would pass these tests for the wrong reason.
 */
EmployeeRoles.findOne = () => {
  dbCalls.push("EmployeeRoles.findOne");
  return { select: () => ({ lean: async () => null }) };
};

/** Account rows resolveSuperAdminFlag will find, keyed by id. */
let employeeRows = {};
let companyRows = {};

Employee.findById = (id) => ({
  select: () => ({
    lean: async () => {
      dbCalls.push(`Employee.findById(${id})`);
      return employeeRows[id] ?? null;
    },
  }),
});

CompanyMaster.findById = (id) => ({
  select: () => ({
    lean: async () => {
      dbCalls.push(`CompanyMaster.findById(${id})`);
      return companyRows[id] ?? null;
    },
  }),
});

/** Turns a {menuUrl: ["read", ...]} map into a session permission array. */
const permsFrom = (grants) =>
  Object.entries(grants).map(([menuUrl, actions]) => ({
    menuId: MENU_IDS[menuUrl],
    menuGroupId: "group-1",
    read: actions.includes("read"),
    write: actions.includes("write"),
    edit: actions.includes("edit"),
    delete: actions.includes("delete"),
    print: actions.includes("print"),
    mail: actions.includes("mail"),
  }));

/**
 * Builds a request.
 *
 * `user` is populated ON PURPOSE and carries only the four fields authMiddleware
 * really copies (id, role, email, name) — no isSuperAdmin, no branch. If any
 * gate is ever rewritten against req.user it will read undefined for the owner
 * as well as for everyone else, and these tests fail loudly rather than the
 * panel failing quietly in production.
 */
const makeReq = ({ session = null, body = {}, params = {} } = {}) => ({
  session: session ? { user: session } : {},
  user: session
    ? { id: session.id, role: session.role, email: session.email, name: session.name }
    : undefined,
  body,
  params,
  query: {},
  headers: {},
});

/** The owner. CompanyMaster table, so role "ADMIN", and genuinely super. */
const superAdminReq = (opts = {}) =>
  makeReq({
    ...opts,
    session: {
      id: "owner",
      role: "ADMIN",
      name: "Owner",
      email: "owner@example.com",
      branch: null,
      isSuperAdmin: true,
    },
  });

/**
 * A BRANCH-LEVEL ADMIN IN THE COMPANYMASTER TABLE — role "ADMIN",
 * isSuperAdmin: false. This is the fixture the whole change exists for: before
 * it, `role === "ADMIN"` waved this account through every check in the system.
 */
const branchCompanyAdminReq = (grants = {}, opts = {}) =>
  makeReq({
    ...opts,
    session: {
      id: "branch-admin",
      role: "ADMIN",
      name: "Vasna Admin",
      email: "vasna@example.com",
      branch: "Vasna",
      isSuperAdmin: false,
      permissions: permsFrom(grants),
      permissionsUpdatedAt: new Date().toISOString(),
    },
  });

/** A branch admin in the Employee table. Same privileges, different table. */
const branchEmployeeReq = (grants = {}, opts = {}) =>
  makeReq({
    ...opts,
    session: {
      id: "emp-gotri",
      role: "EMPLOYEE",
      name: "Gotri Manager",
      email: "gotri@example.com",
      branch: "Gotri",
      isSuperAdmin: false,
      permissions: permsFrom(grants),
      permissionsUpdatedAt: new Date().toISOString(),
    },
  });

/**
 * A session created BEFORE this change shipped: no isSuperAdmin field at all.
 * Sessions live in MongoDB (connect-mongo) and survive a deploy, so this is not
 * a hypothetical — it is what every signed-in user looks like on deploy day.
 */
const preDeployReq = (id, role, extra = {}) =>
  makeReq({
    session: {
      id,
      role,
      name: "Legacy Session",
      email: "legacy@example.com",
      permissions: [],
      ...extra,
      // isSuperAdmin deliberately absent
    },
  });

const makeRes = () => {
  const res = { statusCode: null, payload: null, cleared: [] };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  res.clearCookie = (name) => {
    res.cleared.push(name);
    return res;
  };
  return res;
};

/** Runs one middleware and reports what happened. */
const run = async (middleware, req) => {
  lookedUp = [];
  dbCalls = [];
  const res = makeRes();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });
  return {
    passed,
    status: res.statusCode,
    message: res.payload?.message,
    lookedUp: [...lookedUp],
    dbCalls: [...dbCalls],
  };
};

// ===================================================================
// 1. The helper itself — one named answer, three distinct states
// ===================================================================

test("isSuperAdminSession: only an explicit true is a super admin", () => {
  assert.equal(isSuperAdminSession(superAdminReq()), true);
  assert.equal(isSuperAdminSession(branchCompanyAdminReq()), false);
  assert.equal(isSuperAdminSession(branchEmployeeReq()), false);
  assert.equal(isSuperAdminSession(makeReq()), false);
  assert.equal(isSuperAdminSession({}), false);

  // Absent is NOT false-by-truthiness here; it is a third state that
  // resolveSuperAdminFlag exists to settle. The gate still refuses it.
  assert.equal(isSuperAdminSession(preDeployReq("x", "ADMIN")), false);

  // Truthy junk must not be mistaken for the flag.
  assert.equal(
    isSuperAdminSession(makeReq({ session: { id: "x", role: "ADMIN", isSuperAdmin: "false" } })),
    false,
  );
  assert.equal(
    isSuperAdminSession(makeReq({ session: { id: "x", role: "ADMIN", isSuperAdmin: 1 } })),
    false,
  );
});

test("superAdminFlagMissing: absent yes, explicit false no, anonymous no", () => {
  assert.equal(superAdminFlagMissing(preDeployReq("x", "ADMIN")), true);
  assert.equal(superAdminFlagMissing(branchCompanyAdminReq()), false);
  assert.equal(superAdminFlagMissing(superAdminReq()), false);
  // Nothing to resolve without a session; authMiddleware 401s first anyway.
  assert.equal(superAdminFlagMissing(makeReq()), false);
});

test("branchScope.isSuperAdmin is the SAME answer, not a second opinion", () => {
  // Three spellings of this question used to exist and one of them disagreed.
  for (const req of [superAdminReq(), branchCompanyAdminReq(), branchEmployeeReq()]) {
    assert.equal(isSuperAdmin(req), isSuperAdminSession(req));
  }
});

// ===================================================================
// 2. checkPermission — the gate
// ===================================================================

test("a super admin bypasses before any menu is resolved", async () => {
  const result = await run(checkPermission("/cms/home", "delete"), superAdminReq());
  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, [], "the short-circuit must precede any lookup");
  assert.deepEqual(result.dbCalls, []);
});

test("a branch admin WITH the grant passes", async () => {
  const req = branchCompanyAdminReq({ "/reports": ["read", "print"] });
  const result = await run(checkPermission("/reports", "read"), req);
  assert.equal(result.passed, true);
  assert.deepEqual(result.lookedUp, ["/reports"], "a branch admin is actually checked");
});

test("a branch admin WITHOUT the grant is refused — this is the whole point", async () => {
  // role: "ADMIN", isSuperAdmin: false. Under the old gate this passed, because
  // the gate read the role string. If this test ever goes green while the gate
  // reads `role === "ADMIN"` again, the bug is back.
  const req = branchCompanyAdminReq({ "/reports": ["read"] });
  const result = await run(checkPermission("/audit-log", "read"), req);

  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.equal(result.message, "Access denied — no 'read' permission for this module");
  assert.deepEqual(result.lookedUp, ["/audit-log"]);
});

test("a granted menu still refuses an ungranted ACTION", async () => {
  const req = branchCompanyAdminReq({ "/class-sessions": ["read"] });
  const refused = await run(checkPermission("/class-sessions", "delete"), req);
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
});

test("an Employee-table branch admin behaves identically to a CompanyMaster one", async () => {
  const granted = branchEmployeeReq({ "/class-sessions": ["read"] });
  assert.equal((await run(checkPermission("/class-sessions", "read"), granted)).passed, true);

  const refused = await run(
    checkPermission("/cms/home", "write"),
    branchEmployeeReq({ "/class-sessions": ["read"] }),
  );
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
});

test("a menu granted to nobody is super-admin-only, automatically", async () => {
  // The mechanism the owner asked for: CMS, SEO and the audit log are simply
  // never granted, so only the bypass can reach them.
  for (const url of ["/cms/home", "/website-pages", "/audit-log"]) {
    const sa = await run(checkPermission(url, "read"), superAdminReq());
    assert.equal(sa.passed, true, `super admin must reach ${url}`);

    const branch = await run(checkPermission(url, "read"), branchCompanyAdminReq({ "/members": ["read"] }));
    assert.equal(branch.passed, false, `a branch admin must NOT reach ${url}`);
    assert.equal(branch.status, 403);
  }
});

test("anonymous is still 401, not 403", async () => {
  const result = await run(checkPermission("/members", "read"), makeReq());
  assert.equal(result.status, 401);
  assert.equal(result.message, "Not logged in");
});

test("an unseeded menu row keeps its distinctive 'not found' 403", async () => {
  const req = branchCompanyAdminReq({ "/members": ["read"] });
  const result = await run(checkPermission("/never-seeded", "read"), req);
  assert.equal(result.status, 403);
  assert.equal(result.message, "Menu '/never-seeded' not found");
});

// ===================================================================
// 3. cmsPermission — the gate that matters most
// ===================================================================

test("CMS: a super admin bypasses, a branch admin with no CMS grant is refused", async () => {
  const sa = await run(
    cmsPermission("write", siteContentCreateTargets),
    superAdminReq({ body: { pageKey: "home" } }),
  );
  assert.equal(sa.passed, true);
  assert.deepEqual(sa.lookedUp, []);

  // A branch admin holding a real grant on something ELSE, so the session is on
  // the normal code path rather than the empty-permissions path.
  const branch = await run(
    cmsPermission("write", siteContentCreateTargets),
    branchCompanyAdminReq({ "/members": ["read", "write"] }, { body: { pageKey: "home" } }),
  );
  assert.equal(branch.passed, false, "the CMS must never be reachable by an ungranted branch admin");
  assert.equal(branch.status, 403);
  assert.equal(branch.message, "Access denied — no 'write' permission for '/cms/home'");
});

// ===================================================================
// 4. authMiddleware is a DIFFERENT question and must keep its role list
// ===================================================================

test("authMiddleware still admits BOTH roles — it gates the table, not the privilege", async () => {
  for (const req of [
    superAdminReq(),
    branchCompanyAdminReq(),
    branchEmployeeReq(),
  ]) {
    const result = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);
    assert.equal(result.passed, true, `${req.session.user.role} must reach the staff API`);
  }
});

test("authMiddleware builds req.user from four fields and adds no privilege to it", async () => {
  const req = branchEmployeeReq({ "/members": ["read"] });
  await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.deepEqual(Object.keys(req.user).sort(), ["email", "id", "name", "role"]);
  assert.equal(req.user.isSuperAdmin, undefined);
  assert.equal(req.user.branch, undefined);
});

test("authMiddleware still rejects anonymous and still enforces its role list", async () => {
  const anon = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), makeReq());
  assert.equal(anon.status, 401);

  // A route restricted to ADMIN must still exclude EMPLOYEE, unchanged.
  const emp = await run(authMiddleware(["ADMIN"]), branchEmployeeReq());
  assert.equal(emp.passed, false);
  assert.equal(emp.status, 403);
});

test("requireSuperAdmin: unchanged for the owner, still closed to a branch admin", async () => {
  assert.equal((await run(requireSuperAdmin, superAdminReq())).passed, true);

  const branch = await run(requireSuperAdmin, branchCompanyAdminReq());
  assert.equal(branch.passed, false);
  assert.equal(branch.status, 403);
  assert.equal(branch.message, "Access denied. Super admin only.");

  assert.equal((await run(requireSuperAdmin, makeReq())).status, 401);
});

// ===================================================================
// 5. The pre-deploy session — sessions live in Mongo and survive a deploy
// ===================================================================

test("old session, genuine super admin: the flag is re-derived and the owner is NOT locked out", async () => {
  employeeRows = {};
  companyRows = { owner: { _id: "owner", isSuperAdmin: true } };

  const req = preDeployReq("owner", "ADMIN");
  assert.equal(superAdminFlagMissing(req), true, "precondition: the flag is absent");

  await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.equal(req.session.user.isSuperAdmin, true, "healed onto the session");
  assert.equal(isSuperAdminSession(req), true);

  // And the gate now lets them through, with no grants anywhere.
  const gate = await run(checkPermission("/cms/home", "delete"), req);
  assert.equal(gate.passed, true);
});

test("old session, branch admin: re-derived as NOT super admin, so the hole stays closed", async () => {
  employeeRows = {};
  companyRows = { "branch-admin": { _id: "branch-admin", isSuperAdmin: false } };

  const req = preDeployReq("branch-admin", "ADMIN", {
    permissions: permsFrom({ "/members": ["read"] }),
    permissionsUpdatedAt: new Date().toISOString(),
  });

  await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);
  assert.equal(req.session.user.isSuperAdmin, false);

  const gate = await run(checkPermission("/cms/home", "write"), req);
  assert.equal(gate.passed, false, "a pre-deploy branch session must not keep the old bypass");
  assert.equal(gate.status, 403);
});

test("old session, Employee super admin: the Employee table is consulted too", async () => {
  employeeRows = { "emp-owner": { _id: "emp-owner", isSuperAdmin: true, branch: null } };
  companyRows = {};

  const req = preDeployReq("emp-owner", "EMPLOYEE");
  const result = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.equal(req.session.user.isSuperAdmin, true);
  assert.ok(
    result.dbCalls.includes("Employee.findById(emp-owner)"),
    "Employee is checked first — it is the table that grows",
  );
  assert.ok(
    !result.dbCalls.includes("CompanyMaster.findById(emp-owner)"),
    "and CompanyMaster is not consulted once the row is found",
  );
});

test("old session, branch: a missing branch is healed too, so it cannot read as 'all branches'", async () => {
  employeeRows = { "emp-vasna": { _id: "emp-vasna", isSuperAdmin: false, branch: "Vasna" } };
  companyRows = {};

  const req = preDeployReq("emp-vasna", "EMPLOYEE");
  assert.equal(req.session.user.branch, undefined, "precondition: no branch on the session");

  await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.equal(req.session.user.branch, "Vasna");
  assert.deepEqual(scopeFilter(req), { branch: "Vasna" }, "not an empty, unrestricted filter");
});

test("the flag is resolved ONCE: a healed session costs no further lookups", async () => {
  employeeRows = {};
  companyRows = { owner: { _id: "owner", isSuperAdmin: true } };

  const req = preDeployReq("owner", "ADMIN");
  const first = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);
  assert.ok(first.dbCalls.some((c) => c.startsWith("CompanyMaster.findById")));

  const second = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);
  assert.deepEqual(second.dbCalls, [], "the answer is now on the session");
});

test("an explicit false is never re-derived — no per-request lookup for ordinary staff", async () => {
  employeeRows = { "emp-gotri": { _id: "emp-gotri", isSuperAdmin: true, branch: null } };
  companyRows = {};

  const req = branchEmployeeReq({ "/members": ["read"] });
  const result = await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.deepEqual(result.dbCalls, [], "a recorded false is an answer, not an absence");
  assert.equal(req.session.user.isSuperAdmin, false, "and the stale row does not promote them");
});

test("unknown account: fails CLOSED rather than guessing", async () => {
  employeeRows = {};
  companyRows = {};

  const req = preDeployReq("ghost", "ADMIN");
  await run(authMiddleware(["ADMIN", "EMPLOYEE"]), req);

  assert.equal(req.session.user.isSuperAdmin, false);
  assert.equal((await run(checkPermission("/cms/home", "read"), req)).status, 403);
});

test("database failure: fails CLOSED and caches nothing, so the next request retries", async () => {
  const originalFindById = Employee.findById;
  Employee.findById = () => ({
    select: () => ({
      lean: async () => {
        throw new Error("connection reset");
      },
    }),
  });

  try {
    const req = preDeployReq("owner", "ADMIN");
    const resolved = await resolveSuperAdminFlag(req);

    assert.equal(resolved, false, "an unreadable database is not a grant of unlimited access");
    assert.equal(
      req.session.user.isSuperAdmin,
      undefined,
      "nothing written, so a transient outage is not cached as a permanent demotion",
    );
    assert.equal(superAdminFlagMissing(req), true, "and the next request will retry");
  } finally {
    Employee.findById = originalFindById;
  }
});

// ===================================================================
// 6. Branch scoping is untouched by any of this
// ===================================================================

test("branch scoping is unaffected: the same filters, before and after", () => {
  const gotri = branchEmployeeReq();
  const vasnaCompanyAdmin = branchCompanyAdminReq();
  const owner = superAdminReq();

  assert.equal(scopedBranch(gotri), "Gotri");
  assert.equal(scopedBranch(vasnaCompanyAdmin), "Vasna");
  assert.equal(scopedBranch(owner), null);

  assert.deepEqual(scopeFilter(gotri), { branch: "Gotri" });
  assert.deepEqual(scopeFilter(vasnaCompanyAdmin), { branch: "Vasna" });
  assert.deepEqual(scopeFilter(owner), {});

  // A branch admin still cannot reach the shared "Common" cost bucket, however
  // they ask — including the CompanyMaster-table one, whose role says "ADMIN".
  assert.deepEqual(financialScopeFilter(gotri, "Common"), { branch: "Gotri" });
  assert.deepEqual(financialScopeFilter(vasnaCompanyAdmin, "Common"), { branch: "Vasna" });
  assert.deepEqual(financialScopeFilter(owner, "Common"), { branch: "Common" });
  assert.deepEqual(financialScopeFilter(owner, ""), {});
});

test("a branch admin newly granted /reports is still pinned to their own branch", async () => {
  // The seed grants /reports to branch roles. Passing the permission gate must
  // not widen the DATA the report covers — those are two independent systems,
  // and the grant would be indefensible if it did.
  const req = branchCompanyAdminReq({ "/reports": ["read", "print"] });
  const gate = await run(checkPermission("/reports", "read"), req);

  assert.equal(gate.passed, true, "granted: the gate opens");
  assert.deepEqual(financialScopeFilter(req, "Gotri"), { branch: "Vasna" }, "scope does not");
});
