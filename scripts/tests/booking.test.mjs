/**
 * OFFLINE unit tests for the Phase 5 ATOMIC CAPACITY CHECK.
 *
 * Run:  node --test scripts/tests/booking.test.mjs
 *       npm run test:unit
 *
 * NO DATABASE, NO SERVER. services/bookingCapacity.js takes the model as a
 * PARAMETER, so these tests hand it an in-memory fake that reproduces the one
 * MongoDB guarantee the whole design rests on — a single-document update
 * evaluates its filter and applies its update atomically, with concurrent
 * updates to the same document serialised behind it.
 *
 * ============================================================================
 * WHY THE FAKE IS TRUSTWORTHY, AND HOW YOU CAN TELL
 * ============================================================================
 * A test harness that cannot fail proves nothing. The obvious failure mode here
 * is a fake so synchronous that ANY implementation passes — including the naive
 * read-then-write the real code is written to avoid.
 *
 * So the fake awaits a tick BEFORE the atomic section (that is the network
 * round trip, and it is where another request gets to run) and only then
 * matches and mutates, synchronously, in one uninterruptible block. That is
 * exactly MongoDB's shape.
 *
 * And test 2 below runs the NAIVE implementation against the identical fake and
 * asserts that it OVERSELLS. If someone ever makes the fake too forgiving, that
 * test fails first and says so.
 *
 * plan.md Phase 5 risk note: "Overselling a class and double-mailing members are
 * both user-visible; an atomic write and ReminderLog are what prevent them."
 * This file is the first half.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  reserveSeat,
  releaseSeat,
  reserveFilter,
  RESERVE_ERRORS,
} from "../../services/bookingCapacity.js";

// ===================================================================
// A fake ClassSession collection with MongoDB's single-document semantics.
// ===================================================================

/** Resolves a dotted/`$`-prefixed field path against a document. */
const valueAt = (doc, path) =>
  typeof path === "string" && path.startsWith("$")
    ? doc[path.slice(1)]
    : path;

/**
 * The minimum query language services/bookingCapacity.js actually uses.
 *
 * Supports equality, `$gt`, and the `$expr: { $lt: [a, b] }` that compares one
 * field of a document against another — which is the operator the whole
 * capacity check is expressed in. Anything else throws rather than quietly
 * matching, so a future filter that this fake does not understand fails loudly
 * instead of appearing to work.
 */
const matches = (doc, filter) => {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$expr") {
      const [op, args] = Object.entries(cond)[0];
      const [a, b] = args.map((p) => valueAt(doc, p));
      if (op === "$lt") {
        if (!(a < b)) return false;
        continue;
      }
      throw new Error(`fake: unsupported $expr operator ${op}`);
    }

    const actual = key === "_id" ? doc._id : doc[key];

    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (op === "$gt") {
          if (!(actual > operand)) return false;
        } else {
          throw new Error(`fake: unsupported operator ${op}`);
        }
      }
      continue;
    }

    if (String(actual) !== String(cond)) return false;
  }
  return true;
};

/** Applies the update operators the module uses. Only `$inc` today. */
const applyUpdate = (doc, update) => {
  for (const [op, fields] of Object.entries(update)) {
    if (op !== "$inc") throw new Error(`fake: unsupported update operator ${op}`);
    for (const [field, delta] of Object.entries(fields)) {
      doc[field] = (doc[field] || 0) + delta;
    }
  }
};

/**
 * An in-memory stand-in for a Mongoose model over one collection.
 *
 * `findOneAndUpdate` is the important one. The `await tick()` is the network
 * round trip — the ONLY place another concurrent caller can interleave. Once
 * past it, the match and the mutation happen in one synchronous block, which is
 * what a document-level lock buys you on the real server.
 */
const makeFakeModel = (docs) => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let roundTrips = 0;

  return {
    docs,
    get roundTrips() {
      return roundTrips;
    },
    async findOneAndUpdate(filter, update, _options) {
      roundTrips += 1;
      await tick();
      // ---- atomic section: no await below this line ----
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      return { ...doc };
      // ---- end atomic section ----
    },
    async findById(id) {
      roundTrips += 1;
      await tick();
      const doc = docs.find((d) => String(d._id) === String(id));
      return doc ? { ...doc } : null;
    },
  };
};

