/**
 * OFFLINE branch-scoping tests for the BY-ID routes on members, transactions
 * and trainers.
 *
 * Run:  node --test scripts/tests/byIdScoping.test.mjs
 *
 * NO DATABASE, same technique as scripts/tests/scoping.test.mjs and
 * employeeScoping.test.mjs: mongoose schemas compile without a connection, so
 * the real controllers are imported and the models' statics are replaced with
 * stubs that CAPTURE THE FILTER. What is asserted is the filter that actually
 * reached Mongo and the status code that actually came back — not that some
 * helper returns the right string.
 *
 * ============================================================================
 * WHAT THESE TESTS EXIST TO PIN DOWN
 * ============================================================================
 *
 * A confirmed, live-verified cross-branch IDOR. The LIST endpoints were scoped
 * from the start — listMembersByParams, listTransactionsByParams (through
 * buildFilter) and listTrainersByParams all apply the branch helpers — but
 * every BY-ID handler called findById(id) with no filter at all. Verified
 * against production, in both directions, for admins and for staff:
 *
 *     GET /api/v1/members/<Gotri member id>        as Vasna  -> 200, full record
 *     GET /api/v1/members/<Vasna member id>        as Gotri  -> 200
 *     GET /api/v1/transactions/<Gotri txn>/receipt as Vasna  -> 200, receipt
 *
 * A scoped list plus an unscoped by-id read is not partial protection, it is no
 * protection: ids travel in URLs, exports, receipts and screenshots, and the
 * by-id route is the real boundary. The audit only exercised READS; the same
 * pattern sat on updateMember, deleteMember, addPayment, renewMembership,
 * updateTransaction and deleteTransaction, where it is a cross-branch WRITE.
 *
 * TWO THINGS ARE ASSERTED AT EVERY SITE, AND BOTH ARE LOAD-BEARING:
 *
 *   1. THE FILTER carries the caller's branch. This is the real regression
 *      guard. A test that only checks "404 when the stub returns null" still
 *      passes if someone deletes the scope filter, because an unscoped query
 *      against a stub returning null also produces null.
 *   2. THE STATUS is 404, never 403. A 403 would confirm the id is real and
 *      belongs to the other branch — the disclosure itself. Out of scope must
 *      be indistinguishable from does not exist.
 *
 * Note the deliberate difference between the two helpers: Member and Trainer
 * use scopeFilter(), Transaction uses financialScopeFilter(), because
 * Transaction.branch has a third value "Common" (shared rent, software, the
 * owner's salary) that must never fold into a single branch's P&L.
 */
import test from "node:test";
import assert from "node:assert/strict";

import Member from "../../models/Member.js";
import MembershipPlan from "../../models/MembershipPlan.js";
import Transaction from "../../models/Transaction.js";
import Trainer from "../../models/Trainer.js";

import {
  getMemberById,
  updateMember,
  deleteMember,
  addPayment,
  renewMembership,
} from "../../controllers/v1/member.controller.js";
import {
  getReceipt,
  updateTransaction,
  deleteTransaction,
} from "../../controllers/v1/transaction.controller.js";
import {
  updateTrainer,
  deleteTrainer,
  assignMembers,
} from "../../controllers/v1/trainer.controller.js";

// ===================================================================
// Fixtures
// ===================================================================

/**
 * A staff session. `user` is present ON PURPOSE and lossy ON PURPOSE: it is the
 * four-field copy authMiddleware really builds, carrying no branch and no
 * isSuperAdmin. If any of this code is ever rewritten against req.user it will
 * read "no branch", conclude "unrestricted", and these tests will fail loudly
 * instead of leaking quietly. See middlewares/branchScope.js.
 */
const staffSession = (branch, role, body = {}, params = {}) => {
  const id = `${role}-${String(branch).toLowerCase()}`;
  const email = `${String(branch).toLowerCase()}@example.com`;
  return {
    session: {
      user: {
        id,
        role,
        name: `${branch} ${role}`,
        email,
        branch,
        isSuperAdmin: false,
      },
    },
    user: { id, role, email, name: `${branch} ${role}` },
    body,
    params,
    query: {},
    files: undefined,
    headers: {},
  };
};

