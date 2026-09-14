/**
 * IST calendar-day math for the Holiday Master, kept as a pure module so it
 * can be pinned by tests without a database — the same reasoning
 * services/attendanceEligibility.js gives for staying pure.
 *
 * ============================================================================
 * THE CONVENTION, AND WHY IT IS NOT INVENTED HERE.
 * ============================================================================
 * `controllers/v1/attendance.controller.js` and
 * `controllers/v1/bodyMetrics.controller.js` already answer "which calendar
 * day does this belong to?" with:
 *
 *     const d = value ? new Date(value) : new Date();
 *     d.setHours(0, 0, 0, 0);
 *
 * — the server's own LOCAL midnight, never `setUTCHours`. `startOfDay` below
 * is that same function, not a second one. A holiday is a CALENDAR DAY the
 * gym is shut (Vadodara, IST, UTC+5:30), not an instant, so the trap is the
 * same one Attendance already avoided: storing a UTC midnight would render a
 * holiday entered as "14 Sept" as "13 Sept, 18:30" on an IST clock — which
 * renders as CLOSED ON THE WRONG DAY on any calendar or dashboard that shows
 * it, the exact "closed Saturday shows on Friday" bug nobody notices until a
 * member turns up. See scripts/tests/holidayDate.test.mjs for the boundary
 * case pinned as an executable assertion, not a comment somebody has to trust.
 *
 * THE ASSUMPTION THIS RESTS ON, STATED RATHER THAN HIDDEN: the Node process
 * itself runs with IST as its local timezone (confirmed for both the dev
 * machine and the `7001-demo` production process — see process.json). If that
 * ever stops being true, Attendance, BodyMetric AND this file all drift
 * together, and all three should move to an explicit `Asia/Kolkata` offset in
 * the same change — not silently, one file at a time.
 */

/** A finite Date normalised to LOCAL midnight, or null for a bad input. */
/**
 * IST is UTC+05:30 and has never observed daylight saving, so the offset is a
 * constant rather than something to look up. Used to shift an instant into IST,
 * do calendar arithmetic with the UTC accessors (which cannot be influenced by
 * the process clock), and shift back.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The instant of IST midnight on the calendar day `value` falls on.
 *
 * This was `d.setHours(0, 0, 0, 0)` — the PROCESS's local midnight — resting on
 * the assumption that the Node process runs in IST. That held on the dev
 * machine, where the timezone really is Asia/Calcutta, and is false in
 * production: Vercel runs in UTC and nothing sets TZ. The live data proved it —
 * the one stored holiday read 2026-09-14T00:00:00.000Z, exactly UTC midnight,
 * where an IST server would have written 2026-09-13T18:30:00.000Z.
 *
 * The cost was a 5.5-hour window every night: between 00:00 and 05:30 IST a UTC
 * server's "today" is still YESTERDAY in Vadodara, so the member portal
 * answered "closed today" for the wrong day and a closure entered in those
 * hours was filed a day early.
 *
 * Reading the offset explicitly removes the dependency entirely: the answer is
 * now the same whether the process is in UTC, IST or anywhere else, which is
 * what scripts/tests/holidayTimezone.test.mjs forces by running under TZ=UTC.
 *
 * Rows written under the OLD convention still resolve correctly and need no
 * migration: UTC midnight of day D (D T00:00Z) falls inside IST day D, whose
 * window is D-1 T18:30Z .. D T18:30Z. Every comparison here is a range, so an
 * old row lands on the same calendar day a new one would.
 */
export const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
};

/** `day` plus `n` calendar days, still at local midnight. Never mutates `day`. */
export const addDays = (day, n) => {
  // setDate()/getDate() read the PROCESS clock, so on a UTC server this
  // rolled the wrong calendar day at the IST boundary. Shift into IST, move
  // the day with the UTC accessors, shift back.
  const ist = new Date(new Date(day).getTime() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() + n);
  return new Date(ist.getTime() - IST_OFFSET_MS);
};

/**
 * The last calendar day a holiday keeps the gym shut: `endDate` for a range,
 * `date` itself for a single day. Both inputs are re-normalised defensively —
 * a lean() document read straight from Mongo is already local midnight, but a
 * caller building a fixture by hand should not have to remember that.
 */
export const holidayEndDay = (holiday) =>
  holiday?.endDate ? startOfDay(holiday.endDate) : startOfDay(holiday?.date);

/**
 * True when `day` falls anywhere inside a holiday's span, inclusive both
 * ends. This is what answers "is TODAY covered by this holiday", including a
 * multi-day closure that started before today and is still running — the case
 * a plain `date === today` equality would miss entirely.
 */
export const holidayCoversDay = (holiday, day) => {
  const start = startOfDay(holiday?.date);
  const end = holidayEndDay(holiday);
  const d = startOfDay(day);
  if (!start || !end || !d) return false;
  return d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
};

/**
 * A Mongo filter fragment matching every Holiday document whose span overlaps
 * `[from, to]` (both inclusive local-midnight Dates), INCLUDING a range that
 * started before `from` but is still running.
 *
 * The condition being encoded: `holiday.date <= to AND (holiday.endDate ??
 * holiday.date) >= from`. A naive `date BETWEEN from AND to` misses exactly
 * the case the owner called out: a 3-day closure that started yesterday and
 * is still covering today would not be found by a query that only looks at
 * the START date falling inside the window.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {object}
 */
export const overlapFilter = (from, to) => ({
  date: { $lte: to },
  $or: [
    { endDate: null, date: { $gte: from } },
    { endDate: { $gte: from } },
  ],
});

/**
 * The local-midnight `[from, to]` bounds of one calendar month, 1-indexed
 * (`month: 9` is September) to match how the admin calendar widget and the
 * `?year=&month=` query param are documented.
 *
 * @param {string|number} year
 * @param {string|number} month 1-12
 * @returns {{from: Date, to: Date}|null} null when year/month don't parse
 */
export const monthRange = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return null;
  }
  // Date.UTC, not new Date(y, m, d): the latter builds the date in the
  // process's timezone, which is the dependency this module just removed.
  const from = startOfDay(new Date(Date.UTC(y, m - 1, 1, 12)));
  // Day 0 of the FOLLOWING month is JavaScript's own idiom for "the last day
  // of this month" — it rolls back rather than overflowing.
  const to = startOfDay(new Date(Date.UTC(y, m, 0, 12)));
  return { from, to };
};
