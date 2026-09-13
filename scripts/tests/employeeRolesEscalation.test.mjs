/**
 * OFFLINE tests for the role-permission escalation ceiling.
 *
 * Run:  node --test scripts/tests/employeeRolesEscalation.test.mjs
 *
 * NO DATABASE, following scripts/tests/superAdminGate.test.mjs and
 * scripts/tests/cmsPermission.test.mjs: mongoose schemas compile without a
 * connection, so the REAL controllers and the REAL models are imported and the
 * models' static query methods are replaced with stubs that CAPTURE WHAT WAS
 * WRITTEN. That capture is the point — the assertion these tests exist to make
 * is "the refused request wrote nothing", which is a statement about what
 * reached Mongo, not about the status code.
 *
 * ============================================================================
 * WHY THESE ARE TESTS AND NOT A REVIEW NOTE
 * ============================================================================
 *
 * The hole they close was invisible in every direction:
 *
 *   - `checkUpdatePermissions` enforced "you cannot grant more than you hold"
 *     for `role === "EMPLOYEE"` and NOTHING for `role === "ADMIN"`. `role` is
 *     which table you logged in from, not how much you may do (see
 *     middlewares/superAdmin.js), so every branch-level CompanyMaster admin
 *     with `edit` on /employee-roles could write themselves a role carrying the
 *     CMS, the SEO manager and the audit log — the menus that are super-admin-
 *     only precisely BECAUSE they are granted to nobody. A wrongly GRANTED
 *     permission raises no error anywhere; nobody would ever have found out.
 *     Test 2 is the regression guard for exactly that and is marked as such.
 *
 *   - Overshoot the other way — apply the ceiling to the super admin as well —
 *     and nobody can ever be granted anything they do not already have, which
 *     makes the Employee Roles screen useless to the one person it is for.
 *     Tests 1 and 7 pin that.
 *
 *   - Fix the update endpoint and forget the create endpoint, and the hole just
 *     moves one route over: POST /employee-roles writes the same document.
 *     Tests 6 and 7 pin that.
 */
import test from "node:test";
import assert from "node:assert/strict";

import EmployeeRoles from "../../models/EmployeeRoles.js";
import Employee from "../../models/Employee.js";
import RoleMaster from "../../models/RoleMaster.js";

import {
  createEmployeeRoles,
  updateEmployeeRoles,
} from "../../controllers/v1/employeeRoles.controller.js";

// ===================================================================
// Harness
// ===================================================================

/** Valid 24-hex ids — the controllers reject anything else before authorising. */
const TARGET_ROLE_ID = "5f1111111111111111111111";
const OWN_ROLE_ID = "5f2222222222222222222222";
const EMPLOYEE_CREATED_ROLE_ID = "5f3333333333333333333333";

/** Menu ids. Opaque strings: permissions are matched by string equality only. */
const MENU = {
  members: "menu-members",
  reports: "menu-reports",
  cmsHome: "menu-cms-home",
  auditLog: "menu-audit-log",
};

/** Everything the controllers wrote during the call under test. */
let writes = [];
/** RoleMaster rows the ownership check will find, keyed by id. */
let roleRows = {};

RoleMaster.findById = (id) => ({
  select: async () => roleRows[id] ?? null,
});

EmployeeRoles.create = async (doc) => {
  writes.push({ op: "create", doc });
  return { _id: "new-doc", ...doc };
};

EmployeeRoles.findByIdAndUpdate = async (id, update) => {
  writes.push({ op: "update", id, update });
  return { _id: id, roleId: TARGET_ROLE_ID, roles: update.roles };
};

EmployeeRoles.findOneAndUpdate = async (filter, update) => {
  writes.push({ op: "updateByRoleId", filter, update });
  return { _id: "doc", roleId: filter.roleId, roles: update.roles };
};

/**
 * The cascade that runs AFTER a successful write looks for employees holding
 * the role. Returning none ends it immediately — the cascade is not what these
 * tests are about, and scripts/tests/scoping.test.mjs owns branch behaviour.
 */
Employee.find = () => ({ select: async () => [] });

/** Turns a {menu: ["read", …]} map into a session permission array. */
const permsFrom = (grants) =>
  Object.entries(grants).map(([menuId, actions]) => ({
    menuId,
    menuGroupId: "group-1",
    read: actions.includes("read"),
    write: actions.includes("write"),
    edit: actions.includes("edit"),
    delete: actions.includes("delete"),
    print: actions.includes("print"),
    mail: actions.includes("mail"),
  }));

/** The same shape, as the admin panel posts it. */
const rolesBody = (grants) => permsFrom(grants);