/** nventra01@gmail.com / nventra02@gmail.com have these shapes in production. */
const vasnaAdmin = (body, params) =>
  staffSession("Vasna", "EMPLOYEE", body, params);
const gotriAdmin = (body, params) =>
  staffSession("Gotri", "EMPLOYEE", body, params);

/** A non-admin staff login at a branch — the audit confirmed the leak here too. */
const vasnaStaff = (body, params) =>
  staffSession("Vasna", "EMPLOYEE", body, params);

/** The owner. branch: null is how "all branches" is recorded on an Employee. */
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
  files: undefined,
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

/** Replaces statics on a model, recording every call. */
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
    firstArg: (name) => calls.find((c) => c.name === name)?.args[0],
    called: (name) => calls.some((c) => c.name === name),
    restore: () => {
      for (const [name, fn] of Object.entries(original)) {
        model[name] = fn;
      }
    },
  };
};

/** Stubs several models at once; restore() undoes them all. */
const stubAll = (pairs) => {
  const stubs = pairs.map(([model, methods]) => stub(model, methods));
  return {
    at: (i) => stubs[i],
    restore: () => stubs.forEach((s) => s.restore()),
  };
};

const memberRow = (over = {}) => ({
  _id: "member-1",
  fullName: "Asha Patel",
  mobileNumber: "9999900001",
  branch: "Gotri",
  payments: [],
  endDate: new Date("2026-12-31"),
  planCode: "M1",
  totalFee: 6000,
  save: async function () {
    return this;
  },
  ...over,
});

const txnRow = (over = {}) => ({
  _id: "txn-1",
  direction: "IN",
  amount: 3000,
  receiptNo: "R-0001",
  memberName: "Asha Patel",
  memberMobile: "9999900001",
  branch: "Gotri",
  isActive: true,
  save: async function () {
    return this;
  },
  ...over,
});

const trainerRow = (over = {}) => ({
  _id: "trainer-1",
  fullName: "Ravi Shah",
  mobileNumber: "9999900002",
  branch: "Gotri",
  save: async function () {
    return this;
  },
  ...over,
});

/**
 * The single most important assertion in this file: the branch reached Mongo.
 *
 * Asserting only on the 404 is not enough — an unscoped query against a stub
 * that returns null produces the same 404. This asserts the scope was applied.
 */
const assertScoped = (filter, branch, what) => {
  assert.ok(filter, `${what}: no filter reached the model at all`);
  assert.equal(
    filter.branch,
    branch,
    `${what}: the query must be pinned to ${branch}`,
  );
};

const assertUnscoped = (filter, what) => {
  assert.ok(filter, `${what}: no filter reached the model at all`);
  assert.equal(
    filter.branch,
    undefined,
    `${what}: a super admin must not be branch-filtered`,
  );
};

/** The 404 contract: refused, and indistinguishable from "does not exist". */
const assertRefusedAs404 = (res, what) => {
  assert.equal(res.statusCode, 404, `${what}: must be refused`);
  assert.notEqual(
    res.statusCode,
    403,
    `${what}: 403 would confirm the row exists in the other branch`,
  );
  assert.equal(res.body.isOk, false, `${what}: envelope must report failure`);
};

// ===================================================================
// 1. MEMBERS — reads
// ===================================================================

test("GET /members/:id — a Vasna admin is refused a Gotri member (the live IDOR)", async () => {
  // The stub answers null because the real query, once scoped, matches nothing.
  const s = stub(Member, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await getMemberById(vasnaAdmin({}, { id: "member-1" }), res);
    assertScoped(s.firstArg("findOne"), "Vasna", "GET /members/:id");
    assert.equal(s.firstArg("findOne")._id, "member-1");
    assertRefusedAs404(res, "cross-branch member read");
  } finally {
    s.restore();
  }
});

test("GET /members/:id — branch STAFF, not only admins, are scoped", async () => {
  const s = stub(Member, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await getMemberById(vasnaStaff({}, { id: "member-1" }), res);
    assertScoped(s.firstArg("findOne"), "Vasna", "staff GET /members/:id");
    assertRefusedAs404(res, "cross-branch member read by staff");
  } finally {
    s.restore();
  }
});

