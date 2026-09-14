/**
 * OFFLINE tests for todo.md item 1: "Trainers cannot check out."
 *
 * Two things are tested, both load-bearing:
 *
 *   1. ROUTE WIRING — /member-portal/attendance/check-out must be guarded by
 *      requirePortalUser, not requireMember, or a trainer's token is rejected
 *      before the controller ever runs (403 "This area is for members only").
 *
 *   2. THE CONTROLLER — checkOut() must key its Attendance.findOne query off
 *      req.portalUser (id + subjectType), never assume req.member, and the
 *      filter it builds must be an EXACT subject match: a trainer's own filter
 *      can only ever match a TRAINER row carrying their trainerId, and a
 *      member's filter can only ever match a MEMBER row carrying their
 *      memberId. Both directions are asserted explicitly, per the task:
 *      subjectType is a security field, not a label.
 *
 * Same no-DB technique as attendanceOverride.test.mjs: Attendance.findOne is
 * stubbed to behave like Mongo actually would — it returns a row only when the
 * filter's subjectType/id combination matches that row's owner, and null
 * otherwise. That is what proves a trainer cannot close a member's session (or
 * vice versa) rather than merely asserting the filter "looks right".
 */
import test from "node:test";
import assert from "node:assert/strict";

import Attendance from "../../models/Attendance.js";
import { checkOut } from "../../controllers/v1/attendance.controller.js";
import attendanceRouter from "../../routes/v1/attendance.routes.js";

// ===================================================================
// Fixtures
// ===================================================================

const MEMBER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TRAINER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_MEMBER_ID = "cccccccccccccccccccccccc";
const OTHER_TRAINER_ID = "dddddddddddddddddddddddd";

const memberReq = (id = MEMBER_ID) => ({
  member: { id },
  trainer: undefined,
  portalUser: { id, subjectType: "MEMBER" },
});

