/**
 * OFFLINE unit tests for the Phase 3 check-in eligibility rules.
 *
 * Run:  node --test scripts/tests/eligibility.test.mjs
 *       npm run test:unit
 *
 * NO DATABASE, NO SERVER. services/attendanceEligibility.js is deliberately a
 * pure module over plain objects, so these are real assertions about the rules
 * rather than assertions about a stubbed Mongoose call.
 *
 * ============================================================================
 * WHY THESE RULES ARE THE PART OF PHASE 3 THAT GETS TESTS
 * ============================================================================
 * plan.md's Phase 3 risk note: nobody is at the door. There is no rotating
 * token, so no clock-skew failure; a DENY cannot turn anyone away, so a false
 * DENY misinforms rather than refuses. What is left is the thing that actually
 * hurts — a WRONG VERDICT telling a paying member, on their own phone, in the
 * doorway, with no member of staff present to contradict it, that their
 * membership has lapsed. The verdict is the entire user-visible behaviour of
 * this feature, so it is pinned by assertions.
 *
 * The five cases the contract names are covered below, plus the boundaries
 * where a plausible-looking implementation goes wrong: the last day of a
 * membership, an overpayment, and a lean object with no virtuals on it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMemberEligibility,
  evaluateTrainerEligibility,
  evaluateEligibility,
  DENY_REASONS,
  VERDICT,
} from "../../services/attendanceEligibility.js";

// ===================================================================
// Fixtures — the minimum shape the rules actually read.
// ===================================================================

const NOW = new Date("2026-09-13T10:00:00");

/** A member in good standing: active, three weeks left, fully paid. */
const goodMember = (over = {}) => ({
  isActive: true,
  endDate: new Date("2026-10-04"),
  totalFee: 6000,
  payments: [{ amount: 6000 }],
  ...over,
});

// ===================================================================
// 1. The five cases the contract names
// ===================================================================

test("active subscription -> ALLOW", () => {
  const d = evaluateMemberEligibility(goodMember(), NOW);
  assert.equal(d.verdict, VERDICT.ALLOW);
  assert.equal(d.reason, null);
  assert.ok(d.message.length > 0);
});

test("expired membership -> DENY(EXPIRED)", () => {
  const d = evaluateMemberEligibility(
    goodMember({ endDate: new Date("2026-09-12") }),
    NOW,
  );
  assert.equal(d.verdict, VERDICT.DENY);
  assert.equal(d.reason, DENY_REASONS.EXPIRED);
});

test("outstanding balance -> DENY(PAYMENT_DUE)", () => {
  const d = evaluateMemberEligibility(
    goodMember({ payments: [{ amount: 2000 }] }),
    NOW,
  );
  assert.equal(d.verdict, VERDICT.DENY);
  assert.equal(d.reason, DENY_REASONS.PAYMENT_DUE);
});

test("deactivated member -> DENY(INACTIVE)", () => {
  const d = evaluateMemberEligibility(goodMember({ isActive: false }), NOW);
  assert.equal(d.verdict, VERDICT.DENY);
  assert.equal(d.reason, DENY_REASONS.INACTIVE);
});

test("a trainer is always ALLOW — there is no subscription to check", () => {
  const d = evaluateTrainerEligibility({ isActive: true, branch: "Vasna" });
  assert.equal(d.verdict, VERDICT.ALLOW);
  assert.equal(d.reason, null);

  // Even with fields that would deny a member, because they mean nothing here.
  const withMemberJunk = evaluateTrainerEligibility({
    isActive: true,
    endDate: new Date("2020-01-01"),
    totalFee: 99999,
    payments: [],
  });
  assert.equal(withMemberJunk.verdict, VERDICT.ALLOW);
});

// ===================================================================
// 2. Boundaries — where a reasonable-looking implementation is wrong
// ===================================================================

test("the LAST DAY of a membership is still a day you may train", () => {
  // endDate === today. `<=` instead of `<` here would lock out every member on
  // the day they renew, which is the single most visible wrong verdict
  // possible: it happens to everybody, once per period, at the door.
  const d = evaluateMemberEligibility(
    goodMember({ endDate: new Date("2026-09-13T00:00:00") }),
    NOW,
  );
  assert.equal(d.verdict, VERDICT.ALLOW);

  // And an endDate stamped late in the day is still the same day.
  const lateStamp = evaluateMemberEligibility(
    goodMember({ endDate: new Date("2026-09-13T23:59:00") }),
    NOW,
  );
  assert.equal(lateStamp.verdict, VERDICT.ALLOW);
});

test("a membership that ended yesterday is expired even scanning at 00:01", () => {
  const justAfterMidnight = new Date("2026-09-13T00:01:00");
  const d = evaluateMemberEligibility(
    goodMember({ endDate: new Date("2026-09-12T23:59:00") }),
    justAfterMidnight,
  );
  assert.equal(d.reason, DENY_REASONS.EXPIRED);
});

