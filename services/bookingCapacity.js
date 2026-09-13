/**
 * The atomic capacity check — the one thing in Phase 5 that a correct-looking
 * implementation gets wrong.
 *
 * ============================================================================
 * WHY THE OBVIOUS IMPLEMENTATION IS BROKEN
 * ============================================================================
 *
 *     const s = await ClassSession.findById(id);          // reads 49 of 50
 *     if (s.bookedCount >= s.capacity) return FULL;       // passes
 *     s.bookedCount += 1;                                 // 50
 *     await s.save();                                     // writes 50
 *
 * Two people tapping "Book" on the last seat inside the same few milliseconds
 * both read 49, both pass the check, and both write 50. The class is oversold,
 * `bookedCount` says 50, there are 51 Booking rows, and NOTHING anywhere logs a
 * problem — the trainer finds out at the door. Node's single thread does not
 * save you: the `await` is exactly where the other request runs. Nor does the
 * serverless model, which makes it worse — two concurrent invocations are two
 * separate containers with no shared memory at all.
 *
 * ============================================================================
 * THE MECHANISM CHOSEN: A CONDITIONAL findOneAndUpdate ON A COUNTER
 * ============================================================================
 * One round trip whose FILTER contains the capacity comparison and whose UPDATE
 * contains the increment:
 *
 *     findOneAndUpdate(
 *       { _id, isActive: true, start: { $gt: now },
 *         $expr: { $lt: ["$bookedCount", "$capacity"] } },
 *       { $inc: { bookedCount: 1 } })
 *
 * MongoDB applies a single-document update atomically: the filter is evaluated
 * and the increment applied under the same document-level lock, and a
 * concurrent update to the same document is serialised behind it. So the 51st
 * caller re-evaluates `$expr` against the already-incremented 50 and matches
 * nothing. It gets `null`, which IS the "class is full" answer — there is no
 * window between the check and the write, because there is no check and write,
 * there is one operation.
 *
 * WHY NOT THE ALTERNATIVES:
 *
 *   - A UNIQUE INDEX ON A SEAT NUMBER (`{ session, seatNo }`, 1..capacity).
 *     Also correct, and it is what this file uses for the *other* race —
 *     one person taking two seats (models/Booking.js). Rejected for capacity
 *     because it needs a seat number the caller does not have: you must either
 *     pre-create `capacity` empty seat rows for every session (a write
 *     amplification, and a schema migration every time capacity is edited) or
 *     guess a number and retry on E11000 until one sticks, which under
 *     contention is a loop whose worst case is `capacity` round trips. The
 *     counter does it in one, always.
 *
 *   - A TRANSACTION (`session.withTransaction`). Correct, and available — Atlas
 *     is a replica set. Rejected as a heavier tool for a problem that is
 *     single-document: transactions add a round trip, a retry loop for
 *     TransientTransactionError, and a failure mode (no transactions on a
 *     standalone mongod) that would break a developer's local machine for no
 *     gain. Reach for one when a booking must span two collections
 *     ATOMICALLY — it does not, see the compensating release below.
 *
 *   - `$inc` FIRST, CHECK AFTER, decrement if over. That is the counter
 *     pattern without the condition, and it is correct only if every failure
 *     path runs. It also lets `bookedCount` transiently exceed `capacity`,
 *     which the public list would render as a negative seat count.
 *
 * ============================================================================
 * THE SEAT IS RESERVED BEFORE THE BOOKING ROW IS WRITTEN
 * ============================================================================
 * Two collections, no transaction, so one of the two orders has to be chosen
 * and its failure mode accepted:
 *
 *   reserve -> insert  : a crash between them leaves the counter one too HIGH.
 *                        The class under-fills by one seat. Recoverable by a
 *                        human, invisible to the member.
 *   insert  -> reserve : a crash between them leaves a booking with no seat.
 *                        The class oversells. The member is told they are in
 *                        and is turned away at the door.
 *
 * The first is strictly the safer failure, so reserve comes first and every
 * failure after it calls releaseSeat() to compensate.
 *
 * ============================================================================
 * NO MONGOOSE IMPORT HERE — THE MODEL IS A PARAMETER.
 * ============================================================================
 * Every function takes the model to operate on. That is what makes
 * scripts/tests/booking.test.mjs able to fire genuinely concurrent bookings at
 * an in-memory fake with MongoDB's single-document semantics, offline, with no
 * database — and what lets that same test demonstrate that the naive
 * read-then-write DOES oversell against the identical harness.
 */

