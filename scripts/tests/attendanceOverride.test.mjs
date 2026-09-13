/**
 * OFFLINE tests for the two Phase 3 gaps: denials in the arrivals feed, and the
 * staff "mark as allowed" override.
 *
 * Run:  node --test scripts/tests/attendanceOverride.test.mjs
 *
 * NO DATABASE, same technique as scripts/tests/scoping.test.mjs: the real
 * controllers are imported and the model's statics are replaced with stubs that
 * CAPTURE THE FILTER. The assertions are therefore about what would actually
 * have reached Mongo, which is the only thing standing between a Gotri admin
 * and a Vasna refusal.
 *
 * ============================================================================
 * IMPORT ORDER IS LOAD-BEARING: services/auditLog.js FIRST.
 * ============================================================================
 * `mongoose.plugin()` only reaches schemas compiled after the call, which is
 * why server.js imports that file before anything else. This file mirrors that
 * so the Attendance schema under test carries the same audit hooks production
 * gives it — and one of the tests below asserts exactly that, rather than
 * assuming the plugin covers the model.
 */
import "../../services/auditLog.js";

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Attendance from "../../models/Attendance.js";
import AuditLog from "../../models/AuditLog.js";
import { runWithContext } from "../../middlewares/requestContext.js";

import {
  getInGymNow,
  getFootfall,
} from "../../controllers/v1/attendanceStaff.controller.js";
import { markAttendanceAllowed } from "../../controllers/v1/attendanceOverride.controller.js";

// ===================================================================
// Fixtures
// ===================================================================

const OID_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OID_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
  // Present ON PURPOSE and wrong ON PURPOSE: authMiddleware's req.user carries
  // no branch, so any handler that reads it instead of req.session.user fails
  // these tests loudly rather than leaking quietly.
  user: { id: "emp-gotri", role: "EMPLOYEE", email: "gotri@example.com", name: "Gotri Manager" },
  query,
  body,
  params,
  headers: {},
  method: "POST",
  originalUrl: "/api/v1/attendance/x/mark-allowed",
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
  method: "POST",
  originalUrl: "/api/v1/attendance/x/mark-allowed",
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
  for (const m of ["select", "sort", "skip", "limit", "populate", "lean", "clone"]) {
    q[m] = () => q;
  }
  q.exec = async () => result;
  q.then = (onOk, onErr) => Promise.resolve(result).then(onOk, onErr);
  return q;
};

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
    callsTo: (name) => calls.filter((c) => c.name === name),
    restore: () => {
      for (const [name, fn] of Object.entries(original)) model[name] = fn;
    },
  };
};

const matchOf = (pipeline) =>
  (pipeline || []).find((stage) => stage && stage.$match)?.$match || {};

const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * A stand-in for the Attendance document the override loads and saves.
 * `save()` is recorded rather than performed.
 */
const deniedRow = (overrides = {}) => {
  const checkInAt = overrides.checkInAt || new Date();
  const row = {
    _id: OID_A,
    subjectType: "MEMBER",
    memberId: OID_B,
    trainerId: null,
    branch: "Gotri",
    deniedReason: "EXPIRED",
    denialOverride: null,
    source: "QR",
    checkInAt,
    // A denied row is written CLOSED — checkOutAt === checkInAt.
    checkOutAt: checkInAt,
    autoClosed: false,
    date: startOfDay(checkInAt),
    saves: 0,
    ...overrides,
  };
  row.save = async () => {
    row.saves += 1;
    return row;
  };
  return row;
};

/** Mimics the `deniedReason: null` predicate every counting query uses. */
const passesNotDenied = (row) =>
  row.deniedReason === null || row.deniedReason === undefined;

// ===================================================================
// 1. Denials in the arrivals feed
// ===================================================================

/**
 * Runs getInGymNow with both Attendance.find calls stubbed, returning the
 * session fixture for the NOT_DENIED query and the denial fixture for the
 * IS_DENIED one — so the two filters can be told apart by what they asked for,
 * which is the point.
 */
