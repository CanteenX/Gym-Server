/**
 * OFFLINE branch-scoping tests for the STAFF DIRECTORY.
 *
 * Run:  node --test scripts/tests/employeeScoping.test.mjs
 *
 * NO DATABASE, same technique as scripts/tests/scoping.test.mjs: mongoose
 * schemas compile without a connection, so the real controller is imported and
 * the model's statics are replaced with stubs that CAPTURE THE FILTER. What is
 * asserted is the filter that actually reached Mongo, and the status code that
 * actually came back — not that some helper returns the right string.
 *
 * ============================================================================
 * WHAT THESE TESTS EXIST TO PIN DOWN
 * ============================================================================
 *
 * The owner's requirement: "both admin must not see each other's departments
 * but must have control over their department and employees."
 *
 * Two separate ways that was broken, and both failed SILENTLY:
 *
 *   1. listEmployeesByParams filtered Employee logins to `createdBy: <self>`,
 *      a per-creator hierarchy. Branch admins are created by the super admin
 *      and have created nobody, so the endpoint answered `{"data":[]}` — the
 *      Vasna admin saw ZERO of their own staff while the super admin saw 6-7.
 *      An empty table reads as "no staff yet", so nobody reports it.
 *
 *   2. Every by-id route (GET / PUT / DELETE / reset-password) and both
 *      unpaginated list routes had NO branch check at all. Filtering a list is
 *      cosmetic while `GET /employees/<other branch's id>` still answers; ids
 *      travel in URLs, exports and screenshots. That is the real boundary, so
 *      it gets a test per verb.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import EmployeeModels from "../../models/Employee.js";
import {
  listEmployeesByParams,
  listAllEmployees,
  listAllEmployeesByDepartment,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  createEmployee,
  resetPassword,
} from "../../controllers/v1/employee.controller.js";
import RoleMaster from "../../models/RoleMaster.js";
import EmployeeRoles from "../../models/EmployeeRoles.js";

// ===================================================================
// Fixtures
// ===================================================================

/**
 * A branch admin. An Employee login with a branch and isSuperAdmin: false —
 * exactly the shape nventra01@gmail.com has in production.
 *
 * `user` is present ON PURPOSE and lossy ON PURPOSE: it is the four-field copy
 * authMiddleware really builds, with no branch and no isSuperAdmin. If any of
 * this controller is ever rewritten against req.user it will read "no branch",
 * conclude "unrestricted", and these tests will fail loudly instead of leaking
 * quietly. See middlewares/branchScope.js.
 */
const branchAdmin = (branch, body = {}, params = {}) => ({
  session: {
    user: {
      id: `emp-${branch.toLowerCase()}`,
      role: "EMPLOYEE",
      name: `${branch} Manager`,
      email: `${branch.toLowerCase()}@example.com`,
      branch,
      isSuperAdmin: false,
      // Real sessions carry this; createEmployee now measures the role
      // being assigned against it (middlewares/roleCeiling.js).
      permissions: [{ menuId: "menu-1", read: true, write: true }],
    },
  },
  user: {
    id: `emp-${branch.toLowerCase()}`,
    role: "EMPLOYEE",
    email: `${branch.toLowerCase()}@example.com`,
    name: `${branch} Manager`,
  },
  body,
  params,
  query: {},
  headers: {},
});

const vasnaAdmin = (body, params) => branchAdmin("Vasna", body, params);
const gotriAdmin = (body, params) => branchAdmin("Gotri", body, params);

/** The owner. branch: null is how "all branches" is recorded. */
const superAdmin = (body = {}, params = {}) => ({
  session: {
    user: {
      id: "owner",
      role: "ADMIN",
      name: "Owner",
      email: "owner@example.com",
      branch: null,
      isSuperAdmin: true,
    },
  },
  user: {
    id: "owner",
    role: "ADMIN",
    email: "owner@example.com",
    name: "Owner",
  },
  body,
  params,
  query: {},
  headers: {},
});

