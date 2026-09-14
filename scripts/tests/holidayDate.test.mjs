/**
 * OFFLINE unit tests for services/holidayDate.js — the IST calendar-day math
 * behind the Holiday Master.
 *
 * Run:  node --test scripts/tests/holidayDate.test.mjs
 *       npm run test:unit
 *
 * NO DATABASE. Pure functions over plain Dates, same reasoning
 * eligibility.test.mjs gives for staying offline.
 *
 * ============================================================================
 * THE BOUNDARY TEST BELOW IS THE WHOLE POINT OF THIS FILE.
 * ============================================================================
 * The trap named in the brief: a holiday stored as a UTC midnight silently
 * becomes the PREVIOUS day the moment it is rendered in IST. This suite pins
 * startOfDay() against two instants either side of the actual IST midnight
 * that fall on the SAME UTC calendar date — so a regression to `setUTCHours`
 * would collapse both into "the 14th" and this test would catch it
 * immediately, rather than someone discovering "closed Saturday" showing up
 * as "closed Friday" in production.
 *
 * This assumes the process running the test is itself on IST local time —
 * the same assumption services/holidayDate.js documents and the same one
 * Attendance/BodyMetric already make. Confirmed for this environment via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` -> "Asia/Calcutta".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  startOfDay,
  addDays,
  holidayEndDay,
  holidayCoversDay,
  overlapFilter,
  monthRange,
} from "../../services/holidayDate.js";

test("this environment runs on IST — otherwise the boundary test below is meaningless", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Calcutta");
});

// ===================================================================
// 1. The IST boundary — the trap named in the brief
// ===================================================================

test("startOfDay pins the IST calendar day, not the UTC one, right across midnight", () => {
  // 23:55 IST on 14 Jan 2026 == 18:25 UTC, still the 14th in UTC too.
  const lateNightIST = new Date("2026-01-14T18:25:00.000Z");
  const day1 = startOfDay(lateNightIST);
  assert.equal(day1.getFullYear(), 2026);
  assert.equal(day1.getMonth(), 0); // January
  assert.equal(
    day1.getDate(),
    14,
    "23:55 IST is still the 14th in IST",
  );

  // 10 minutes of REAL time later: 00:05 IST on 15 Jan 2026 == 18:35 UTC on
  // the 14th — the UTC CALENDAR DATE has not changed at all.
  const justAfterMidnightIST = new Date("2026-01-14T18:35:00.000Z");
  const day2 = startOfDay(justAfterMidnightIST);
  assert.equal(
    day2.getDate(),
    15,
    "00:05 IST has rolled into the 15th, even though the UTC calendar date " +
      "is unchanged — a UTC-midnight implementation would wrongly report 14",
  );

  // And the two results are exactly one calendar day apart, at local midnight.
  assert.equal(day2.getTime() - day1.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(day1.getHours(), 0);
  assert.equal(day1.getMinutes(), 0);
  assert.equal(day1.getSeconds(), 0);
  assert.equal(day1.getMilliseconds(), 0);
});

test("startOfDay: an unparsable value is null, not a NaN date that sorts silently wrong forever", () => {
  assert.equal(startOfDay("not a date"), null);
});

test("startOfDay: falsy input (\"\", null, undefined) defaults to today, matching Attendance's startOfDay", () => {
  // `value ? new Date(value) : new Date()` — the exact convention
  // controllers/v1/attendance.controller.js and bodyMetrics.controller.js
  // already use. "" and null are not "invalid dates" here, they are simply
  // absent, and an absent value means "now".
  const now = new Date();
  for (const falsy of ["", null, undefined]) {
    const day = startOfDay(falsy);
    assert.equal(day.getFullYear(), now.getFullYear());
    assert.equal(day.getMonth(), now.getMonth());
    assert.equal(day.getDate(), now.getDate());
  }
});

test("startOfDay: no argument defaults to today, at local midnight", () => {
  const today = startOfDay();
  const now = new Date();
  assert.equal(today.getFullYear(), now.getFullYear());
  assert.equal(today.getMonth(), now.getMonth());
  assert.equal(today.getDate(), now.getDate());
  assert.equal(today.getHours(), 0);
});

// ===================================================================
// 2. addDays / holidayEndDay / holidayCoversDay
// ===================================================================

test("addDays never mutates its input", () => {
  const day = startOfDay("2026-09-14");
  const original = day.getTime();
  const plus7 = addDays(day, 7);
  assert.equal(day.getTime(), original, "input must be untouched");
  assert.equal(plus7.getDate(), 21);
});

test("holidayEndDay: endDate for a range, date itself for a single day", () => {
  assert.equal(
    holidayEndDay({ date: "2026-09-14", endDate: null }).getDate(),
    14,
  );
  assert.equal(
    holidayEndDay({ date: "2026-09-14", endDate: "2026-09-16" }).getDate(),
    16,
  );
});

test("holidayCoversDay: a multi-day closure covers every day in its inclusive span", () => {
  const diwali = { date: "2026-11-08", endDate: "2026-11-10" };
  assert.equal(holidayCoversDay(diwali, "2026-11-07"), false, "day before");
  assert.equal(holidayCoversDay(diwali, "2026-11-08"), true, "first day");
  assert.equal(holidayCoversDay(diwali, "2026-11-09"), true, "middle day");
  assert.equal(holidayCoversDay(diwali, "2026-11-10"), true, "last day");
  assert.equal(holidayCoversDay(diwali, "2026-11-11"), false, "day after");
});

test("holidayCoversDay: a single-day holiday covers only that day", () => {
  const single = { date: "2026-09-14", endDate: null };
  assert.equal(holidayCoversDay(single, "2026-09-13"), false);
  assert.equal(holidayCoversDay(single, "2026-09-14"), true);
  assert.equal(holidayCoversDay(single, "2026-09-15"), false);
});

// ===================================================================
// 3. overlapFilter — the multi-day-spanning-the-window case
// ===================================================================

/**
 * A tiny in-memory stand-in for how MongoDB would evaluate the filter
 * overlapFilter() produces, against one holiday document. Lets the test talk
 * about DOCUMENTS overlapping a window rather than about the filter's own
 * shape, while the shape itself is still pinned separately below.
 */