const runLive = async (req, { sessions = [], denials = [], counts = [0, 0] } = {}) => {
  let countIdx = 0;
  const s = stub(Attendance, {
    find: (filter) =>
      fakeQuery(filter.deniedReason && filter.deniedReason.$ne === null ? denials : sessions),
    countDocuments: async () => counts[countIdx++] ?? 0,
  });
  const res = fakeRes();
  try {
    await getInGymNow(req, res);
  } finally {
    s.restore();
  }
  const finds = s.callsTo("find").map((c) => c.args[0]);
  const countFilters = s.callsTo("countDocuments").map((c) => c.args[0]);
  return { res, s, openFilter: finds[0], denialFilter: finds[1], countFilters };
};

test("live: the feed now carries denials, and they are a SEPARATE query from the sessions", async () => {
  const { res, openFilter, denialFilter } = await runLive(superAdmin());

  assert.equal(res.statusCode, 200);
  // The open-session query is unchanged: still excludes denials outright.
  assert.equal(openFilter.deniedReason, null);
  assert.equal(openFilter.checkOutAt, null);
  // The denial query is its mirror.
  assert.deepEqual(denialFilter.deniedReason, { $ne: null });
  // Disjoint by construction — a denial cannot appear in both.
  assert.notDeepEqual(openFilter.deniedReason, denialFilter.deniedReason);
  // Denials are surfaced FIRST in the payload (plan.md D2).
  assert.equal(Object.keys(res.body.data)[1], "denials");
});

test("live: a denial is NOT folded into inGymNow, sessions or staleOpenSessions", async () => {
  const now = new Date();
  const { res } = await runLive(superAdmin(), {
    sessions: [
      { _id: "s1", subjectType: "MEMBER", branch: "Vasna", checkInAt: now, memberId: null, trainerId: null },
    ],
    denials: [
      { _id: "d1", subjectType: "MEMBER", branch: "Vasna", checkInAt: now, updatedAt: now, deniedReason: "EXPIRED", memberId: null, trainerId: null },
      { _id: "d2", subjectType: "MEMBER", branch: "Gotri", checkInAt: now, updatedAt: now, deniedReason: "PAYMENT_DUE", memberId: null, trainerId: null },
    ],
    counts: [4, 7],
  });

  // Phase 4's number. One open session, two refusals, and inGymNow is 1.
  assert.equal(res.body.data.inGymNow, 1);
  assert.equal(res.body.data.sessions.length, 1);
  assert.equal(res.body.data.staleOpenSessions, 4);
  assert.equal(res.body.data.denials.length, 2);
  assert.equal(res.body.data.deniedNew, 2);
  assert.equal(res.body.data.deniedToday, 7);
  // No denial row leaked into the session list.
  for (const row of res.body.data.sessions) {
    assert.equal(row.deniedReason, undefined);
  }
  // A refusal is not elapsing, so it carries no minutesSoFar.
  for (const d of res.body.data.denials) {
    assert.equal(d.minutesSoFar, undefined);
    assert.ok(d.deniedReason);
    assert.ok(d.deniedAt);
    assert.ok(d.lastAttemptAt);
  }
  assert.match(res.body.data.denialsBasis, /not counted in ingymnow/i);
});

test("live: a branch admin's DENIAL query is pinned to their branch, and carries subjectType", async () => {
  const { denialFilter, countFilters } = await runLive(
    gotriAdmin({ branch: "Vasna" }),
  );
  // Asked for Vasna, pinned to Gotri — scopeFilter spread LAST.
  assert.equal(denialFilter.branch, "Gotri");
  // The Phase 3 house rule: every query over this collection names a subject.
  assert.equal(denialFilter.subjectType, "MEMBER");
  // Both count queries too — the stale count and the deniedToday count.
  for (const f of countFilters) assert.equal(f.branch, "Gotri");
  assert.equal(countFilters[1].subjectType, "MEMBER");
});

test("live: ?subjectType=TRAINER switches the denial query too", async () => {
  const { denialFilter } = await runLive(superAdmin({ subjectType: "TRAINER" }));
  assert.equal(denialFilter.subjectType, "TRAINER");
});