/**
 * The misconfiguration: no branch, not a super admin. `branch: null` is the
 * same value the OWNER carries, so a naive scope check reads this account as
 * unrestricted. Exactly this shape existed in production (test@gmail.com).
 * It must grant LESS than a branch admin, never more.
 */
const branchlessAdmin = (body = {}, params = {}) => ({
  session: {
    user: {
      id: "emp-nobranch",
      role: "EMPLOYEE",
      name: "Misconfigured",
      email: "nobranch@example.com",
      branch: null,
      isSuperAdmin: false,
      // Real sessions carry this; createEmployee now measures the role
      // being assigned against it (middlewares/roleCeiling.js).
      permissions: [{ menuId: "menu-1", read: true, write: true }],
    },
  },
  user: {
    id: "emp-nobranch",
    role: "EMPLOYEE",
    email: "nobranch@example.com",
    name: "Misconfigured",
  },
  body,
  params,
  query: {},
  headers: {},
});

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

/** A chainable stand-in for a mongoose Query. */
const fakeQuery = (result) => {
  const q = {};
  for (const m of ["select", "sort", "skip", "limit", "populate", "lean"]) {
    q[m] = () => q;
  }
  q.exec = async () => result;
  q.then = (onOk, onErr) => Promise.resolve(result).then(onOk, onErr);
  return q;
};

/** Replaces statics on the model, recording every call. */
const stub = (methods) => {
  const original = {};
  const calls = [];
  for (const [name, impl] of Object.entries(methods)) {
    original[name] = EmployeeModels[name];
    EmployeeModels[name] = (...args) => {
      calls.push({ name, args });
      return impl(...args);
    };
  }
  return {
    calls,
    firstArg: (name) => calls.find((c) => c.name === name)?.args[0],
    called: (name) => calls.some((c) => c.name === name),
    restore: () => {
      for (const [name, fn] of Object.entries(original)) {
        EmployeeModels[name] = fn;
      }
    },
  };
};

/** The LAST $match stage of the pipeline — the one built from matchCondition. */
const scopeMatchOf = (pipeline) => {
  const matches = (pipeline || []).filter((st) => st && st.$match);
  return matches.length ? matches[matches.length - 1].$match : {};
};

/** A staff row as it exists in the database. */
const staffRow = (over = {}) => ({
  _id: "row-1",
  employeeName: "Reception Desk",
  emailOffice: "desk@example.com",
  branch: "Vasna",
  isSuperAdmin: false,
  save: async function () {
    return this;
  },
  ...over,
});

// ===================================================================
// 1. POST /employees/search — the endpoint that returned ZERO
// ===================================================================

test("search: a super admin is unrestricted and sees every branch", async () => {
  const s = stub({ aggregate: async () => [] });
  try {
    const res = fakeRes();
    await listEmployeesByParams(superAdmin({}), res);
    assert.equal(res.statusCode, 200);
    const match = scopeMatchOf(s.firstArg("aggregate"));
    assert.equal(
      match.branch,
      undefined,
      "super admin must not be branch-filtered",
    );
    assert.equal(match._id, undefined, "super admin must not be fail-closed");
  } finally {
    s.restore();
  }
});

test("search: each branch admin is pinned to their OWN branch", async () => {
  for (const branch of ["Vasna", "Gotri"]) {
    const s = stub({ aggregate: async () => [] });
    try {
      const res = fakeRes();
      await listEmployeesByParams(branchAdmin(branch, {}), res);
      assert.equal(res.statusCode, 200);
      assert.equal(scopeMatchOf(s.firstArg("aggregate")).branch, branch);
    } finally {
      s.restore();
    }
  }
});

