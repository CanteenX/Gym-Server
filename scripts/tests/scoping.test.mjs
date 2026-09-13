/**
 * OFFLINE scoping tests for the Phase 4 reporting surface.
 *
 * Run:  node --test scripts/tests/scoping.test.mjs
 *
 * NO DATABASE. Mongoose schemas compile without a connection, so the real
 * models and the real controllers are imported and the model's static query
 * methods are replaced with stubs that CAPTURE THE FILTER and return fixtures.
 * That is the point: these tests assert what filter actually reached Mongo,
 * which is the only thing standing between a Gotri admin and Vasna's data.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE
 * The branch leak in this codebase is invisible when it happens. `req.user` has
 * no `branch`, so scope code written against it returns an empty filter, every
 * branch admin silently sees both branches, and nothing throws, logs or looks
 * wrong on screen. The same is true of a `"Common"` row landing in one branch's
 * P&L — it just makes that branch look unprofitable. Neither failure announces
 * itself, so neither can be caught by reading the code carefully.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  scopedBranch,
  scopeFilter,
  resolveBranchFilter,
  financialScopeFilter,
  isSuperAdmin,
} from "../../middlewares/branchScope.js";

import Member from "../../models/Member.js";
import Transaction from "../../models/Transaction.js";
import Attendance from "../../models/Attendance.js";
import AuditLog from "../../models/AuditLog.js";

import {
  getFootfall,
  getInGymNow,
  getNotCheckedIn,
} from "../../controllers/v1/attendanceStaff.controller.js";
import {
  getCollectionsReport,
  getProfitAndLoss,
} from "../../controllers/v1/report.controller.js";
import {
  getExpiryPipeline,
  getMemberAgeing,
} from "../../controllers/v1/memberReport.controller.js";
import {
  exportTransactions,
  exportMembers,
  exportAttendance,
} from "../../controllers/v1/export.controller.js";
import { listAuditLogsByParams } from "../../controllers/v1/auditLog.controller.js";

// ===================================================================
// Fixtures
// ===================================================================

/** A Gotri branch admin. Employee, branch set, not a super admin. */
const gotriAdmin = (query = {}, body = {}) => ({
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
  // Present ON PURPOSE, and wrong ON PURPOSE: if any controller ever reads
  // req.user instead of req.session.user it will read "no branch" and these
  // tests will fail loudly rather than leaking quietly.
  user: { id: "emp-gotri", role: "EMPLOYEE", email: "gotri@example.com", name: "Gotri Manager" },
  query,
  body,
  params: {},
  headers: {},
});

/** The owner. branch: null is how "all branches" is recorded. */
const superAdmin = (query = {}, body = {}) => ({
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
  params: {},
  headers: {},
});

/** Captures whatever the controller responded with. */
const fakeRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.write = () => true;
  res.end = () => {};
  res.once = (_event, cb) => cb();
  res.destroy = () => {};
  res.headersSent = false;
  return res;
};

/** A chainable stand-in for a mongoose Query. */
const fakeQuery = (result) => {
  const q = {};
  for (const m of [
    "select",
    "sort",
    "skip",
    "limit",
    "populate",
    "lean",
    "clone",
  ]) {
    q[m] = () => q;
  }
  q.exec = async () => result;
  q.then = (onOk, onErr) => Promise.resolve(result).then(onOk, onErr);
  q.cursor = () => ({
    async *[Symbol.asyncIterator]() {
      for (const row of result) yield row;
    },
    close: async () => {},
  });
  return q;
};

/**
 * Replaces the given static methods on a model, recording every filter they
 * were called with. Returns { calls, restore }.
 */
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

/** The $match stage of an aggregation pipeline. */
const matchOf = (pipeline) =>
  (pipeline || []).find((stage) => stage && stage.$match)?.$match || {};

// ===================================================================
// 1. The helpers themselves
// ===================================================================

test("scopedBranch: branch admin is pinned, super admin is unrestricted", () => {
  assert.equal(scopedBranch(gotriAdmin()), "Gotri");
  assert.equal(scopedBranch(superAdmin()), null);
  // No session at all — anonymous. Unrestricted here only because every caller
  // is behind authMiddleware; the helper is not an auth check.
  assert.equal(scopedBranch({ session: {} }), null);
});

test("scopeFilter: returns a branch match for a branch admin, {} for a super admin", () => {
  assert.deepEqual(scopeFilter(gotriAdmin()), { branch: "Gotri" });
  assert.deepEqual(scopeFilter(superAdmin()), {});
});