/**
 * THE CURSOR TEST. The admin polls every 30 s handing back the previous
 * `serverTime`. A repeat refusal does not create a second row — the unique
 * { memberId, date } index forbids it — so attendanceScan updates today's row
 * and leaves checkInAt at the FIRST refusal of the day. Cursoring denials on
 * checkInAt would therefore lose every subsequent attempt between polls.
 */
test("live: the denial cursor is updatedAt, never checkInAt", async () => {
  const since = new Date(Date.now() - 30000).toISOString();
  const { openFilter, denialFilter, countFilters } = await runLive(
    superAdmin({ since }),
  );

  // Arrivals still cursor on checkInAt, unchanged.
  assert.ok(openFilter.checkInAt.$gte instanceof Date);

  // Denials cursor on updatedAt...
  assert.ok(denialFilter.updatedAt, "denials must be cursored on updatedAt");
  assert.equal(denialFilter.updatedAt.$gte.toISOString(), since);
  // ...and must NOT be narrowed by checkInAt, or a 07:31 re-attempt on a row
  // first denied at 07:00 would be invisible forever.
  assert.equal(denialFilter.checkInAt, undefined);

  // $gte, not $gt: a row written between serverTime and the query is a
  // duplicate (dedupe by _id), never a miss.
  assert.ok("$gte" in denialFilter.updatedAt);
  assert.ok(!("$gt" in denialFilter.updatedAt));

  // The deniedToday count is NOT cursored — it is the day's total, so a quiet
  // poll cannot make the morning's refusals read as zero.
  assert.equal(countFilters[1].updatedAt, undefined);
  assert.ok(countFilters[1].date.$gte instanceof Date);
});

test("live: with no since, denials cover today and nothing older", async () => {
  const { denialFilter } = await runLive(superAdmin());
  assert.equal(denialFilter.updatedAt, undefined, "first poll must not be cursored");
  assert.equal(
    denialFilter.date.$gte.getTime(),
    startOfDay(new Date()).getTime(),
  );
});

test("live: an invalid since is ignored rather than emptying the feed", async () => {
  const { denialFilter } = await runLive(superAdmin({ since: "not-a-date" }));
  assert.equal(denialFilter.updatedAt, undefined);
});

// ===================================================================
// 2. Footfall must not move
// ===================================================================

test("footfall: still excludes denials and still names a subject after the live change", async () => {
  const s = stub(Attendance, { aggregate: async () => [] });
  try {
    const res = fakeRes();
    await getFootfall(superAdmin(), res);
    assert.equal(res.statusCode, 200);
    const m = matchOf(s.calls[0].args[0]);
    // The regression this test exists for: adding denials to /live must not
    // have leaked a denial into any counting query.
    assert.equal(m.deniedReason, null);
    assert.equal(m.subjectType, "MEMBER");
  } finally {
    s.restore();
  }
});

test("footfall: a refusal does not count, an override counts exactly once", async () => {
  const row = deniedRow();
  // Before: a refusal. Excluded from every NOT_DENIED count.
  assert.equal(passesNotDenied(row), false);

  const req = gotriAdmin({}, {}, { id: OID_A });
  const s = stub(Attendance, { findOne: async () => row });
  try {
    await markAttendanceAllowed(req, fakeRes());
    await markAttendanceAllowed(req, fakeRes());
    await markAttendanceAllowed(req, fakeRes());
  } finally {
    s.restore();
  }

  // After: one row, counted once, no matter how many overrides were attempted.
  assert.equal(passesNotDenied(row), true);
  assert.equal(row.saves, 1, "three calls must produce exactly one write");
  // And it is the SAME row — no second document, so footfall moves by one
  // check-in and never by two.
  assert.equal(row._id, OID_A);
});

// ===================================================================
// 3. The override: branch scope
// ===================================================================

test("override: a Gotri admin's lookup is pinned to Gotri and names a subject", async () => {
  const row = deniedRow();
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(
      gotriAdmin({ branch: "Vasna" }, {}, { id: OID_A }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const f = s.filters()[0];
    assert.equal(String(f._id), OID_A);
    // scopeFilter spread LAST — the client cannot widen it.
    assert.equal(f.branch, "Gotri");
    assert.equal(f.subjectType, "MEMBER");
  } finally {
    s.restore();
  }
});

test("override: a Gotri admin cannot override a Vasna refusal, and cannot tell it exists", async () => {
  // Mongo returns nothing because the filter carried branch: "Gotri".
  const s = stub(Attendance, { findOne: async () => null });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: OID_A }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.isOk, false);
    // The same answer a genuinely missing id gets — an id must not be probeable
    // across branches.
    assert.match(res.body.message, /not found/i);
    assert.doesNotMatch(res.body.message, /branch|vasna|permission/i);
    assert.equal(s.filters()[0].branch, "Gotri");
  } finally {
    s.restore();
  }
});