/**
 * THE REGRESSION TEST FOR THE ACTUAL BUG.
 *
 * `createdBy` must not appear in the filter. While it did, a branch admin was
 * narrowed to staff they had personally created — which is none — and the
 * endpoint returned an empty list no matter how many people worked at their
 * gym. Asserting on the ABSENCE of the field is the only way to catch this:
 * the response shapes of "correctly scoped" and "filtered into oblivion" are
 * identical.
 */
test("search: a branch admin is NOT narrowed to staff they created", async () => {
  const s = stub({ aggregate: async () => [] });
  try {
    await listEmployeesByParams(vasnaAdmin({}), fakeRes());
    const match = scopeMatchOf(s.firstArg("aggregate"));
    assert.equal(
      match.createdBy,
      undefined,
      "createdBy hierarchy must not be reintroduced — it hid every branch admin's own staff",
    );
    assert.equal(match.branch, "Vasna");
  } finally {
    s.restore();
  }
});

test("search: a branch admin cannot widen scope with a branch in the body", async () => {
  // Every shape an attempt to widen could take.
  for (const body of [
    { branch: "Gotri" },
    { branch: "" },
    { branch: null },
    { branch: "Common" },
    { branchId: "anything" },
  ]) {
    const s = stub({ aggregate: async () => [] });
    try {
      await listEmployeesByParams(vasnaAdmin(body), fakeRes());
      assert.equal(
        scopeMatchOf(s.firstArg("aggregate")).branch,
        "Vasna",
        `body ${JSON.stringify(body)} must not move a Vasna admin`,
      );
    } finally {
      s.restore();
    }
  }
});

test("search: a body branch cannot fail-close or widen a super admin either", async () => {
  const s = stub({ aggregate: async () => [] });
  try {
    await listEmployeesByParams(superAdmin({ branch: "Vasna" }), fakeRes());
    const match = scopeMatchOf(s.firstArg("aggregate"));
    assert.equal(match._id, undefined);
  } finally {
    s.restore();
  }
});

test("search: a branchless non-super-admin is fail-closed, not unrestricted", async () => {
  const s = stub({ aggregate: async () => [] });
  try {
    await listEmployeesByParams(branchlessAdmin({}), fakeRes());
    const match = scopeMatchOf(s.firstArg("aggregate"));
    assert.equal(
      match._id,
      null,
      "a misconfigured account must match nothing, not everything",
    );
  } finally {
    s.restore();
  }
});

test("search: the branch scope survives a search term", async () => {
  const s = stub({ aggregate: async () => [] });
  try {
    await listEmployeesByParams(gotriAdmin({ match: "desk" }), fakeRes());
    assert.equal(scopeMatchOf(s.firstArg("aggregate")).branch, "Gotri");
  } finally {
    s.restore();
  }
});

// ===================================================================
// 2. The unpaginated list routes
// ===================================================================

test("GET /employees: scoped for a branch admin, open for a super admin", async () => {
  let s = stub({ find: () => fakeQuery([]) });
  try {
    await listAllEmployees(vasnaAdmin({}), fakeRes());
    assert.equal(s.firstArg("find").branch, "Vasna");
  } finally {
    s.restore();
  }

  s = stub({ find: () => fakeQuery([]) });
  try {
    await listAllEmployees(superAdmin({}), fakeRes());
    assert.equal(s.firstArg("find").branch, undefined);
    assert.equal(s.firstArg("find")._id, undefined);
  } finally {
    s.restore();
  }
});

test("GET /employees/department/:id: a department spans both gyms, so it is scoped too", async () => {
  const s = stub({ find: () => fakeQuery([]) });
  try {
    await listAllEmployeesByDepartment(
      gotriAdmin({}, { departmentId: "dept-1" }),
      fakeRes(),
    );
    const filter = s.firstArg("find");
    assert.equal(filter.branch, "Gotri");
    assert.equal(filter.departmentId, "dept-1");
  } finally {
    s.restore();
  }
});

// ===================================================================
// 3. THE ACTUAL BOUNDARY — reaching a row by id
// ===================================================================