/** Why a reservation was refused. Codes, not prose — callers map them to copy. */
export const RESERVE_ERRORS = {
  /** Every seat is taken. The only refusal a caller should retry later. */
  FULL: "FULL",
  /** No such session id. */
  NOT_FOUND: "NOT_FOUND",
  /** The session exists but is switched off, or has already started. */
  UNAVAILABLE: "UNAVAILABLE",
};

/**
 * The filter half of the atomic reservation, exported so a test can assert on
 * its SHAPE rather than only on its behaviour — a future edit that moves the
 * capacity comparison out of the filter and into JavaScript is the exact
 * regression this whole file exists to prevent, and it would otherwise look
 * like a harmless refactor.
 *
 * @param {*} sessionId
 * @param {Date} now
 * @returns {object} a MongoDB query document
 */
export const reserveFilter = (sessionId, now) => ({
  _id: sessionId,
  isActive: true,
  // A class that has already started cannot be booked. Part of the FILTER, not
  // a separate check, for the same reason the capacity comparison is: a session
  // that starts between the check and the write must not get a booking.
  start: { $gt: now },
  // The capacity check itself. `$expr` is what allows one field of the document
  // to be compared against another inside a query.
  $expr: { $lt: ["$bookedCount", "$capacity"] },
});

/**
 * Takes one seat, atomically.
 *
 * @param {object} SessionModel - the ClassSession model (or a test double).
 * @param {*} sessionId
 * @param {Date} [now] - injected so a test can sit on a time boundary.
 * @returns {Promise<{ok: true, session: object} | {ok: false, code: string}>}
 *   `session` is the document AFTER the increment, so `bookedCount` already
 *   includes this reservation.
 */
export const reserveSeat = async (SessionModel, sessionId, now = new Date()) => {
  const session = await SessionModel.findOneAndUpdate(
    reserveFilter(sessionId, now),
    { $inc: { bookedCount: 1 } },
    { new: true },
  );

  if (session) return { ok: true, session };

  // Nothing matched. That is already the authoritative answer — the seat was
  // NOT taken. This second read exists only to say WHY, for the message shown
  // to the person, and its result is never used to decide anything. If the row
  // changes between the two reads the worst case is a slightly wrong error
  // string on a request that correctly failed.
  const existing = await SessionModel.findById(sessionId);
  if (!existing) return { ok: false, code: RESERVE_ERRORS.NOT_FOUND };

  const full = (existing.bookedCount || 0) >= (existing.capacity || 0);
  return {
    ok: false,
    code: full ? RESERVE_ERRORS.FULL : RESERVE_ERRORS.UNAVAILABLE,
    session: existing,
  };
};

/**
 * Gives a seat back, atomically.
 *
 * ONLY CALL THIS WHEN A SEAT WAS ACTUALLY HELD. Two callers:
 *   1. the compensating path — reserveSeat() succeeded but writing the Booking
 *      row then failed, so the reservation must be undone;
 *   2. a cancellation, and ONLY when the status transition itself succeeded.
 *
 * Point 2 is the subtle one and it is the same race in a different costume: a
 * cancel handler that reads a booking, sees BOOKED, writes CANCELLED and then
 * decrements will decrement TWICE if the member double-taps Cancel. The fix is
 * the same shape as the reservation — make the status change a conditional
 * update (`{ _id, status: "BOOKED" }` -> `CANCELLED`) and release the seat only
 * when that update returned a document. The second tap matches nothing and
 * releases nothing.
 *
 * `bookedCount: { $gt: 0 }` in the filter is a floor, not a guard against the
 * above: it stops a double release storing -1 and then rendering a class with
 * more seats than it has.
 *
 * @param {object} SessionModel
 * @param {*} sessionId
 * @returns {Promise<boolean>} whether a seat was actually returned.
 */
export const releaseSeat = async (SessionModel, sessionId) => {
  const updated = await SessionModel.findOneAndUpdate(
    { _id: sessionId, bookedCount: { $gt: 0 } },
    { $inc: { bookedCount: -1 } },
    { new: true },
  );
  return Boolean(updated);
};

export default { reserveSeat, releaseSeat, reserveFilter, RESERVE_ERRORS };