const trainerReq = (id = TRAINER_ID) => ({
  member: undefined,
  trainer: { id },
  portalUser: { id, subjectType: "TRAINER" },
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

const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** An open row, owned by exactly one subject, the way Mongo would hold it. */
const openRow = ({ subjectType, memberId = null, trainerId = null }) => {
  const row = {
    _id: "row1",
    subjectType,
    memberId,
    trainerId,
    branch: "Vasna",
    deniedReason: null,
    checkInAt: new Date(Date.now() - 20 * 60000),
    checkOutAt: null,
    autoClosed: false,
    date: startOfDay(),
    saves: 0,
    toObject() {
      const { toObject, save, ...rest } = this;
      return rest;
    },
  };
  row.save = async () => {
    row.saves += 1;
    return row;
  };
  return row;
};

/**
 * Stubs Attendance.findOne to behave like a real, scoped query: a row is only
 * returned when EVERY key the filter names matches that row's own fields.
 * This is what makes "a trainer cannot close a member's row" a fact about the
 * filter the controller builds, not an assumption.
 */
const stubFindOneAgainst = (rows) => {
  const original = Attendance.findOne;
  const calls = [];
  Attendance.findOne = (filter) => {
    calls.push(filter);
    const match = rows.find((row) =>
      Object.entries(filter).every(([key, want]) => {
        if (want === null) return row[key] === null || row[key] === undefined;
        return String(row[key]) === String(want);
      }),
    );
    return Promise.resolve(match || null);
  };
  return {
    calls,
    restore: () => {
      Attendance.findOne = original;
    },
  };
};

// ===================================================================
// 1. Route wiring — requirePortalUser, not requireMember
// ===================================================================

const findRouteLayer = (path) =>
  attendanceRouter.stack.find(
    (layer) => layer.route && layer.route.path === path,
  );

test("route: /member-portal/attendance/check-out is guarded by requirePortalUser, not requireMember", () => {
  const layer = findRouteLayer("/member-portal/attendance/check-out");
  assert.ok(layer, "check-out route must exist");
  const names = layer.route.stack.map((s) => s.name);
  assert.ok(
    names.includes("requirePortalUser"),
    `expected requirePortalUser in the check-out middleware chain, got [${names.join(", ")}]`,
  );
  assert.ok(
    !names.includes("requireMember"),
    "check-out must not still be gated by requireMember — that rejects a trainer's token before the controller ever runs",
  );
});

test("route: check-in stays requireMember — only check-out was widened", () => {
  const layer = findRouteLayer("/member-portal/attendance/check-in");
  const names = layer.route.stack.map((s) => s.name);
  assert.ok(names.includes("requireMember"));
  assert.ok(!names.includes("requirePortalUser"));
});

// ===================================================================
// 2. The controller: keys off req.portalUser, exact subject match
// ===================================================================

test("checkOut: a member closes their own open session", async () => {
  const rows = [openRow({ subjectType: "MEMBER", memberId: MEMBER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(memberReq(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.message, /checked out after/i);
    assert.equal(rows[0].checkOutAt !== null, true);
    assert.equal(rows[0].saves, 1);
  } finally {
    s.restore();
  }
});

test("checkOut: a trainer closes their own open shift", async () => {
  const rows = [openRow({ subjectType: "TRAINER", trainerId: TRAINER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(trainerReq(), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.message, /checked out after/i);
    assert.equal(rows[0].checkOutAt !== null, true);
    assert.equal(rows[0].saves, 1);

    const filter = s.calls[0];
    assert.equal(filter.subjectType, "TRAINER");
    assert.equal(filter.trainerId, TRAINER_ID);
    assert.equal(filter.memberId, undefined, "a trainer's own filter must not name memberId at all");
  } finally {
    s.restore();
  }
});

test("checkOut: a trainer's token can NEVER close a member's session", async () => {
  // Only a MEMBER row exists, owned by someone else entirely. A trainer
  // checking out must not find it, must not close it, and must get the
  // ordinary "nothing open" answer rather than an error that hints at why.
  const rows = [openRow({ subjectType: "MEMBER", memberId: MEMBER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(trainerReq(TRAINER_ID), res);
    assert.equal(res.statusCode, 404);
    assert.equal(rows[0].checkOutAt, null, "the member's session must remain open");
    assert.equal(rows[0].saves, 0);
  } finally {
    s.restore();
  }
});

test("checkOut: a member's token can NEVER close a trainer's shift", async () => {
  const rows = [openRow({ subjectType: "TRAINER", trainerId: TRAINER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(memberReq(MEMBER_ID), res);
    assert.equal(res.statusCode, 404);
    assert.equal(rows[0].checkOutAt, null, "the trainer's shift must remain open");
    assert.equal(rows[0].saves, 0);
  } finally {
    s.restore();
  }
});

test("checkOut: a trainer cannot close ANOTHER trainer's shift", async () => {
  const rows = [openRow({ subjectType: "TRAINER", trainerId: OTHER_TRAINER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(trainerReq(TRAINER_ID), res);
    assert.equal(res.statusCode, 404);
    assert.equal(rows[0].checkOutAt, null);
  } finally {
    s.restore();
  }
});

test("checkOut: a member cannot close ANOTHER member's session", async () => {
  const rows = [openRow({ subjectType: "MEMBER", memberId: OTHER_MEMBER_ID })];
  const s = stubFindOneAgainst(rows);
  try {
    const res = fakeRes();
    await checkOut(memberReq(MEMBER_ID), res);
    assert.equal(res.statusCode, 404);
    assert.equal(rows[0].checkOutAt, null);
  } finally {
    s.restore();
  }
});

test("checkOut: a denied (closed, refused) row is never picked up for either subject", async () => {
  const deniedMember = openRow({ subjectType: "MEMBER", memberId: MEMBER_ID });
  deniedMember.deniedReason = "EXPIRED";
  deniedMember.checkOutAt = deniedMember.checkInAt;
  const s = stubFindOneAgainst([deniedMember]);
  try {
    const res = fakeRes();
    await checkOut(memberReq(), res);
    assert.equal(res.statusCode, 404);
  } finally {
    s.restore();
  }
});