test("GET /members/:id — a branch admin CAN still read their own branch's member", async () => {
  const s = stub(Member, {
    findOne: () => fakeQuery(memberRow({ branch: "Gotri" })),
  });
  try {
    const res = fakeRes();
    await getMemberById(gotriAdmin({}, { id: "member-1" }), res);
    assertScoped(s.firstArg("findOne"), "Gotri", "own-branch read");
    assert.equal(res.statusCode, 200, "scoping must not break the normal path");
    assert.equal(res.body.data.fullName, "Asha Patel");
  } finally {
    s.restore();
  }
});

test("GET /members/:id — a super admin reaches a member in EITHER branch", async () => {
  for (const branch of ["Vasna", "Gotri"]) {
    const s = stub(Member, { findOne: () => fakeQuery(memberRow({ branch })) });
    try {
      const res = fakeRes();
      await getMemberById(superAdmin({}, { id: "member-1" }), res);
      assertUnscoped(s.firstArg("findOne"), `super admin read of ${branch}`);
      assert.equal(res.statusCode, 200);
    } finally {
      s.restore();
    }
  }
});

// ===================================================================
// 2. MEMBERS — writes. The half the audit never exercised.
// ===================================================================

test("PUT /members/:id — a Vasna admin cannot EDIT a Gotri member", async () => {
  const s = stub(Member, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await updateMember(
      vasnaAdmin(
        { fullName: "Hijacked", mobileNumber: "1" },
        { id: "member-1" },
      ),
      res,
    );
    assertScoped(s.firstArg("findOne"), "Vasna", "PUT /members/:id");
    assertRefusedAs404(res, "cross-branch member edit");
  } finally {
    s.restore();
  }
});