test("override: a super admin is unrestricted", async () => {
  const row = deniedRow({ branch: "Vasna" });
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(superAdmin({}, {}, { id: OID_A }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(s.filters()[0].branch, undefined);
  } finally {
    s.restore();
  }
});

// ===================================================================
// 4. The override: what it does to the row
// ===================================================================

test("override: today's refusal becomes a LIVE session, and the reason is preserved", async () => {
  const deniedAt = new Date(Date.now() - 15 * 60000);
  const row = deniedRow({ checkInAt: deniedAt, checkOutAt: deniedAt });
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(
      gotriAdmin({}, { note: "paid at desk, receipt 1042" }, { id: OID_A }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.sessionOpened, true);
    assert.match(res.body.message, /session is now open/i);

    // The refusal is cleared, so every NOT_DENIED query stops seeing it...
    assert.equal(row.deniedReason, null);
    // ...and the evidence is relocated, not destroyed.
    assert.equal(row.denialOverride.originalReason, "EXPIRED");
    assert.equal(row.denialOverride.deniedAt.getTime(), deniedAt.getTime());
    assert.equal(row.denialOverride.actorName, "Gotri Manager");
    assert.equal(row.denialOverride.actorId, "emp-gotri");
    assert.equal(row.denialOverride.actorRole, "EMPLOYEE");
    assert.equal(row.denialOverride.note, "paid at desk, receipt 1042");
    assert.ok(row.denialOverride.overriddenAt instanceof Date);
    assert.equal(row.denialOverride.sessionOpened, true);

    // A live session: open, re-stamped now, exactly as the re-scan path does.
    assert.equal(row.checkOutAt, null);
    assert.ok(row.checkInAt.getTime() > deniedAt.getTime());
    assert.equal(row.autoClosed, false);
    assert.equal(row.saves, 1);
  } finally {
    s.restore();
  }
});

test("override: an OLDER refusal is cleared but opens no session and does not move its day", async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const row = deniedRow({ checkInAt: threeDaysAgo, checkOutAt: threeDaysAgo });
  const originalDate = row.date.getTime();
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: OID_A }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.sessionOpened, false);
    assert.match(res.body.message, /not from today/i);

    assert.equal(row.deniedReason, null);
    assert.equal(row.denialOverride.originalReason, "EXPIRED");
    assert.equal(row.denialOverride.sessionOpened, false);

    // Untouched: checkInAt, date and the closed checkOutAt. Re-stamping would
    // put checkInAt and date in different days, which every calendar and
    // footfall query depends on not happening.
    assert.equal(row.checkInAt.getTime(), threeDaysAgo.getTime());
    assert.equal(row.checkOutAt.getTime(), threeDaysAgo.getTime());
    assert.equal(row.date.getTime(), originalDate);
    assert.equal(row.saves, 1);
  } finally {
    s.restore();
  }
});

test("override: a note is trimmed, capped, and a non-string is rejected", async () => {
  const row = deniedRow();
  let s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(
      gotriAdmin({}, { note: `  ${"x".repeat(500)}  ` }, { id: OID_A }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(row.denialOverride.note.length, 300);
  } finally {
    s.restore();
  }

  s = stub(Attendance, { findOne: async () => deniedRow() });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, { note: { evil: 1 } }, { id: OID_A }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(s.calls.length, 0, "a bad note must not reach the database");
  } finally {
    s.restore();
  }
});

// ===================================================================
// 5. The override: idempotency and the not-a-refusal case
// ===================================================================

