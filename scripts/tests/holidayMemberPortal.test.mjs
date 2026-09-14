/**
 * OFFLINE tests for the member-portal "closed today / closed this week"
 * holiday widget (GET /api/v1/member-portal/holidays/upcoming).
 *
 * Run:  node --test scripts/tests/holidayMemberPortal.test.mjs
 *
 * NO DATABASE, same technique as scripts/tests/holidayScoping.test.mjs:
 * Holiday.find/Member.findById are stubbed. Unlike that file, the Holiday
 * stub here doesn't just CAPTURE the filter — it EVALUATES it against a fixed
 * set of fixture documents (evalFilter() below), so these tests genuinely
 * exercise the overlap-window and branch-membership logic the controller
 * builds, not just "was find() called".
 *
 * ============================================================================
 * WHY IDENTITY-TAMPERING GETS ITS OWN TEST
 * ============================================================================
 * An earlier audit confirmed the member portal reads identity ONLY from the
 * verified JWT (req.member.id), never from the querystring, and that
 * isolation must not regress. Test 6 below asserts that explicitly: posting a
 * different `memberId` or a widening `branch` in the query changes nothing
 * about the response OR about which member row is looked up.
 */
import test from "node:test";
import assert from "node:assert/strict";

import Holiday from "../../models/Holiday.js";
import Member from "../../models/Member.js";

import { getUpcomingHolidaysForMember } from "../../controllers/v1/holiday.controller.js";
import { startOfDay, addDays } from "../../services/holidayDate.js";

// ===================================================================
// Fixtures
// ===================================================================

const TODAY = startOfDay();

/** A Gotri member, the identity requireMember would have put on req.member. */
const memberReq = (query = {}) => ({
  member: { id: "member-gotri-1" },
  query,
  params: {},
  body: {},
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

const fakeQuery = (result) => {
  const q = {};
  for (const m of ["select", "sort", "skip", "limit", "populate", "lean"]) {
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
    restore: () => {
      for (const [name, fn] of Object.entries(original)) model[name] = fn;
    },
  };
};

/**
 * A minimal in-memory evaluator for the specific filter shapes
 * getUpcomingHolidaysForMember() builds: top-level $and of clauses that are
 * either plain equality, {$in: [...]}, {$lte/$gte: Date}, or a nested $or of
 * the same. Not a general Mongo emulator — just enough to genuinely exercise
 * the real filter object the controller constructs, rather than a hand-copy
 * of its logic.
 */
const evalClause = (clause, doc) =>
  Object.entries(clause).every(([key, cond]) => {
    if (key === "$or") return cond.some((c) => evalClause(c, doc));
    if (key === "$and") return cond.every((c) => evalClause(c, doc));

    const value = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, opVal]) => {
        if (op === "$lte") return value != null && value.getTime() <= opVal.getTime();
        if (op === "$gte") return value != null && value.getTime() >= opVal.getTime();
        if (op === "$in") return opVal.includes(value);
        throw new Error(`unsupported operator in test evaluator: ${op}`);
      });
    }
    if (value instanceof Date && cond instanceof Date) {
      return value.getTime() === cond.getTime();
    }
    return value === cond;
  });

const FIXTURES = [
  {
    _id: "today",
    title: "Today's Holiday",
    date: TODAY,
    endDate: null,
    note: "",
    branch: "Gotri",
    isActive: true,
  },
  {
    _id: "seven-out",
    title: "Exactly 7 Days Out",
    date: addDays(TODAY, 7),
    endDate: null,
    note: "",
    branch: null, // all branches
    isActive: true,
  },
  {
    _id: "eight-out",
    title: "8 Days Out",
    date: addDays(TODAY, 8),
    endDate: null,
    note: "",
    branch: "Gotri",
    isActive: true,
  },
  {
    _id: "multi-day-spanning",
    title: "Multi-day Closure Spanning Today",
    date: addDays(TODAY, -2),
    endDate: addDays(TODAY, 1),
    note: "",
    branch: "Gotri",
    isActive: true,
  },
  {
    _id: "other-branch",
    title: "Vasna Only",
    date: TODAY,
    endDate: null,
    note: "",
    branch: "Vasna",
    isActive: true,
  },
];

const titlesOf = (holidays) => holidays.map((h) => h.title).sort();

// ===================================================================
// Tests
// ===================================================================

test("today's holiday appears, flagged isToday", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    assert.equal(res.statusCode, 200);
    const today = res.body.data.holidays.find((h) => h._id === "today");
    assert.ok(today, "today's holiday must be present");
    assert.equal(today.isToday, true);
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("a holiday exactly 7 days out appears", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    const sevenOut = res.body.data.holidays.find((h) => h._id === "seven-out");
    assert.ok(sevenOut, "a holiday 7 days out must be inside the window");
    assert.equal(sevenOut.isToday, false);
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("a holiday 8 days out does NOT appear", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    const eightOut = res.body.data.holidays.find((h) => h._id === "eight-out");
    assert.equal(eightOut, undefined, "8 days out is outside the 7-day window");
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("a multi-day holiday that started before today but is still running counts as today", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    const spanning = res.body.data.holidays.find((h) => h._id === "multi-day-spanning");
    assert.ok(
      spanning,
      "a range that started 2 days ago and ends tomorrow must be found, not just on its start date",
    );
    assert.equal(spanning.isToday, true, "today falls inside the still-running range");
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("the OTHER branch's holiday does not appear; an all-branches holiday does", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    const titles = titlesOf(res.body.data.holidays);
    assert.ok(!titles.includes("Vasna Only"), "a Gotri member must never see Vasna's holiday");
    assert.ok(
      titles.includes("Exactly 7 Days Out"),
      "an all-branches holiday (branch: null) must still appear",
    );
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("tampering with query params (branch, memberId) changes NOTHING", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery({ branch: "Gotri" }) });
  const holidayStub = stub(Holiday, {
    find: (filter) => fakeQuery(FIXTURES.filter((h) => evalClause(filter, h))),
  });
  try {
    const clean = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), clean);

    // Same authenticated member (req.member.id from the JWT is UNCHANGED),
    // but the querystring now tries to widen the branch and impersonate
    // someone else.
    const tampered = fakeRes();
    await getUpcomingHolidaysForMember(
      memberReq({ branch: "Vasna", memberId: "someone-elses-id" }),
      tampered,
    );

    assert.deepEqual(
      titlesOf(clean.body.data.holidays),
      titlesOf(tampered.body.data.holidays),
      "the response must be identical regardless of what the query string asks for",
    );

    // Member.findById must always have been called with the TOKEN's id, never
    // anything read off the query string.
    for (const call of memberStub.calls) {
      assert.equal(call.args[0], "member-gotri-1");
    }
  } finally {
    memberStub.restore();
    holidayStub.restore();
  }
});

test("an unknown member id (deleted account) is a 404, not a crash", async () => {
  const memberStub = stub(Member, { findById: () => fakeQuery(null) });
  try {
    const res = fakeRes();
    await getUpcomingHolidaysForMember(memberReq(), res);
    assert.equal(res.statusCode, 404);
  } finally {
    memberStub.restore();
  }
});