/**
 * Builds a request.
 *
 * `req.user` is POISONED ON PURPOSE: it carries the four fields authMiddleware
 * really copies PLUS an `isSuperAdmin: true` that no real req.user ever has. If
 * any part of this controller is ever rewritten against req.user instead of
 * req.session.user, every refusal test below turns into a pass and fails
 * loudly, rather than the panel failing open in production.
 */
const makeReq = (sessionUser, { body = {}, params = {} } = {}) => ({
  session: { user: sessionUser },
  user: sessionUser
    ? {
        id: sessionUser.id,
        role: sessionUser.role,
        email: sessionUser.email,
        name: sessionUser.name,
        isSuperAdmin: true,
      }
    : undefined,
  body,
  params,
  query: {},
  headers: {},
});

/** The owner. CompanyMaster table, so role "ADMIN", and genuinely super. */
const superAdmin = (opts) =>
  makeReq(
    {
      id: "owner",
      role: "ADMIN",
      name: "Owner",
      email: "owner@example.com",
      branch: null,
      isSuperAdmin: true,
      // No permissions of their own — they never needed a grant, and the
      // ceiling must not be applied to them because of it.
      permissions: [],
      roleId: null,
    },
    opts,
  );

/**
 * A BRANCH-LEVEL ADMIN IN THE COMPANYMASTER TABLE — role "ADMIN",
 * isSuperAdmin: false, with a roleId and real grants. This is the fixture the
 * whole change exists for.
 */
const branchCompanyAdmin = (grants, opts) =>
  makeReq(
    {
      id: "branch-admin",
      role: "ADMIN",
      name: "Vasna Admin",
      email: "vasna@example.com",
      branch: "Vasna",
      isSuperAdmin: false,
      roleId: OWN_ROLE_ID,
      permissions: permsFrom(grants),
      permissionsUpdatedAt: new Date().toISOString(),
    },
    opts,
  );

/** A CompanyMaster with no roleId at all, hence no permission set. */
const rolelessCompanyAdmin = (opts) =>
  makeReq(
    {
      id: "roleless-admin",
      role: "ADMIN",
      name: "Legacy Admin",
      email: "admin@barodaweb.net",
      branch: "Gotri",
      isSuperAdmin: false,
      roleId: null,
      permissions: [],
      permissionsUpdatedAt: null,
    },
    opts,
  );

/** A branch manager in the Employee table. */
const branchEmployee = (grants, opts) =>
  makeReq(
    {
      id: "emp-gotri",
      role: "EMPLOYEE",
      name: "Gotri Manager",
      email: "gotri@example.com",
      branch: "Gotri",
      isSuperAdmin: false,
      roleId: OWN_ROLE_ID,
      permissions: permsFrom(grants),
      permissionsUpdatedAt: new Date().toISOString(),
    },
    opts,
  );

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

/** Runs one controller and reports what happened, including what it wrote. */
const run = async (controller, req) => {
  writes = [];
  roleRows = {
    // The normal case: a role created by an admin, not by an employee.
    [TARGET_ROLE_ID]: { createdBy: null },
    [OWN_ROLE_ID]: { createdBy: null },
    [EMPLOYEE_CREATED_ROLE_ID]: { createdBy: "some-employee-id" },
  };
  const res = makeRes();
  await controller(req, res);
  return {
    status: res.statusCode,
    body: res.payload,
    isOk: res.payload?.isOk === true,
    message: res.payload?.message,
    violations: res.payload?.violations,
    writes: [...writes],
  };
};

/** An update of TARGET_ROLE_ID granting `grants`, as the panel sends it. */
const updateReq = (reqFor, grants, overrides = {}) =>
  reqFor({
    body: { roleId: TARGET_ROLE_ID, roles: rolesBody(grants), ...overrides.body },
    params: { id: TARGET_ROLE_ID, ...overrides.params },
  });

/** A create of permissions for TARGET_ROLE_ID granting `grants`. */
const createReq = (reqFor, grants) =>
  reqFor({
    body: { roleId: TARGET_ROLE_ID, roles: rolesBody(grants) },
    params: {},
  });

// ===================================================================
// 1. The super admin is unbounded
// ===================================================================

test("update: a super admin can grant anything, including menus granted to nobody", async () => {
  const req = updateReq(superAdmin, {
    [MENU.cmsHome]: ["read", "write", "edit", "delete"],
    [MENU.auditLog]: ["read", "print"],
    [MENU.members]: ["read", "write", "edit", "delete", "print", "mail"],
  });

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 200);
  assert.equal(result.isOk, true);
  assert.equal(result.writes.length, 1);
  // The owner holds no permission rows of their own; the ceiling must not be
  // read as "therefore may grant nothing".
  assert.equal(result.writes[0].update.roles.length, 3);
});