test("override: overriding twice writes once and opens one session", async () => {
  const deniedAt = new Date(Date.now() - 10 * 60000);
  const row = deniedRow({ checkInAt: deniedAt, checkOutAt: deniedAt });
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const first = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: OID_A }), first);
    const openedAt = row.checkInAt.getTime();

    const second = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: OID_A }), second);

    assert.equal(first.body.data.alreadyOverridden, false);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.data.alreadyOverridden, true);
    assert.match(second.body.message, /already been overridden/i);

    // One write, one session, one start time.
    assert.equal(row.saves, 1);
    assert.equal(row.checkInAt.getTime(), openedAt);
    assert.equal(row.checkOutAt, null);
    // The first override's record is intact — the second call did not re-stamp
    // the actor or the time.
    assert.equal(
      second.body.data.denialOverride.overriddenAt.getTime(),
      first.body.data.denialOverride.overriddenAt.getTime(),
    );
  } finally {
    s.restore();
  }
});

test("override: a row that was never refused is a 409, not a silent re-stamp", async () => {
  const checkInAt = new Date(Date.now() - 20 * 60000);
  const row = deniedRow({ deniedReason: null, checkOutAt: null, checkInAt });
  const s = stub(Attendance, { findOne: async () => row });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: OID_A }), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /was not refused/i);
    assert.equal(row.saves, 0);
    // A real session's start time must not be rewritten by a mis-wired screen.
    assert.equal(row.checkInAt.getTime(), checkInAt.getTime());
  } finally {
    s.restore();
  }
});