test("resolveBranchFilter: a client branch narrows a super admin, never widens a branch admin", () => {
  assert.equal(resolveBranchFilter(gotriAdmin(), "Vasna"), "Gotri");
  assert.equal(resolveBranchFilter(gotriAdmin(), "Common"), "Gotri");
  assert.equal(resolveBranchFilter(gotriAdmin(), ""), "Gotri");
  assert.equal(resolveBranchFilter(superAdmin(), "Vasna"), "Vasna");
  assert.equal(resolveBranchFilter(superAdmin(), ""), "");
});

test("financialScopeFilter: a branch admin can never reach Common", () => {
  assert.deepEqual(financialScopeFilter(gotriAdmin(), "Common"), {
    branch: "Gotri",
  });
  assert.deepEqual(financialScopeFilter(gotriAdmin(), "Vasna"), {
    branch: "Gotri",
  });
  assert.deepEqual(financialScopeFilter(superAdmin(), "Common"), {
    branch: "Common",
  });
  assert.deepEqual(financialScopeFilter(superAdmin(), ""), {});
});

test("isSuperAdmin reads the session, and an ADMIN role alone is not enough", () => {
  assert.equal(isSuperAdmin(superAdmin()), true);
  assert.equal(isSuperAdmin(gotriAdmin()), false);
  // A branch-scoped ADMIN: the role says ADMIN, the session says one branch.
  const branchOwner = {
    session: { user: { id: "x", role: "ADMIN", branch: "Vasna", isSuperAdmin: false } },
  };
  assert.equal(isSuperAdmin(branchOwner), false);
  assert.deepEqual(scopeFilter(branchOwner), { branch: "Vasna" });
});

// ===================================================================
// 2. Attendance views
// ===================================================================