// ===================================================================
// 2. REGRESSION GUARD — the hole this change closes
// ===================================================================

/**
 * ★ REGRESSION GUARD ★
 *
 * Delete the non-super-admin branch of authorizeRolePermissionWrite, or revert
 * the ceiling to `role === "EMPLOYEE"`, and this is the ONLY test that fails.
 * Nothing throws, no screen breaks, and every branch-level CompanyMaster admin
 * silently regains the ability to grant themselves the CMS, the SEO manager and
 * the audit log. A permission wrongly granted produces no error anywhere.
 */
test("REGRESSION GUARD — update: a non-super-admin ADMIN cannot grant a permission they do not hold", async () => {
  const req = updateReq(
    (opts) => branchCompanyAdmin({ [MENU.members]: ["read", "write"] }, opts),
    {
      [MENU.members]: ["read"],
      [MENU.cmsHome]: ["write"], // never granted to this account
    },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(result.isOk, false);
  assert.equal(
    result.message,
    "You cannot give more permissions than you have yourself.",
  );
  assert.deepEqual(result.violations, [
    { menuId: MENU.cmsHome, permission: "write" },
  ]);
  // The decisive assertion: NOTHING reached the database.
  assert.deepEqual(result.writes, []);
});

test("REGRESSION GUARD — update: a non-super-admin ADMIN cannot escalate an action on a menu they only partly hold", async () => {
  // Holds read on /reports, asks for delete on /reports. Same menu, higher action.
  const req = updateReq(
    (opts) => branchCompanyAdmin({ [MENU.reports]: ["read"] }, opts),
    { [MENU.reports]: ["read", "delete"] },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.deepEqual(result.violations, [
    { menuId: MENU.reports, permission: "delete" },
  ]);
  assert.deepEqual(result.writes, []);
});

// ===================================================================
// 3. …but a non-super-admin ADMIN keeps working inside their own ceiling
// ===================================================================

test("update: a non-super-admin ADMIN CAN grant a permission they do hold", async () => {
  const req = updateReq(
    (opts) =>
      branchCompanyAdmin(
        { [MENU.members]: ["read", "write", "edit"], [MENU.reports]: ["read", "print"] },
        opts,
      ),
    {
      [MENU.members]: ["read", "write"],
      [MENU.reports]: ["read", "print"],
    },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 200);
  assert.equal(result.isOk, true);
  assert.equal(result.writes.length, 1);
});

test("update: a non-super-admin ADMIN may still REVOKE — an all-false write is not an escalation", async () => {
  const req = updateReq(
    (opts) => branchCompanyAdmin({ [MENU.members]: ["read", "write"] }, opts),
    { [MENU.members]: [] },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 200);
  assert.equal(result.writes.length, 1);
});

test("update: the ADMIN ownership rule is unchanged — an employee-created role is still refused", async () => {
  const req = branchCompanyAdmin(
    { [MENU.members]: ["read"] },
    {
      body: {
        roleId: EMPLOYEE_CREATED_ROLE_ID,
        roles: rolesBody({ [MENU.members]: ["read"] }),
      },
      params: { id: EMPLOYEE_CREATED_ROLE_ID },
    },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(
    result.message,
    "You cannot modify permissions for roles created by employees.",
  );
  assert.deepEqual(result.writes, []);
});

// ===================================================================
// 4. The EMPLOYEE path is untouched
// ===================================================================

test("update: an EMPLOYEE still cannot grant more than they hold — message and violations unchanged", async () => {
  const req = updateReq(
    (opts) => branchEmployee({ [MENU.members]: ["read"] }, opts),
    { [MENU.members]: ["read", "delete"] },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(
    result.message,
    "You cannot give more permissions than you have yourself.",
  );
  assert.deepEqual(result.violations, [
    { menuId: MENU.members, permission: "delete" },
  ]);
  assert.deepEqual(result.writes, []);
});

test("update: an EMPLOYEE granting within their ceiling still succeeds", async () => {
  const req = updateReq(
    (opts) => branchEmployee({ [MENU.members]: ["read", "write"] }, opts),
    { [MENU.members]: ["read"] },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 200);
  assert.equal(result.writes.length, 1);
});

test("update: an EMPLOYEE still cannot edit their own role", async () => {
  const req = branchEmployee(
    { [MENU.members]: ["read"] },
    {
      body: { roleId: OWN_ROLE_ID, roles: rolesBody({ [MENU.members]: ["read"] }) },
      params: { id: OWN_ROLE_ID },
    },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(result.message, "You cannot modify your own role permissions.");
  assert.deepEqual(result.writes, []);
});

test("update: the own-role guard also covers the id in the URL, not just the one in the body", async () => {
  // The document written is `req.params.id || req.body.roleId`. Omitting roleId
  // from the body used to walk straight past the self-check.
  const req = branchEmployee(
    { [MENU.members]: ["read"] },
    {
      body: { roles: rolesBody({ [MENU.members]: ["read"] }) },
      params: { id: OWN_ROLE_ID },
    },
  );

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(result.message, "You cannot modify your own role permissions.");
  assert.deepEqual(result.writes, []);
});

// ===================================================================
// 5. A CompanyMaster with no role — fails closed, with a fixable message
// ===================================================================

test("update: a CompanyMaster with no roleId is refused with an actionable message, not a bare ceiling 403", async () => {
  const req = updateReq(rolelessCompanyAdmin, { [MENU.members]: ["read"] });

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(result.isOk, false);
  // Not the generic ceiling message: that one, plus a list of violations, reads
  // as a bug rather than as "this account was never given a role".
  assert.notEqual(
    result.message,
    "You cannot give more permissions than you have yourself.",
  );
  assert.match(result.message, /no permission set of its own/);
  assert.match(result.message, /super admin/);
  assert.equal(result.violations, undefined);
  assert.deepEqual(result.writes, []);
});

test("update: a CompanyMaster with no roleId cannot WIPE another role either", async () => {
  // "May grant nothing" would let this account strip every permission from the
  // other branch's manager — a lockout, not a no-op. It is refused outright.
  const req = updateReq(rolelessCompanyAdmin, { [MENU.members]: [] });

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.match(result.message, /no permission set of its own/);
  assert.deepEqual(result.writes, []);
});

// ===================================================================
// 6. Creation carries the identical gate
// ===================================================================

test("create: a non-super-admin ADMIN cannot create a permission set above their own ceiling", async () => {
  const req = createReq(
    (opts) => branchCompanyAdmin({ [MENU.members]: ["read"] }, opts),
    { [MENU.auditLog]: ["read"] },
  );

  const result = await run(createEmployeeRoles, req);

  assert.equal(result.status, 403);
  assert.equal(
    result.message,
    "You cannot give more permissions than you have yourself.",
  );
  assert.deepEqual(result.violations, [
    { menuId: MENU.auditLog, permission: "read" },
  ]);
  // If this ever writes, the hole simply moved from PUT to POST.
  assert.deepEqual(result.writes, []);
});

test("create: an EMPLOYEE's create-side behaviour is unchanged", async () => {
  const refused = await run(
    createEmployeeRoles,
    createReq(
      (opts) => branchEmployee({ [MENU.members]: ["read"] }, opts),
      { [MENU.members]: ["read", "write"] },
    ),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.writes, []);

  const allowed = await run(
    createEmployeeRoles,
    createReq(
      (opts) => branchEmployee({ [MENU.members]: ["read", "write"] }, opts),
      { [MENU.members]: ["read", "write"] },
    ),
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.writes.length, 1);
});

test("create: a CompanyMaster with no roleId is refused with the same actionable message", async () => {
  const result = await run(
    createEmployeeRoles,
    createReq(rolelessCompanyAdmin, { [MENU.members]: ["read"] }),
  );

  assert.equal(result.status, 403);
  assert.match(result.message, /no permission set of its own/);
  assert.deepEqual(result.writes, []);
});

// ===================================================================
// 7. Creation still works for the people it is for
// ===================================================================

test("create: a super admin can create any permission set", async () => {
  const result = await run(
    createEmployeeRoles,
    createReq(superAdmin, {
      [MENU.cmsHome]: ["read", "write", "edit", "delete"],
      [MENU.auditLog]: ["read"],
    }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.isOk, true);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].doc.roles.length, 2);
});

test("create: a non-super-admin ADMIN can create within their own ceiling", async () => {
  const result = await run(
    createEmployeeRoles,
    createReq(
      (opts) => branchCompanyAdmin({ [MENU.members]: ["read", "write"] }, opts),
      { [MENU.members]: ["read"] },
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.writes.length, 1);
});

// ===================================================================
// 8. An anonymous request never reaches the write
// ===================================================================

test("update: no session is 401, not a crash", async () => {
  const req = {
    session: {},
    body: { roleId: TARGET_ROLE_ID, roles: rolesBody({ [MENU.members]: ["read"] }) },
    params: { id: TARGET_ROLE_ID },
    query: {},
    headers: {},
  };

  const result = await run(updateEmployeeRoles, req);

  assert.equal(result.status, 401);
  assert.deepEqual(result.writes, []);
});