test("PUT /members/:id — a same-branch edit still works and persists", async () => {
  const row = memberRow({ branch: "Gotri" });
  const s = stub(Member, { findOne: () => fakeQuery(row) });
  try {
    const res = fakeRes();
    await updateMember(
      gotriAdmin({ fullName: "Asha P." }, { id: "member-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(row.fullName, "Asha P.", "the legitimate edit must land");
  } finally {
    s.restore();
  }
});

test("DELETE /members/:id — a Gotri admin cannot DELETE a Vasna member, and nothing is removed", async () => {
  const s = stub(Member, {
    findOne: () => fakeQuery(null),
    findOneAndDelete: () => fakeQuery({}),
  });
  try {
    const res = fakeRes();
    await deleteMember(gotriAdmin({}, { id: "member-1" }), res);
    assertScoped(s.firstArg("findOne"), "Gotri", "DELETE /members/:id");
    assertRefusedAs404(res, "cross-branch member delete");
    assert.equal(
      s.called("findOneAndDelete"),
      false,
      "nothing may be deleted once the scoped lookup misses",
    );
  } finally {
    s.restore();
  }
});

test("DELETE /members/:id — the delete itself is scoped too, not just the guard", async () => {
  const s = stub(Member, {
    findOne: () => fakeQuery(memberRow({ branch: "Gotri" })),
    findOneAndDelete: () => fakeQuery({}),
  });
  try {
    const res = fakeRes();
    await deleteMember(gotriAdmin({}, { id: "member-1" }), res);
    assert.equal(res.statusCode, 200);
    assertScoped(s.firstArg("findOneAndDelete"), "Gotri", "the delete write");
  } finally {
    s.restore();
  }
});

test("POST /members/:id/payments — a Vasna admin cannot post money onto a Gotri member", async () => {
  const s = stub(Member, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await addPayment(vasnaAdmin({ amount: 500 }, { id: "member-1" }), res);
    assertScoped(s.firstArg("findOne"), "Vasna", "POST /members/:id/payments");
    assertRefusedAs404(res, "cross-branch payment");
  } finally {
    s.restore();
  }
});

test("POST /members/:id/renew — a Vasna admin cannot renew a Gotri member", async () => {
  // MembershipPlan is stubbed so the allowed path could not buffer against a
  // dead connection; the refusal must return before it is ever reached.
  const s = stubAll([
    [Member, { findOne: () => fakeQuery(null) }],
    [MembershipPlan, { findOne: () => fakeQuery(null) }],
  ]);
  try {
    const res = fakeRes();
    await renewMembership(
      vasnaAdmin({ planCode: "M1", totalFee: 1 }, { id: "member-1" }),
      res,
    );
    assertScoped(
      s.at(0).firstArg("findOne"),
      "Vasna",
      "POST /members/:id/renew",
    );
    assertRefusedAs404(res, "cross-branch renewal");
    assert.equal(
      s.at(1).called("findOne"),
      false,
      "a refused renewal must not even look up the plan",
    );
  } finally {
    s.restore();
  }
});

// ===================================================================
// 3. TRANSACTIONS — financialScopeFilter, so "Common" is covered too
// ===================================================================

test("GET /transactions/:id/receipt — a Gotri admin is refused a Vasna receipt (the live IDOR)", async () => {
  const s = stub(Transaction, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await getReceipt(gotriAdmin({}, { id: "txn-1" }), res);
    assertScoped(s.firstArg("findOne"), "Gotri", "GET receipt");
    assertRefusedAs404(res, "cross-branch receipt read");
  } finally {
    s.restore();
  }
});

test("GET /transactions/:id/receipt — a branch admin's filter excludes 'Common' as well", async () => {
  // "Common" holds shared rent, software and the owner's salary. Pinning the
  // filter to exactly one branch is what keeps it out: it is neither "Vasna"
  // nor absent-from-the-filter.
  const s = stub(Transaction, { findOne: () => fakeQuery(null) });
  try {
    await getReceipt(vasnaAdmin({}, { id: "txn-common" }), fakeRes());
    const filter = s.firstArg("findOne");
    assert.equal(filter.branch, "Vasna");
    assert.notEqual(
      filter.branch,
      "Common",
      "Common must never fold into a single branch's view",
    );
  } finally {
    s.restore();
  }
});

test("GET /transactions/:id/receipt — a super admin reaches a receipt in any branch", async () => {
  for (const branch of ["Vasna", "Gotri", "Common"]) {
    const s = stub(Transaction, {
      findOne: () => fakeQuery(txnRow({ branch })),
    });
    try {
      const res = fakeRes();
      await getReceipt(superAdmin({}, { id: "txn-1" }), res);
      assertUnscoped(s.firstArg("findOne"), `super admin receipt in ${branch}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.receiptNo, "R-0001");
    } finally {
      s.restore();
    }
  }
});

test("PUT /transactions/:id — a Gotri admin cannot EDIT a Vasna ledger row", async () => {
  const s = stub(Transaction, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await updateTransaction(gotriAdmin({ amount: 1 }, { id: "txn-1" }), res);
    assertScoped(s.firstArg("findOne"), "Gotri", "PUT /transactions/:id");
    assertRefusedAs404(res, "cross-branch ledger edit");
  } finally {
    s.restore();
  }
});

test("PUT /transactions/:id — a branch admin cannot move one of their OWN rows out of their branch", async () => {
  // The same boundary, crossed on the way out. Reaching the row is legitimate;
  // re-branding it "Gotri" or "Common" would move the money off their P&L.
  for (const attempt of ["Gotri", "Common"]) {
    const row = txnRow({ branch: "Vasna" });
    const s = stub(Transaction, { findOne: () => fakeQuery(row) });
    try {
      const res = fakeRes();
      await updateTransaction(
        vasnaAdmin({ note: "ok", branch: attempt }, { id: "txn-1" }),
        res,
      );
      assert.equal(res.statusCode, 200, "the legitimate part of the edit lands");
      assert.equal(row.note, "ok");
      assert.equal(
        row.branch,
        "Vasna",
        `a branch admin must not be able to set branch=${attempt}`,
      );
    } finally {
      s.restore();
    }
  }
});

test("PUT /transactions/:id — a super admin MAY still re-branch a row", async () => {
  const row = txnRow({ branch: "Vasna" });
  const s = stub(Transaction, { findOne: () => fakeQuery(row) });
  try {
    const res = fakeRes();
    await updateTransaction(
      superAdmin({ branch: "Common" }, { id: "txn-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(row.branch, "Common", "the owner keeps full control");
  } finally {
    s.restore();
  }
});

test("DELETE /transactions/:id — a Vasna admin cannot cancel a Gotri entry", async () => {
  const row = txnRow({ branch: "Gotri", isActive: true });
  const s = stub(Transaction, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await deleteTransaction(vasnaAdmin({}, { id: "txn-1" }), res);
    assertScoped(s.firstArg("findOne"), "Vasna", "DELETE /transactions/:id");
    assertRefusedAs404(res, "cross-branch ledger cancel");
    assert.equal(row.isActive, true, "the row must stay live");
  } finally {
    s.restore();
  }
});

// ===================================================================
// 4. TRAINERS — the same pattern, found while fixing the above
// ===================================================================

test("PUT /trainers/:id — a Vasna admin cannot edit a Gotri trainer", async () => {
  const s = stub(Trainer, { findOne: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await updateTrainer(vasnaAdmin({ fullName: "X" }, { id: "trainer-1" }), res);
    assertScoped(s.firstArg("findOne"), "Vasna", "PUT /trainers/:id");
    assertRefusedAs404(res, "cross-branch trainer edit");
  } finally {
    s.restore();
  }
});

test("PUT /trainers/:id — a branch admin cannot move their own trainer to the other branch", async () => {
  const row = trainerRow({ branch: "Vasna" });
  const s = stub(Trainer, { findOne: () => fakeQuery(row) });
  try {
    const res = fakeRes();
    await updateTrainer(
      vasnaAdmin({ fullName: "Ravi S.", branch: "Gotri" }, { id: "trainer-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(row.fullName, "Ravi S.");
    assert.equal(row.branch, "Vasna", "the stored branch must be untouched");
  } finally {
    s.restore();
  }
});

test("DELETE /trainers/:id — a Vasna admin cannot delete a Gotri trainer", async () => {
  const s = stubAll([
    [
      Trainer,
      { findOne: () => fakeQuery(null), findOneAndDelete: () => fakeQuery({}) },
    ],
    [Member, { countDocuments: async () => 0 }],
  ]);
  try {
    const res = fakeRes();
    await deleteTrainer(vasnaAdmin({}, { id: "trainer-1" }), res);
    assertScoped(s.at(0).firstArg("findOne"), "Vasna", "DELETE /trainers/:id");
    assertRefusedAs404(res, "cross-branch trainer delete");
    assert.equal(s.at(0).called("findOneAndDelete"), false);
  } finally {
    s.restore();
  }
});

test("POST /trainers/:id/assign — out-of-branch member ids cannot be reassigned in bulk", async () => {
  // The sharpest edge found here: memberIds came straight off the body with NO
  // branch filter, so a Vasna admin could pull an arbitrary list of Gotri
  // members onto a Vasna trainer in one call.
  const s = stubAll([
    [Trainer, { findOne: () => fakeQuery(trainerRow({ branch: "Vasna" })) }],
    [Member, { updateMany: async () => ({ modifiedCount: 0 }) }],
  ]);
  try {
    const res = fakeRes();
    await assignMembers(
      vasnaAdmin({ memberIds: ["gotri-a", "gotri-b"] }, { id: "trainer-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const filter = s.at(1).firstArg("updateMany");
    assertScoped(filter, "Vasna", "bulk assign");
    assert.deepEqual(filter._id, { $in: ["gotri-a", "gotri-b"] });
  } finally {
    s.restore();
  }
});

test("POST /trainers/:id/assign — a super admin may still assign across branches", async () => {
  const s = stubAll([
    [Trainer, { findOne: () => fakeQuery(trainerRow({ branch: "Vasna" })) }],
    [Member, { updateMany: async () => ({ modifiedCount: 2 }) }],
  ]);
  try {
    const res = fakeRes();
    await assignMembers(
      superAdmin({ memberIds: ["a", "b"] }, { id: "trainer-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assertUnscoped(s.at(1).firstArg("updateMany"), "super admin bulk assign");
  } finally {
    s.restore();
  }
});
