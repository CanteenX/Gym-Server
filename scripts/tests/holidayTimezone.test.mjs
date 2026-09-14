/**
 * Calendar days are resolved in IST no matter what clock the SERVER runs on.
 *
 * ============================================================================
 * THE BUG THIS PINS, FOUND IN PRODUCTION DATA
 * ============================================================================
 * `startOfDay` was `d.setHours(0, 0, 0, 0)` — the PROCESS's local midnight —
 * and the module header said so deliberately, resting on "the Node process
 * itself running in IST". That assumption was verified on a dev machine, where
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` really is Asia/Calcutta.
 *
 * Production is Vercel, which runs in UTC, and nothing sets TZ. The proof is in
 * the data: the one live holiday is stored at `2026-09-14T00:00:00.000Z` —
 * exactly UTC midnight. Had the server been in IST it would read
 * `2026-09-13T18:30:00.000Z`. So the test suite passed on a machine whose
 * timezone happened to satisfy the assumption, while the deployed server did
 * the opposite.
 *
 * The visible consequence is a 5.5-hour window every night: between 00:00 and
 * 05:30 IST, a UTC server's "today" is still YESTERDAY in Vadodara. In that
 * window the member portal's "closed today" answers for the wrong day, and a
 * closure entered by an admin is filed a day early.
 *
 * ============================================================================
 * WHY THESE TESTS FORCE THE PROCESS CLOCK AROUND
 * ============================================================================
 * A test that only runs in the ambient timezone cannot catch a timezone bug —
 * that is exactly how this one survived. Each case below states the answer IST
 * must give, and the implementation has to produce it whether the process is
 * in UTC, IST, or somewhere west of both.
 *
 * IST is UTC+05:30 and has never observed daylight saving, so the offset is a
 * constant rather than something to look up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startOfDay, addDays, monthRange } from "../../services/holidayDate.js";

const IST = 5.5 * 60 * 60 * 1000;

/** The IST calendar day an instant falls on, as YYYY-MM-DD. */
const istDay = (d) => new Date(d.getTime() + IST).toISOString().slice(0, 10);

test("startOfDay pins the IST day, not the process's day", () => {
  // 2026-09-14T18:32Z is 00:02 IST on the 15th — inside the broken window.
  const instant = new Date("2026-09-14T18:32:00.000Z");
  assert.equal(
    istDay(startOfDay(instant)),
    "2026-09-15",
    "a UTC server called this the 14th while Vadodara was already on the 15th",
  );
});

test("startOfDay returns the instant of IST midnight", () => {
  const d = startOfDay(new Date("2026-09-14T18:32:00.000Z"));
  assert.equal(
    d.toISOString(),
    "2026-09-14T18:30:00.000Z",
    "IST midnight on the 15th IS 18:30Z on the 14th — not UTC midnight",
  );
});

test("two instants 10 minutes apart on the same UTC day are different IST days", () => {
  /**
   * The boundary case, stated so a regression to UTC storage fails instantly:
   * 18:25Z and 18:35Z are both 14 September in UTC, and are the 14th and the
   * 15th in IST. Anything that collapses them has reverted.
   */
  const before = startOfDay(new Date("2026-09-14T18:25:00.000Z"));
  const after = startOfDay(new Date("2026-09-14T18:35:00.000Z"));
  assert.equal(istDay(before), "2026-09-14");
  assert.equal(istDay(after), "2026-09-15");
  assert.notEqual(before.getTime(), after.getTime());
});

test("addDays crosses a month end without drifting off IST midnight", () => {
  const start = startOfDay(new Date("2026-09-29T20:00:00.000Z")); // 30 Sep IST
  assert.equal(istDay(start), "2026-09-30");
  assert.equal(istDay(addDays(start, 1)), "2026-10-01");
  assert.equal(istDay(addDays(start, 7)), "2026-10-07");
  assert.equal(
    addDays(start, 1).toISOString().slice(11),
    start.toISOString().slice(11),
    "adding a day must not shift the time-of-day component",
  );
});

test("monthRange covers the whole IST month, first day to last", () => {
  const r = monthRange(2026, 9);
  assert.equal(istDay(r.from), "2026-09-01");
  assert.equal(istDay(r.to), "2026-09-30", "September has 30 days");
  const feb = monthRange(2028, 2);
  assert.equal(istDay(feb.to), "2028-02-29", "2028 is a leap year");
});

test("a date-only string is read as that IST day, not as UTC midnight", () => {
  /**
   * `new Date("2026-09-14")` is UTC midnight by specification, which is 05:30
   * IST on the 14th. It must still resolve to the 14th — the failure to guard
   * against would be it landing on the 13th.
   */
  assert.equal(istDay(startOfDay("2026-09-14")), "2026-09-14");
});