const futureStart = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const makeSession = (over = {}) => ({
  _id: "class-1",
  isActive: true,
  start: futureStart(),
  capacity: 50,
  bookedCount: 0,
  branch: "Vasna",
  ...over,
});

// ===================================================================
// 1. THE HEADLINE TEST: concurrent bookings cannot oversell.
// ===================================================================

test("200 concurrent bookings against 50 seats fill exactly 50", async () => {
  const session = makeSession({ capacity: 50 });
  const model = makeFakeModel([session]);

  const attempts = 200;
  const results = await Promise.all(
    Array.from({ length: attempts }, () => reserveSeat(model, "class-1")),
  );

  const won = results.filter((r) => r.ok).length;
  const full = results.filter((r) => !r.ok && r.code === RESERVE_ERRORS.FULL).length;

  assert.equal(won, 50, `exactly 50 reservations should succeed, got ${won}`);
  assert.equal(full, attempts - 50, "every loser should be told the class is FULL");
  assert.equal(
    session.bookedCount,
    50,
    `bookedCount must land on capacity, got ${session.bookedCount}`,
  );
  assert.ok(
    session.bookedCount <= session.capacity,
    "bookedCount must NEVER exceed capacity",
  );
});

test("the last seat goes to exactly one of two simultaneous bookers", async () => {
  const session = makeSession({ capacity: 1 });
  const model = makeFakeModel([session]);

  const [a, b] = await Promise.all([
    reserveSeat(model, "class-1"),
    reserveSeat(model, "class-1"),
  ]);

  assert.equal(
    [a.ok, b.ok].filter(Boolean).length,
    1,
    "exactly one of the two must win the last seat",
  );
  assert.equal(session.bookedCount, 1);
  const loser = a.ok ? b : a;
  assert.equal(loser.code, RESERVE_ERRORS.FULL);
});

// ===================================================================
// 2. THE HARNESS IS NOT VACUOUS: the naive implementation DOES oversell here.
// ===================================================================

test("HARNESS CHECK — read-then-write oversells against the same fake", async () => {
  const session = makeSession({ capacity: 50 });
  const model = makeFakeModel([session]);

  /**
   * The implementation services/bookingCapacity.js exists to avoid. Reproduced
   * here, once, so that the passing tests above mean something: if this ever
   * stops overselling, the fake has become too forgiving and every other
   * assertion in this file is worthless.
   */
  const naiveReserve = async () => {
    const current = await model.findById("class-1");
    if (!current) return { ok: false };
    if (current.bookedCount >= current.capacity) return { ok: false };
    // The gap. Another request runs right here.
    await model.findOneAndUpdate({ _id: "class-1" }, { $inc: { bookedCount: 1 } });
    return { ok: true };
  };

  const results = await Promise.all(
    Array.from({ length: 200 }, () => naiveReserve()),
  );
  const won = results.filter((r) => r.ok).length;

  assert.ok(
    won > 50,
    `the naive implementation should oversell, but only ${won} of 200 succeeded — ` +
      `the fake is not modelling concurrency and the other tests prove nothing`,
  );
  assert.ok(
    session.bookedCount > session.capacity,
    "the naive implementation should push bookedCount past capacity",
  );
});

// ===================================================================
// 3. The condition lives in the FILTER. A refactor that moves it out is the
//    regression this whole file guards against, and it would look harmless.
// ===================================================================

test("the capacity comparison is part of the query filter, not JavaScript", () => {
  const now = new Date("2026-09-13T10:00:00Z");
  const filter = reserveFilter("class-1", now);

  assert.deepEqual(
    filter.$expr,
    { $lt: ["$bookedCount", "$capacity"] },
    "the capacity check must be an $expr in the filter, evaluated by the server",
  );
  assert.deepEqual(filter.start, { $gt: now }, "a started class must not be bookable");
  assert.equal(filter.isActive, true, "a switched-off class must not be bookable");
});