test("footfall: a branch admin's query is pinned to their branch even when they ask for another", async () => {
  const s = stub(Attendance, { aggregate: async () => [] });
  try {
    const res = fakeRes();
    await getFootfall(gotriAdmin({ branch: "Vasna" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(matchOf(s.calls[0].args[0]).branch, "Gotri");
  } finally {
    s.restore();
  }
});

test("footfall: a super admin is unrestricted by default and narrows on request", async () => {
  let s = stub(Attendance, { aggregate: async () => [] });
  try {
    await getFootfall(superAdmin(), fakeRes());
    assert.equal(matchOf(s.calls[0].args[0]).branch, undefined);
  } finally {
    s.restore();
  }

  s = stub(Attendance, { aggregate: async () => [] });
  try {
    await getFootfall(superAdmin({ branch: "Vasna" }), fakeRes());
    assert.equal(matchOf(s.calls[0].args[0]).branch, "Vasna");
  } finally {
    s.restore();
  }
});

/**
 * All FOUR queries the live feed now runs carry the branch.
 *
 * It was two — open sessions and the stale count — until Phase 3's denial gap
 * was closed and the feed also began returning today's refusals plus their
 * count (attendanceStaff.controller.js). The exact number is asserted, not just
 * "every filter seen", so that a fifth query added later cannot slip in
 * unscoped: a filter that is never built is also never checked by the loop
 * above it.
 *
 * See scripts/tests/attendanceOverride.test.mjs for what those two new queries
 * actually ask for.
 */
test("live: all four queries — sessions, stale, denials, denial count — carry the branch", async () => {
  const s = stub(Attendance, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res = fakeRes();
    await getInGymNow(gotriAdmin({ branch: "Common" }), res);
    assert.equal(res.statusCode, 200);
    for (const f of s.filters()) assert.equal(f.branch, "Gotri");
    assert.equal(s.filters().length, 4);
  } finally {
    s.restore();
  }
});

test("not-checked-in: the roster is branch-scoped, and the wording is 'checked in'", async () => {
  const sm = stub(Member, { find: () => fakeQuery([]) });
  const sa = stub(Attendance, { distinct: async () => [], aggregate: async () => [] });
  try {
    const res = fakeRes();
    await getNotCheckedIn(gotriAdmin({ branch: "Vasna", days: "30" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sm.filters()[0].branch, "Gotri");
    assert.equal(sm.filters()[0].isActive, true);
    assert.equal(res.body.data.days, 30);
    // The label is part of the contract — see attendanceStaff.controller.js.
    assert.match(res.body.message, /check-?\s?in/i);
    assert.doesNotMatch(res.body.message, /visit/i);
    assert.match(res.body.data.basis, /logging behaviour/i);
  } finally {
    sm.restore();
    sa.restore();
  }
});

// ===================================================================
// 3. Financial reports — the "Common" rule
// ===================================================================

test("collections: a branch admin's ledger query is pinned and direction IN", async () => {
  const s = stub(Transaction, { aggregate: async () => [] });
  try {
    const res = fakeRes();
    await getCollectionsReport(gotriAdmin({ branch: "Common" }), res);
    assert.equal(res.statusCode, 200);
    const m = matchOf(s.calls[0].args[0]);
    assert.equal(m.branch, "Gotri");
    assert.equal(m.direction, "IN");
    assert.equal(res.body.data.source, "Transaction ledger (direction: IN)");
  } finally {
    s.restore();
  }
});

/**
 * The important one. The fixture deliberately contains a "Common" row, as if
 * the scope helper had been bypassed, so the split is tested rather than the
 * helper being tested twice.
 */
const plFixture = [
  { _id: { branch: "Vasna", direction: "IN" }, total: 100000, count: 40 },
  { _id: { branch: "Vasna", direction: "OUT" }, total: 30000, count: 10 },
  { _id: { branch: "Gotri", direction: "IN" }, total: 80000, count: 30 },
  { _id: { branch: "Gotri", direction: "OUT" }, total: 20000, count: 8 },
  { _id: { branch: "Common", direction: "OUT" }, total: 50000, count: 5 },
];

test("P&L: a branch admin sees only their branch, and never Common", async () => {
  const s = stub(Transaction, {
    aggregate: async (pipeline) => {
      const m = matchOf(pipeline);
      // Mimic Mongo: honour the filter the controller actually sent.
      const rows = m.direction === "OUT" ? [] : plFixture;
      return m.branch ? rows.filter((r) => r._id.branch === m.branch) : rows;
    },
  });
  try {
    const res = fakeRes();
    await getProfitAndLoss(gotriAdmin({ branch: "Common" }), res);
    assert.equal(res.statusCode, 200);

    const d = res.body.data;
    assert.deepEqual(
      d.branches.map((b) => b.branch),
      ["Gotri"],
    );
    assert.equal(d.common, null, "Common must be null for a branch admin");
    assert.equal(
      d.consolidated,
      null,
      "a branch's numbers are not the business's numbers",
    );
    // And nothing anywhere in the payload mentions the shared-cost bucket.
    assert.doesNotMatch(JSON.stringify(d.branches), /Common/);
  } finally {
    s.restore();
  }
});

test("P&L: a super admin sees Common as its own block, not folded into a branch", async () => {
  const s = stub(Transaction, {
    aggregate: async (pipeline) => {
      const m = matchOf(pipeline);
      const rows = m.direction === "OUT" ? [] : plFixture;
      return m.branch ? rows.filter((r) => r._id.branch === m.branch) : rows;
    },
  });
  try {
    const res = fakeRes();
    await getProfitAndLoss(superAdmin(), res);
    const d = res.body.data;

    assert.deepEqual(
      d.branches.map((b) => b.branch).sort(),
      ["Gotri", "Vasna"],
      "branches[] must never contain Common",
    );

    const vasna = d.branches.find((b) => b.branch === "Vasna");
    assert.equal(vasna.income, 100000);
    assert.equal(vasna.expense, 30000, "Common's 50000 must not land here");
    assert.equal(vasna.net, 70000);

    assert.ok(d.common, "a super admin must see the shared-cost block");
    assert.equal(d.common.expense, 50000);

    // Consolidated is the only figure that includes Common.
    assert.equal(d.consolidated.income, 180000);
    assert.equal(d.consolidated.expense, 100000);
    assert.equal(d.consolidated.net, 80000);
  } finally {
    s.restore();
  }
});

test("P&L: a branch admin cannot reach Common even if the aggregation returns it", async () => {
  // The scope helper is bypassed here on purpose: the fixture ignores the
  // filter entirely, which is what a future bug in a query would look like.
  const s = stub(Transaction, { aggregate: async () => plFixture });
  try {
    const res = fakeRes();
    await getProfitAndLoss(gotriAdmin(), res);
    const d = res.body.data;
    assert.equal(d.common, null);
    assert.ok(
      !d.branches.some((b) => b.branch === "Common"),
      "splitCommon must drop Common for a non-super-admin",
    );
  } finally {
    s.restore();
  }
});

// ===================================================================
// 4. Member reports
// ===================================================================

test("expiry pipeline: branch-scoped, active members only", async () => {
  const s = stub(Member, { find: () => fakeQuery([]) });
  try {
    const res = fakeRes();
    await getExpiryPipeline(gotriAdmin({ branch: "Vasna" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(s.filters()[0], { isActive: true, branch: "Gotri" });
  } finally {
    s.restore();
  }
});

test("member ageing: branch-scoped, and dues come from the ledger, never Member.payments", async () => {
  const s = stub(Member, {
    aggregate: async () => [
      {
        _id: "m1",
        fullName: "A",
        branch: "Gotri",
        startDate: new Date(Date.now() - 100 * 86400000),
        createdAt: new Date(Date.now() - 400 * 86400000),
        totalFee: 3000,
        // 1200 received per the ledger lookup; payments[] is not consulted.
        paid: 1200,
      },
    ],
  });
  try {
    const res = fakeRes();
    await getMemberAgeing(gotriAdmin({ branch: "Vasna" }), res);
    assert.equal(res.statusCode, 200);

    const pipeline = s.calls[0].args[0];
    assert.equal(matchOf(pipeline).branch, "Gotri");

    // The lookup must read the ledger collection, not a member subdocument.
    const lookup = pipeline.find((st) => st.$lookup)?.$lookup;
    assert.equal(lookup.from, "transactions");

    assert.equal(res.body.data.totalOutstanding, 1800);
    assert.equal(res.body.data.topDebtors[0].balance, 1800);
    assert.match(res.body.data.source, /Member\.payments\[\] is never summed/);
  } finally {
    s.restore();
  }
});

// ===================================================================
// 5. CSV exports — the highest-consequence leak
// ===================================================================

test("export transactions: pinned to the caller's branch, Common unreachable", async () => {
  const s = stub(Transaction, { find: () => fakeQuery([]) });
  try {
    const res = fakeRes();
    await exportTransactions(
      gotriAdmin({ branch: "Common", format: "json" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(s.filters()[0].branch, "Gotri");
  } finally {
    s.restore();
  }
});

test("export transactions: a super admin may narrow to Common", async () => {
  const s = stub(Transaction, { find: () => fakeQuery([]) });
  try {
    await exportTransactions(superAdmin({ branch: "Common", format: "json" }), fakeRes());
    assert.equal(s.filters()[0].branch, "Common");
  } finally {
    s.restore();
  }
});

test("export members: branch-scoped, and no credentials or ID proofs in the columns", async () => {
  const s = stub(Member, { find: () => fakeQuery([]) });
  try {
    const res = fakeRes();
    await exportMembers(gotriAdmin({ branch: "Vasna", format: "json" }), res);
    assert.equal(s.filters()[0].branch, "Gotri");

    // Column labels are the header row of a file that leaves the building.
    const columns = JSON.stringify(res.body.data);
    for (const forbidden of ["password", "idProof", "loginId", "payments"]) {
      assert.doesNotMatch(columns, new RegExp(forbidden, "i"));
    }
  } finally {
    s.restore();
  }
});

test("export attendance: branch-scoped", async () => {
  const s = stub(Attendance, { find: () => fakeQuery([]) });
  try {
    await exportAttendance(gotriAdmin({ branch: "Vasna", format: "json" }), fakeRes());
    assert.equal(s.filters()[0].branch, "Gotri");
  } finally {
    s.restore();
  }
});

test("CSV cells cannot smuggle a spreadsheet formula", async () => {
  const { csvCell, csvRow } = await import("../../utils/csv.js");
  assert.equal(csvCell("=HYPERLINK(\"http://evil\")"), "\"'=HYPERLINK(\"\"http://evil\"\")\"");
  assert.equal(csvCell("+1234"), "'+1234");
  assert.equal(csvCell("-SUM(A1)"), "'-SUM(A1)");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("with,comma"), '"with,comma"');
  assert.equal(csvRow(["a", "b"]), "a,b\r\n");
});

// ===================================================================
// 6. Audit log viewer
// ===================================================================

test("audit log list: the session branch overrides whatever the body asked for", async () => {
  const s = stub(AuditLog, {
    find: () => fakeQuery([]),
    countDocuments: async () => 0,
  });
  try {
    const res = fakeRes();
    await listAuditLogsByParams(
      gotriAdmin({}, { branch: "Vasna", per_page: 9999 }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(s.filters()[0].branch, "Gotri");
    assert.equal(s.filters()[1].branch, "Gotri", "the count must use the same filter");
  } finally {
    s.restore();
  }
});

test("audit log list: a super admin is unrestricted, and may narrow", async () => {
  let s = stub(AuditLog, { find: () => fakeQuery([]), countDocuments: async () => 0 });
  try {
    await listAuditLogsByParams(superAdmin({}, {}), fakeRes());
    assert.equal(s.filters()[0].branch, undefined);
  } finally {
    s.restore();
  }

  s = stub(AuditLog, { find: () => fakeQuery([]), countDocuments: async () => 0 });
  try {
    await listAuditLogsByParams(superAdmin({}, { branch: "Vasna" }), fakeRes());
    assert.equal(s.filters()[0].branch, "Vasna");
  } finally {
    s.restore();
  }
});