test("GET /employees/:id: a branch admin cannot read the other branch's staff", async () => {
  const s = stub({ findById: () => fakeQuery(staffRow({ branch: "Vasna" })) });
  try {
    const res = fakeRes();
    await getEmployeeById(gotriAdmin({}, { employeeId: "row-1" }), res);
    assert.equal(res.statusCode, 403, "cross-branch read by id must be refused");
    assert.equal(res.body.isOk, false);
  } finally {
    s.restore();
  }
});

test("GET /employees/:id: a branch admin CAN read their own branch's staff", async () => {
  const s = stub({ findById: () => fakeQuery(staffRow({ branch: "Vasna" })) });
  try {
    const res = fakeRes();
    await getEmployeeById(vasnaAdmin({}, { employeeId: "row-1" }), res);
    assert.equal(
      res.statusCode,
      200,
      "a branch admin must control their own staff",
    );
    assert.equal(res.body.isOk, true);
  } finally {
    s.restore();
  }
});

test("GET /employees/:id: a branch admin cannot read a super admin's row", async () => {
  const s = stub({
    findById: () => fakeQuery(staffRow({ branch: null, isSuperAdmin: true })),
  });
  try {
    const res = fakeRes();
    await getEmployeeById(vasnaAdmin({}, { employeeId: "owner" }), res);
    assert.equal(res.statusCode, 403);
  } finally {
    s.restore();
  }
});

test("GET /employees/:id: a super admin may read either branch", async () => {
  for (const branch of ["Vasna", "Gotri"]) {
    const s = stub({ findById: () => fakeQuery(staffRow({ branch })) });
    try {
      const res = fakeRes();
      await getEmployeeById(superAdmin({}, { employeeId: "row-1" }), res);
      assert.equal(res.statusCode, 200);
    } finally {
      s.restore();
    }
  }
});

test("PUT /employees/:id: a branch admin cannot edit the other branch's staff", async () => {
  const s = stub({
    findById: () => fakeQuery(staffRow({ branch: "Vasna" })),
    findOne: () => fakeQuery(null),
  });
  try {
    const res = fakeRes();
    await updateEmployee(
      gotriAdmin(
        { employeeName: "Hijacked", emailOffice: "x@example.com" },
        { employeeId: "row-1" },
      ),
      res,
    );
    assert.equal(res.statusCode, 403, "cross-branch edit by id must be refused");
  } finally {
    s.restore();
  }
});

test("PUT /employees/:id: a branch admin cannot edit a super admin", async () => {
  const s = stub({
    findById: () => fakeQuery(staffRow({ branch: null, isSuperAdmin: true })),
    findOne: () => fakeQuery(null),
  });
  try {
    const res = fakeRes();
    await updateEmployee(
      vasnaAdmin(
        { employeeName: "Takeover", emailOffice: "x@example.com" },
        { employeeId: "owner" },
      ),
      res,
    );
    assert.equal(res.statusCode, 403);
  } finally {
    s.restore();
  }
});

test("PUT /employees/:id: a branch admin CAN edit their own branch's staff", async () => {
  const row = staffRow({ branch: "Vasna" });
  const s = stub({
    findById: () => fakeQuery(row),
    findOne: () => fakeQuery(null),
  });
  try {
    const res = fakeRes();
    await updateEmployee(
      vasnaAdmin(
        { employeeName: "Renamed", emailOffice: "desk@example.com" },
        { employeeId: "row-1" },
      ),
      res,
    );
    assert.equal(
      res.statusCode,
      200,
      "a branch admin must control their own staff",
    );
    assert.equal(row.employeeName, "Renamed");
  } finally {
    s.restore();
  }
});