test("override: a malformed id never reaches the database", async () => {
  const s = stub(Attendance, { findOne: async () => deniedRow() });
  try {
    const res = fakeRes();
    await markAttendanceAllowed(gotriAdmin({}, {}, { id: "not-an-oid" }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

// ===================================================================
// 6. The audit row is REALLY written — not assumed
// ===================================================================

/** Captures whatever the audit plugin tried to persist. */
const captureAudit = () => {
  const original = AuditLog.create;
  const rows = [];
  AuditLog.create = async (entry) => {
    rows.push(entry);
    return entry;
  };
  return { rows, restore: () => (AuditLog.create = original) };
};

/** The audit plugin's own hooks, as registered on the REAL Attendance schema. */
const attendanceAuditHooks = () => {
  const pres = Attendance.schema.s.hooks._pres.get("save") || [];
  const posts = Attendance.schema.s.hooks._posts.get("save") || [];
  return {
    preSave: pres.find((h) => h.fn?.name === "auditPreSave")?.fn,
    postSave: posts.find((h) => h.fn?.name === "auditPostSave")?.fn,
  };
};

test("audit: the global plugin is actually installed on the Attendance schema", () => {
  const { preSave, postSave } = attendanceAuditHooks();
  // This is the assumption the override rests on. If server.js ever moves the
  // services/auditLog.js import below the route imports, the plugin stops
  // reaching this model and NOTHING is logged — silently.
  assert.ok(preSave, "Attendance has no auditPreSave hook");
  assert.ok(postSave, "Attendance has no auditPostSave hook");
});

test("audit: overriding a refusal produces an AuditLog row naming the actor and the change", async () => {
  const { preSave, postSave } = attendanceAuditHooks();
  const cap = captureAudit();

  const deniedAt = new Date(Date.now() - 15 * 60000);
  const overriddenAt = new Date();

  // The row as Mongo held it before the save...
  const before = {
    _id: OID_A,
    subjectType: "MEMBER",
    branch: "Gotri",
    deniedReason: "EXPIRED",
    denialOverride: null,
    checkInAt: deniedAt,
    checkOutAt: deniedAt,
    autoClosed: false,
  };
  // ...and after the override handler mutated it.
  const after = {
    _id: OID_A,
    subjectType: "MEMBER",
    branch: "Gotri",
    deniedReason: null,
    denialOverride: {
      originalReason: "EXPIRED",
      deniedAt,
      actorId: "emp-gotri",
      actorName: "Gotri Manager",
      actorRole: "EMPLOYEE",
      overriddenAt,
      note: "paid at desk, receipt 1042",
      sessionOpened: true,
    },
    checkInAt: overriddenAt,
    checkOutAt: null,
    autoClosed: false,
  };

  const doc = {
    isNew: false,
    _id: OID_A,
    $locals: {},
    constructor: {
      modelName: "Attendance",
      findById: () => ({ lean: () => ({ exec: async () => before }) }),
    },
    toObject: () => after,
  };

  try {
    // Exactly how express runs it: the handler's save happens inside the
    // AsyncLocalStorage store that middlewares/requestContext.js opened.
    await runWithContext({ req: gotriAdmin({}, {}, { id: OID_A }) }, async () => {
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });

    assert.equal(cap.rows.length, 1, "the override must write exactly one audit row");
    const entry = cap.rows[0];

    assert.equal(entry.action, "UPDATE");
    assert.equal(entry.collectionName, "Attendance");
    assert.equal(entry.documentId, OID_A);

    // The actor comes from AsyncLocalStorage, i.e. req.session.user — the whole
    // reason this plumbing exists.
    assert.equal(entry.actor.id, "emp-gotri");
    assert.equal(entry.actor.name, "Gotri Manager");
    assert.equal(entry.actor.role, "EMPLOYEE");
    assert.equal(entry.actor.branch, "Gotri");
    assert.equal(entry.actor.isSuperAdmin, false);

    // The row that changed belongs to Gotri, so a Gotri admin can read it back.
    assert.equal(entry.branch, "Gotri");

    // Both halves of the override are in the diff.
    assert.ok(entry.changedFields.includes("deniedReason"));
    assert.ok(entry.changedFields.includes("denialOverride"));
    assert.ok(entry.changedFields.includes("checkOutAt"));

    // And the before/after actually carry the evidence, so the trail reads
    // "was denied for EXPIRED, overridden by Gotri Manager".
    assert.equal(entry.before.deniedReason, "EXPIRED");
    assert.equal(entry.after.deniedReason, null);
    assert.equal(entry.after.denialOverride.originalReason, "EXPIRED");
    assert.equal(entry.after.denialOverride.actorName, "Gotri Manager");
    assert.equal(entry.after.denialOverride.note, "paid at desk, receipt 1042");
  } finally {
    cap.restore();
  }
});

test("audit: the same save outside a staff request writes nothing", async () => {
  const { preSave, postSave } = attendanceAuditHooks();
  const cap = captureAudit();
  try {
    const doc = {
      isNew: false,
      _id: OID_A,
      $locals: {},
      constructor: {
        modelName: "Attendance",
        findById: () => ({ lean: () => ({ exec: async () => ({ deniedReason: "EXPIRED" }) }) }),
      },
      toObject: () => ({ deniedReason: null }),
    };
    await preSave.call(doc);
    await postSave.call(doc, doc);
    // A member-portal scan (JWT, no session) and a seed script are not staff
    // overrides and must not appear in the staff audit trail.
    assert.equal(cap.rows.length, 0);
  } finally {
    cap.restore();
  }
});

// ===================================================================
// 7. The schema actually accepts what the controller writes
// ===================================================================

test("schema: denialOverride round-trips, and a plain row leaves it null", () => {
  const overriddenAt = new Date();
  const doc = new Attendance({
    subjectType: "MEMBER",
    memberId: new mongoose.Types.ObjectId(),
    branch: "Gotri",
    checkInAt: new Date(),
    date: startOfDay(new Date()),
    denialOverride: {
      originalReason: "PAYMENT_DUE",
      deniedAt: new Date(),
      actorId: "emp-gotri",
      actorName: "Gotri Manager",
      actorRole: "EMPLOYEE",
      overriddenAt,
      note: "paid",
      sessionOpened: true,
    },
  });
  const err = doc.validateSync();
  assert.equal(err, undefined, err && err.message);
  assert.equal(doc.denialOverride.originalReason, "PAYMENT_DUE");
  assert.equal(doc.denialOverride.sessionOpened, true);
  assert.equal(doc.deniedReason, null);

  const plain = new Attendance({
    subjectType: "MEMBER",
    memberId: new mongoose.Types.ObjectId(),
    branch: "Gotri",
    checkInAt: new Date(),
    date: startOfDay(new Date()),
  });
  assert.equal(plain.validateSync(), undefined);
  assert.equal(plain.denialOverride, null);
});