test("an overpayment is not a reason to deny anybody", () => {
  const d = evaluateMemberEligibility(
    goodMember({ totalFee: 6000, payments: [{ amount: 7500 }] }),
    NOW,
  );
  assert.equal(d.verdict, VERDICT.ALLOW);
});

test("a one-rupee balance still denies — the rule is > 0, not a threshold", () => {
  const d = evaluateMemberEligibility(
    goodMember({ totalFee: 6000, payments: [{ amount: 5999 }] }),
    NOW,
  );
  assert.equal(d.reason, DENY_REASONS.PAYMENT_DUE);
});

test("no endDate at all does not expire anybody", () => {
  // A lifetime or hand-entered record. `null < today` is true in JS date
  // arithmetic once coerced, so a naive comparison denies these forever.
  const d = evaluateMemberEligibility(goodMember({ endDate: null }), NOW);
  assert.equal(d.verdict, VERDICT.ALLOW);
});

test("balanceAmount (the Mongoose virtual) is used when present", () => {
  // A real document carries the virtual and no usable payments array. Reading
  // only payments here would report the full fee as outstanding and deny a
  // fully paid member.
  const d = evaluateMemberEligibility(
    { isActive: true, endDate: new Date("2026-10-04"), balanceAmount: 0 },
    NOW,
  );
  assert.equal(d.verdict, VERDICT.ALLOW);

  const owing = evaluateMemberEligibility(
    { isActive: true, endDate: new Date("2026-10-04"), balanceAmount: 500 },
    NOW,
  );
  assert.equal(owing.reason, DENY_REASONS.PAYMENT_DUE);
});

test("a lean object with isActive not selected is NOT treated as deactivated", () => {
  // `!member.isActive` would deny here. undefined means "not selected", not
  // "switched off", and denying on a missing projection is a wrong verdict
  // caused entirely by the caller's .select().
  const d = evaluateMemberEligibility(
    { endDate: new Date("2026-10-04"), totalFee: 0, payments: [] },
    NOW,
  );
  assert.equal(d.verdict, VERDICT.ALLOW);
});

// ===================================================================
// 3. Precedence — which reason a member is told about first
// ===================================================================

test("inactive beats expired beats payment due", () => {
  const everythingWrong = {
    isActive: false,
    endDate: new Date("2020-01-01"),
    totalFee: 6000,
    payments: [],
  };
  assert.equal(
    evaluateMemberEligibility(everythingWrong, NOW).reason,
    DENY_REASONS.INACTIVE,
  );

  // Expired AND owing money: told to renew, because renewing is the action
  // that actually fixes their situation. Telling them to settle a bill on a
  // membership that has ended sends them to the desk for the wrong thing.
  assert.equal(
    evaluateMemberEligibility(
      { isActive: true, endDate: new Date("2020-01-01"), totalFee: 6000, payments: [] },
      NOW,
    ).reason,
    DENY_REASONS.EXPIRED,
  );
});

test("a missing subject denies rather than throwing", () => {
  // The scan handler 404s before it gets here, but a rule that throws on null
  // turns a deleted record into a 500 with an empty body, which tells the
  // member nothing at all.
  assert.equal(
    evaluateMemberEligibility(null, NOW).reason,
    DENY_REASONS.NOT_A_MEMBER,
  );
  assert.equal(
    evaluateTrainerEligibility(null).reason,
    DENY_REASONS.NOT_A_MEMBER,
  );
});

// ===================================================================
// 4. Every DENY must point at reception — plan.md says so explicitly
// ===================================================================

test("no DENY message dead-ends; every one names reception", () => {
  const denials = [
    evaluateMemberEligibility(goodMember({ isActive: false }), NOW),
    evaluateMemberEligibility(goodMember({ endDate: new Date("2020-01-01") }), NOW),
    evaluateMemberEligibility(goodMember({ payments: [] }), NOW),
    evaluateMemberEligibility(null, NOW),
  ];

  for (const d of denials) {
    assert.equal(d.verdict, VERDICT.DENY);
    assert.match(
      d.message,
      /reception/i,
      `DENY(${d.reason}) must tell the member where to go: "${d.message}"`,
    );
    // Nobody is at the door, so nothing may be worded as a refusal of entry.
    assert.doesNotMatch(d.message, /not allowed|cannot enter|denied entry|turn(ed)? away/i);
  }
});

// ===================================================================
// 5. The dispatcher used by the scan handler
// ===================================================================

test("evaluateEligibility routes on subjectType, and defaults to the member rules", () => {
  const expiredish = { isActive: true, endDate: new Date("2020-01-01"), totalFee: 0, payments: [] };

  assert.equal(
    evaluateEligibility("TRAINER", expiredish, NOW).verdict,
    VERDICT.ALLOW,
  );
  assert.equal(
    evaluateEligibility("MEMBER", expiredish, NOW).reason,
    DENY_REASONS.EXPIRED,
  );
  // Anything that is not TRAINER is treated as a member — the stricter branch.
  // Failing open here would let an unrecognised subjectType through unchecked.
  assert.equal(
    evaluateEligibility(undefined, expiredish, NOW).reason,
    DENY_REASONS.EXPIRED,
  );
});