const matchesOverlap = (holiday, from, to) => {
  const passesDate = holiday.date.getTime() <= to.getTime();
  const passesOr =
    (holiday.endDate === null && holiday.date.getTime() >= from.getTime()) ||
    (holiday.endDate !== null && holiday.endDate.getTime() >= from.getTime());
  return passesDate && passesOr;
};

test("overlapFilter: a range that STARTED before the window but is still running is matched", () => {
  const from = startOfDay("2026-09-14");
  const to = startOfDay("2026-09-21");

  // A 3-day closure 12–14 Sept overlaps [14, 21] on its very last day only.
  // A naive "date BETWEEN from AND to" on the START date alone (12 Sept, well
  // before `from`) would miss it entirely.
  const spansIn = { date: startOfDay("2026-09-12"), endDate: startOfDay("2026-09-14") };
  assert.equal(matchesOverlap(spansIn, from, to), true);

  // A closure that ended before the window entirely is correctly excluded.
  const finishedBefore = { date: startOfDay("2026-09-01"), endDate: startOfDay("2026-09-05") };
  assert.equal(matchesOverlap(finishedBefore, from, to), false);

  // A single-day holiday inside the window is matched; one after it is not.
  assert.equal(matchesOverlap({ date: startOfDay("2026-09-15"), endDate: null }, from, to), true);
  assert.equal(matchesOverlap({ date: startOfDay("2026-09-22"), endDate: null }, from, to), false);

  // The filter SHAPE itself, pinned so a refactor can't quietly change what
  // gets sent to Mongo without a test noticing.
  const filter = overlapFilter(from, to);
  assert.deepEqual(filter.date, { $lte: to });
  assert.equal(filter.$or.length, 2);
  assert.deepEqual(filter.$or[0], { endDate: null, date: { $gte: from } });
  assert.deepEqual(filter.$or[1], { endDate: { $gte: from } });
});

// ===================================================================
// 4. monthRange — the calendar widget's month bounds
// ===================================================================

test("monthRange: September 2026 is the 1st through the 30th, at local midnight", () => {
  const range = monthRange(2026, 9);
  assert.equal(range.from.getFullYear(), 2026);
  assert.equal(range.from.getMonth(), 8); // 0-indexed
  assert.equal(range.from.getDate(), 1);
  assert.equal(range.to.getDate(), 30);
  assert.equal(range.from.getHours(), 0);
});

test("monthRange: February in a leap year ends on the 29th", () => {
  const range = monthRange(2028, 2);
  assert.equal(range.to.getDate(), 29);
});

test("monthRange: rejects an out-of-range or non-numeric month", () => {
  assert.equal(monthRange(2026, 0), null);
  assert.equal(monthRange(2026, 13), null);
  assert.equal(monthRange(2026, "sep"), null);
  assert.equal(monthRange(undefined, undefined), null);
});