test("PUT /employees/:id: a branch admin cannot move their own staff to the other branch", async () => {
  const row = staffRow({ branch: "Vasna" });
  const s = stub({
    findById: () => fakeQuery(row),
    findOne: () => fakeQuery(null),
  });
  try {
    const res = fakeRes();
    await updateEmployee(
      vasnaAdmin(
        {
          employeeName: "Desk",
          emailOffice: "desk@example.com",
          branch: "Gotri",
        },
        { employeeId: "row-1" },
      ),
      res,
    );
    assert.equal(
      res.statusCode,
      403,
      "naming another branch is an attempt to widen",
    );
    assert.equal(row.branch, "Vasna", "the stored branch must be untouched");
  } finally {
    s.restore();
  }
});

test("PUT /employees/:id: a branch admin cannot promote anyone to super admin", async () => {
  const row = staffRow({ branch: "Vasna" });
  const s = stub({
    findById: () => fakeQuery(row),
    findOne: () => fakeQuery(null),
  });
  try {
    const res = fakeRes();
    await updateEmployee(
      vasnaAdmin(
        {
          employeeName: "Desk",
          emailOffice: "desk@example.com",
          branch: "Vasna",
          isSuperAdmin: true,
        },
        { employeeId: "row-1" },
      ),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(row.isSuperAdmin, false);
  } finally {
    s.restore();
  }
});

test("DELETE /employees/:id: a branch admin cannot delete the other branch's staff", async () => {
  const s = stub({
    findById: () => fakeQuery(staffRow({ branch: "Vasna" })),
    findByIdAndDelete: () => fakeQuery({}),
  });
  try {
    const res = fakeRes();
    await deleteEmployee(gotriAdmin({}, { employeeId: "row-1" }), res);
    assert.equal(
      res.statusCode,
      403,
      "cross-branch delete by id must be refused",
    );
    assert.equal(
      s.called("findByIdAndDelete"),
      false,
      "nothing may be deleted before the branch check",
    );
  } finally {
    s.restore();
  }
});

test("DELETE /employees/:id: a branch admin CAN delete their own branch's staff", async () => {
  const s = stub({
    findById: () => fakeQuery(staffRow({ branch: "Gotri" })),
    findByIdAndDelete: () => fakeQuery({}),
  });
  try {
    const res = fakeRes();
    await deleteEmployee(gotriAdmin({}, { employeeId: "row-1" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(s.called("findByIdAndDelete"), true);
  } finally {
    s.restore();
  }
});

test("POST /employees/:id/reset-password: cross-branch password takeover is refused", async () => {
  const row = staffRow({ branch: "Vasna", password: "old-hash" });
  const s = stub({ findById: () => fakeQuery(row) });
  try {
    const res = fakeRes();
    await resetPassword(
      gotriAdmin({ password: "newpass123" }, { employeeId: "row-1" }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(row.password, "old-hash", "the password must be untouched");
  } finally {
    s.restore();
  }
});

// ===================================================================
// 4. Creating staff — the new row must LAND in the creator's branch
// ===================================================================

/**
 * createEmployee builds a real mongoose Document, so `save` is stubbed on the
 * PROTOTYPE rather than on the model. That is what lets the assertion be about
 * the row as it would be PERSISTED, rather than about the request that
 * produced it — the distinction the whole "never echo req.body" rule rests on.
 */
const withCapturedSave = async (fn) => {
  const original = EmployeeModels.prototype.save;
  let saved = null;
  EmployeeModels.prototype.save = async function () {
    saved = this;
    return this;
  };
  try {
    await fn();
  } finally {
    EmployeeModels.prototype.save = original;
  }
  return saved;
};

/**
 * createEmployee/updateEmployee now consult middlewares/roleCeiling.js, which
 * reads RoleMaster and EmployeeRoles. Those are unrelated to the branch
 * scoping these tests pin, and there is no database here, so they are stubbed
 * to the permissive answer: a real active role that grants NOTHING, which
 * cannot exceed anybody's ceiling. The ceiling itself is tested separately in
 * roleAssignmentCeiling.test.mjs and, behaviourally, in
 * employeeRolesEscalation.test.mjs.
 *
 * Without this the guard finds no role, refuses, and every create/update test
 * fails with a 403 that has nothing to do with branches.
 */
const stubRoleLookup = () => {
  const roleFind = RoleMaster.findById;
  const permFind = EmployeeRoles.findOne;
  RoleMaster.findById = () => ({ lean: async () => ({ _id: "role-1", role: "Staff", isActive: true }) });
  EmployeeRoles.findOne = () => ({ lean: async () => ({ roles: [] }) });
  return () => {
    RoleMaster.findById = roleFind;
    EmployeeRoles.findOne = permFind;
  };
};

/**
 * Installed for the WHOLE file rather than per test: nothing here is about the
 * role ceiling, and threading a stub through ten call sites is ten chances to
 * forget one and get a 403 that looks like a scoping regression.
 */
let restoreRoleLookup = () => {};
before(() => { restoreRoleLookup = stubRoleLookup(); });
after(() => restoreRoleLookup());

const createBody = (over = {}) => ({
  employeeName: "New Hire",
  emailOffice: "hire@example.com",
  password: "secret123",
  roleId: "68000000000000000000000a",
  isActive: true,
  ...over,
});

test("POST /employees: a branch admin's new staff land in THEIR branch when none is given", async () => {
  const s = stub({ findOne: () => fakeQuery(null) });
  const res = fakeRes();
  try {
    const saved = await withCapturedSave(() =>
      createEmployee(vasnaAdmin(createBody()), res),
    );
    assert.equal(
      res.statusCode,
      201,
      "an omitted branch must be pinned, not refused",
    );
    assert.equal(saved.branch, "Vasna");
    assert.equal(saved.isSuperAdmin, false);
  } finally {
    s.restore();
  }
});

test("POST /employees: a branch admin cannot create staff in the other branch", async () => {
  const s = stub({ findOne: () => fakeQuery(null) });
  const res = fakeRes();
  try {
    const saved = await withCapturedSave(() =>
      createEmployee(vasnaAdmin(createBody({ branch: "Gotri" })), res),
    );
    assert.equal(res.statusCode, 403);
    assert.equal(saved, null, "nothing may be written");
  } finally {
    s.restore();
  }
});

test("POST /employees: a branch admin cannot mint a super admin", async () => {
  const s = stub({ findOne: () => fakeQuery(null) });
  const res = fakeRes();
  try {
    const saved = await withCapturedSave(() =>
      createEmployee(
        vasnaAdmin(createBody({ branch: "Vasna", isSuperAdmin: true })),
        res,
      ),
    );
    assert.equal(res.statusCode, 403);
    assert.equal(saved, null);
  } finally {
    s.restore();
  }
});

test("POST /employees: a branchless non-super-admin cannot create staff at all", async () => {
  const s = stub({ findOne: () => fakeQuery(null) });
  const res = fakeRes();
  try {
    const saved = await withCapturedSave(() =>
      createEmployee(branchlessAdmin(createBody()), res),
    );
    assert.equal(res.statusCode, 403);
    assert.equal(saved, null);
  } finally {
    s.restore();
  }
});

test("POST /employees: a super admin may still place staff in either branch, or all", async () => {
  for (const [requested, expected] of [
    ["Vasna", "Vasna"],
    ["Gotri", "Gotri"],
    ["", null],
    [undefined, null],
  ]) {
    const s = stub({ findOne: () => fakeQuery(null) });
    const res = fakeRes();
    try {
      const saved = await withCapturedSave(() =>
        createEmployee(superAdmin(createBody({ branch: requested })), res),
      );
      assert.equal(res.statusCode, 201);
      assert.equal(
        saved.branch,
        expected,
        `branch ${JSON.stringify(requested)}`,
      );
    } finally {
      s.restore();
    }
  }
});
