/**
 * OFFLINE branch-scoping tests for the Holiday Master, following the same
 * technique as scripts/tests/scoping.test.mjs: the real controllers are
 * imported and Holiday's/Branch's static query methods are replaced with
 * stubs that CAPTURE THE FILTER actually reaching Mongo.
 *
 * NO DATABASE.
 *
 * ============================================================================
 * THE TWO RULES UNDER TEST, STATED EXACTLY AS THE OWNER GAVE THEM
 * ============================================================================
 *   READ (list/calendar): a branch admin sees their OWN branch's holidays AND
 *   the all-branches ones (`branch: null`) — a gym-wide closure applies to
 *   them too.
 *
 *   WRITE (create/edit/delete): a branch admin may only touch their OWN
 *   branch's holidays — never an all-branches one, and never the other
 *   branch's. This is the line updateHoliday()/deleteHoliday() draw by using
 *   scopeFilter() (own branch only) rather than holidayReadFilter() (own +
 *   null) for their lookups — tests 2 and 3 below pin exactly that.
 *
 * A widen attempt (posting `branch: "Vasna"`, or `branch: null`, as a Gotri
 * admin) is asserted to be IGNORED outright, not merely rejected — the same
 * shape of test scoping.test.mjs runs for every other branch-scoped surface.
 */
import test from "node:test";
import assert from "node:assert/strict";

import Holiday from "../../models/Holiday.js";
import Branch from "../../models/Branch.js";

import {
  listHolidaysByParams,
  getHolidayCalendar,
  createHoliday,
  updateHoliday,
  deleteHoliday,
} from "../../controllers/v1/holiday.controller.js";

// ===================================================================
// Fixtures
// ===================================================================

const gotriAdmin = (query = {}, body = {}, params = {}) => ({
  session: {
    user: {
      id: "emp-gotri",
      role: "EMPLOYEE",
      name: "Gotri Manager",
      email: "gotri@example.com",
      branch: "Gotri",
      isSuperAdmin: false,
    },
  },
  // Present ON PURPOSE and wrong ON PURPOSE — see middlewares/branchScope.js.
  user: { id: "emp-gotri", role: "EMPLOYEE", email: "gotri@example.com", name: "Gotri Manager" },
  query,
  body,
  params,
  headers: {},
});

const vasnaAdmin = (query = {}, body = {}, params = {}) => ({
  session: {
    user: {
      id: "emp-vasna",
      role: "EMPLOYEE",
      name: "Vasna Manager",
      email: "vasna@example.com",
      branch: "Vasna",
      isSuperAdmin: false,
    },
  },
  user: { id: "emp-vasna", role: "EMPLOYEE", email: "vasna@example.com", name: "Vasna Manager" },
  query,
  body,
  params,
  headers: {},
});