test("one reservation costs one round trip on the happy path", async () => {
  const model = makeFakeModel([makeSession()]);
  const before = model.roundTrips;
  const result = await reserveSeat(model, "class-1");
  assert.equal(result.ok, true);
  assert.equal(
    model.roundTrips - before,
    1,
    "a successful reservation must be a single findOneAndUpdate — a second " +
      "round trip means a check was reintroduced alongside the write",
  );
});

// ===================================================================
// 4. The refusals that are not "full"
// ===================================================================

test("a switched-off class refuses with UNAVAILABLE, not FULL", async () => {
  const model = makeFakeModel([makeSession({ isActive: false })]);
  const result = await reserveSeat(model, "class-1");
  assert.equal(result.ok, false);
  assert.equal(result.code, RESERVE_ERRORS.UNAVAILABLE);
});

test("a class that has already started refuses with UNAVAILABLE", async () => {
  const model = makeFakeModel([
    makeSession({ start: new Date(Date.now() - 60_000) }),
  ]);
  const result = await reserveSeat(model, "class-1");
  assert.equal(result.ok, false);
  assert.equal(result.code, RESERVE_ERRORS.UNAVAILABLE);
});

test("an unknown class id refuses with NOT_FOUND", async () => {
  const model = makeFakeModel([makeSession()]);
  const result = await reserveSeat(model, "nope");
  assert.equal(result.ok, false);
  assert.equal(result.code, RESERVE_ERRORS.NOT_FOUND);
});

test("a class that is full but otherwise fine is reported as FULL", async () => {
  const model = makeFakeModel([makeSession({ capacity: 3, bookedCount: 3 })]);
  const result = await reserveSeat(model, "class-1");
  assert.equal(result.ok, false);
  assert.equal(result.code, RESERVE_ERRORS.FULL);
});

// ===================================================================
// 5. Releasing a seat — the compensating path, and the double-cancel floor
// ===================================================================

test("releasing a seat lets the next booker in", async () => {
  const session = makeSession({ capacity: 1 });
  const model = makeFakeModel([session]);

  assert.equal((await reserveSeat(model, "class-1")).ok, true);
  assert.equal((await reserveSeat(model, "class-1")).ok, false);

  assert.equal(await releaseSeat(model, "class-1"), true);
  assert.equal(session.bookedCount, 0);

  assert.equal((await reserveSeat(model, "class-1")).ok, true);
});

test("releasing more than was taken cannot drive bookedCount negative", async () => {
  const session = makeSession({ capacity: 5, bookedCount: 1 });
  const model = makeFakeModel([session]);

  assert.equal(await releaseSeat(model, "class-1"), true);
  // The second release is the double-tap-Cancel case. It must be refused, not
  // applied — see the note on conditional status transitions in bookingCapacity.js.
  assert.equal(await releaseSeat(model, "class-1"), false);
  assert.equal(session.bookedCount, 0);
});

test("concurrent releases of a single held seat return only that one seat", async () => {
  const session = makeSession({ capacity: 10, bookedCount: 1 });
  const model = makeFakeModel([session]);

  const results = await Promise.all([
    releaseSeat(model, "class-1"),
    releaseSeat(model, "class-1"),
    releaseSeat(model, "class-1"),
  ]);

  assert.equal(results.filter(Boolean).length, 1, "only one release may succeed");
  assert.equal(session.bookedCount, 0);
});

// ===================================================================
// 6. Full cycle under contention: book, cancel, rebook
// ===================================================================

test("a full class reopens exactly one seat when one booking is cancelled", async () => {
  const session = makeSession({ capacity: 10 });
  const model = makeFakeModel([session]);

  const first = await Promise.all(
    Array.from({ length: 40 }, () => reserveSeat(model, "class-1")),
  );
  assert.equal(first.filter((r) => r.ok).length, 10);

  await releaseSeat(model, "class-1");

  const second = await Promise.all(
    Array.from({ length: 40 }, () => reserveSeat(model, "class-1")),
  );
  assert.equal(
    second.filter((r) => r.ok).length,
    1,
    "exactly one of the 40 retries may take the freed seat",
  );
  assert.equal(session.bookedCount, 10);
});