const superAdmin = (query = {}, body = {}, params = {}) => ({
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
  user: { id: "owner", role: "ADMIN", email: "owner@example.com", name: "Owner" },
  query,
  body,
  params,
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

/** Replaces static methods on a model, recording every call's first argument. */
const stub = (model, methods) => {
  const original = {};
  const calls = [];
  for (const [name, impl] of Object.entries(methods)) {
    original[name] = model[name];
    model[name] = (...args) => {
      calls.push({ name, args });
      return impl(...args);
    };
  }
  return {
    calls,
    filters: () => calls.map((c) => c.args[0]),
    restore: () => {
      for (const [name, fn] of Object.entries(original)) model[name] = fn;
    },
  };
};

const fixtureHoliday = (over = {}) => ({
  _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  title: "Test Holiday",
  date: new Date("2026-09-14"),
  endDate: null,
  note: "",
  branch: "Gotri",
  isActive: true,
  toObject() {
    return this;
  },
  save: async function () {
    return this;
  },
  ...over,
});

// ===================================================================
// 1. LIST — own branch + all-branches, requested branch ignored for a
//    branch admin, honoured for a super admin
// ===================================================================

test("listHolidaysByParams: a branch admin sees own branch AND all-branches holidays", async () => {
  const s = stub(Holiday, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res = fakeRes();
    await listHolidaysByParams(gotriAdmin({}, {}), res);
    assert.equal(res.statusCode, 200);

    const countFilter = s.calls.find((c) => c.name === "countDocuments").args[0];
    assert.deepEqual(countFilter, { branch: { $in: ["Gotri", null] } });
  } finally {
    s.restore();
  }
});

test("listHolidaysByParams: a branch-supplied `branch` in the body cannot widen a branch admin's view", async () => {
  const s = stub(Holiday, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res = fakeRes();
    // Gotri admin explicitly asks for Vasna's holidays.
    await listHolidaysByParams(gotriAdmin({}, { branch: "Vasna" }), res);
    const countFilter = s.calls.find((c) => c.name === "countDocuments").args[0];
    assert.deepEqual(
      countFilter,
      { branch: { $in: ["Gotri", null] } },
      "the requested branch must be ignored outright",
    );
  } finally {
    s.restore();
  }
});

test("listHolidaysByParams: a super admin sees everything, or narrows to a requested branch", async () => {
  const s = stub(Holiday, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res1 = fakeRes();
    await listHolidaysByParams(superAdmin({}, {}), res1);
    assert.deepEqual(s.calls[0].args[0], {});

    s.calls.length = 0;
    const res2 = fakeRes();
    await listHolidaysByParams(superAdmin({}, { branch: "Vasna" }), res2);
    assert.deepEqual(s.calls[0].args[0], { branch: "Vasna" });
  } finally {
    s.restore();
  }
});

test("listHolidaysByParams: from/to overlap filter combines with branch scope via $and", async () => {
  const s = stub(Holiday, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res = fakeRes();
    await listHolidaysByParams(
      gotriAdmin({}, { from: "2026-09-01", to: "2026-09-30" }),
      res,
    );
    const filter = s.calls[0].args[0];
    assert.ok(Array.isArray(filter.$and), "date-overlap + branch scope must combine, not clobber");
    assert.ok(filter.$and.some((c) => c.branch));
    assert.ok(filter.$and.some((c) => c.$or));
  } finally {
    s.restore();
  }
});

// ===================================================================
// 2. CALENDAR — same scoping rule as list
// ===================================================================

test("getHolidayCalendar: requires year and month", async () => {
  const res = fakeRes();
  await getHolidayCalendar(gotriAdmin({}), res);
  assert.equal(res.statusCode, 400);
});

test("getHolidayCalendar: a branch admin's month view is scoped to own + all-branches", async () => {
  const s = stub(Holiday, { find: () => fakeQuery([]) });
  try {
    const res = fakeRes();
    await getHolidayCalendar(gotriAdmin({ year: "2026", month: "9" }), res);
    assert.equal(res.statusCode, 200);
    const filter = s.calls[0].args[0];
    assert.ok(filter.$and.some((c) => c.branch && JSON.stringify(c.branch.$in) === JSON.stringify(["Gotri", null])));
  } finally {
    s.restore();
  }
});

// ===================================================================
// 3. CREATE — branch always comes from the session for a branch admin
// ===================================================================

test("createHoliday: a branch admin's holiday is always filed under their own branch, body ignored", async () => {
  const s = stub(Holiday, {
    create: async (doc) => ({ ...doc, _id: "new-1" }),
  });
  // A branch admin's OWN branch still passes through resolveHolidayBranch()
  // (it is validated against the Branch master exactly like a super admin's
  // choice, for the same reasoning classSession.controller.js's createSession
  // gives), so Branch.findOne is stubbed here too.
  const branchStub = stub(Branch, { findOne: () => fakeQuery({ name: "Gotri" }) });
  try {
    const res = fakeRes();
    // Attempts BOTH an explicit other-branch AND an explicit null (widen to
    // "all branches") — neither may succeed.
    await createHoliday(
      gotriAdmin({}, { title: "Test", date: "2026-09-14", branch: "Vasna" }),
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(s.calls[0].args[0].branch, "Gotri");

    s.calls.length = 0;
    const res2 = fakeRes();
    await createHoliday(
      gotriAdmin({}, { title: "Test", date: "2026-09-14", branch: null }),
      res2,
    );
    assert.equal(res2.statusCode, 201);
    assert.equal(s.calls[0].args[0].branch, "Gotri");
  } finally {
    s.restore();
    branchStub.restore();
  }
});

test("createHoliday: a super admin may file an all-branches holiday (branch omitted -> null)", async () => {
  const s = stub(Holiday, {
    create: async (doc) => ({ ...doc, _id: "new-1" }),
  });
  try {
    const res = fakeRes();
    await createHoliday(superAdmin({}, { title: "National Holiday", date: "2026-09-14" }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(s.calls[0].args[0].branch, null);
  } finally {
    s.restore();
  }
});

test("createHoliday: a super admin naming a real physical branch gets that branch resolved", async () => {
  const holidayStub = stub(Holiday, {
    create: async (doc) => ({ ...doc, _id: "new-1" }),
  });
  const branchStub = stub(Branch, {
    findOne: () => fakeQuery({ name: "Vasna" }),
  });
  try {
    const res = fakeRes();
    await createHoliday(
      superAdmin({}, { title: "Branch Day", date: "2026-09-14", branch: "Vasna" }),
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(holidayStub.calls[0].args[0].branch, "Vasna");
  } finally {
    holidayStub.restore();
    branchStub.restore();
  }
});

test("createHoliday: an unknown/inactive branch name is rejected with 400, nothing written", async () => {
  const holidayStub = stub(Holiday, { create: async () => { throw new Error("must not be called"); } });
  const branchStub = stub(Branch, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await createHoliday(
      superAdmin({}, { title: "Bad", date: "2026-09-14", branch: "Nowhereville" }),
      res,
    );
    assert.equal(res.statusCode, 400);
  } finally {
    holidayStub.restore();
    branchStub.restore();
  }
});

test("createHoliday: title and date are required", async () => {
  const res1 = fakeRes();
  await createHoliday(gotriAdmin({}, { date: "2026-09-14" }), res1);
  assert.equal(res1.statusCode, 400);

  const res2 = fakeRes();
  await createHoliday(gotriAdmin({}, { title: "No date" }), res2);
  assert.equal(res2.statusCode, 400);
});

test("createHoliday: endDate before date is rejected", async () => {
  const res = fakeRes();
  await createHoliday(
    gotriAdmin({}, { title: "Bad range", date: "2026-09-14", endDate: "2026-09-10" }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

// ===================================================================
// 4. UPDATE / DELETE — own branch ONLY, never own+null (the line the owner
//    drew between viewing and editing an all-branches holiday)
// ===================================================================

test("updateHoliday: the lookup is scoped to the admin's OWN branch only — never includes null", async () => {
  const s = stub(Holiday, { findOne: async () => null });
  try {
    const res = fakeRes();
    await updateHoliday(gotriAdmin({}, { title: "X" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(
      s.calls[0].args[0],
      { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", branch: "Gotri" },
      "must use scopeFilter (own branch only), not holidayReadFilter (own + null)",
    );
  } finally {
    s.restore();
  }
});

test("updateHoliday: a branch admin cannot edit an all-branches holiday even though they can SEE it", async () => {
  // Simulates the real Mongo behaviour: { _id, branch: "Gotri" } cannot match
  // a document whose branch is null, so the stub returns null exactly as a
  // real findOne would for this filter.
  const s = stub(Holiday, {
    findOne: (filter) => (filter.branch === "Gotri" ? null : fixtureHoliday({ branch: null })),
  });
  try {
    const res = fakeRes();
    await updateHoliday(gotriAdmin({}, { title: "X" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 404);
  } finally {
    s.restore();
  }
});

test("updateHoliday: a branch admin cannot edit the OTHER branch's holiday", async () => {
  const s = stub(Holiday, {
    findOne: (filter) => (filter.branch === "Gotri" ? null : fixtureHoliday({ branch: "Vasna" })),
  });
  try {
    const res = fakeRes();
    await updateHoliday(gotriAdmin({}, { title: "X" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 404);
  } finally {
    s.restore();
  }
});

test("updateHoliday: a branch admin's own-branch holiday is editable, and a body.branch is silently ignored", async () => {
  const found = fixtureHoliday({ branch: "Gotri" });
  const s = stub(Holiday, {
    findOne: (filter) => (filter.branch === "Gotri" ? found : null),
  });
  try {
    const res = fakeRes();
    await updateHoliday(
      gotriAdmin({}, { title: "Renamed", branch: "Vasna" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(found.title, "Renamed");
    assert.equal(found.branch, "Gotri", "a branch admin can never move a holiday to another branch");
  } finally {
    s.restore();
  }
});

test("updateHoliday: a super admin MAY move a holiday between branches", async () => {
  const found = fixtureHoliday({ branch: "Gotri" });
  const holidayStub = stub(Holiday, { findOne: () => found });
  const branchStub = stub(Branch, { findOne: () => fakeQuery({ name: "Vasna" }) });
  try {
    const res = fakeRes();
    await updateHoliday(superAdmin({}, { branch: "Vasna" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(found.branch, "Vasna");
  } finally {
    holidayStub.restore();
    branchStub.restore();
  }
});

test("deleteHoliday: the lookup is scoped to the admin's OWN branch only", async () => {
  const s = stub(Holiday, { findOneAndDelete: async () => null });
  try {
    const res = fakeRes();
    await deleteHoliday(gotriAdmin({}, {}, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(s.calls[0].args[0], { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", branch: "Gotri" });
  } finally {
    s.restore();
  }
});

test("deleteHoliday: a super admin's lookup carries no branch restriction", async () => {
  const s = stub(Holiday, {
    findOneAndDelete: async () => fixtureHoliday({ branch: "Vasna" }),
  });
  try {
    const res = fakeRes();
    await deleteHoliday(superAdmin({}, {}, { id: "aaaaaaaaaaaaaaaaaaaaaaaa" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(s.calls[0].args[0], { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  } finally {
    s.restore();
  }
});
