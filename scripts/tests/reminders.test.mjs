/**
 * OFFLINE unit tests for the Phase 5 REMINDER SCHEDULER.
 *
 * Run:  node --test scripts/tests/reminders.test.mjs
 *       npm run test:unit
 *
 * NO DATABASE, NO SERVER, NO SMTP. services/reminderScheduler.js takes its
 * models and its channel as parameters, so these tests hand it in-memory fakes.
 *
 * ============================================================================
 * THE TWO THINGS THAT MUST NOT HAPPEN, AND THEREFORE GET ASSERTIONS
 * ============================================================================
 * plan.md Phase 5 risk note: "Overselling a class and double-mailing members are
 * both user-visible; an atomic write and ReminderLog are what prevent them."
 * This file is the second half — scripts/tests/booking.test.mjs is the first.
 *
 *   1. NOBODY IS MAILED TWICE for the same reason in the same period. The
 *      guarantee is a UNIQUE INDEX on ReminderLog `{ channel, dedupeKey }`,
 *      claimed BEFORE the send — so the fake below enforces that uniqueness the
 *      way the server would, and test 3 fires two overlapping runs at it.
 *
 *   2. A DRY RUN SENDS NOTHING **AND WRITES NOTHING**. The second half is the
 *      one that would be easy to get wrong and catastrophic to miss: a dry run
 *      that claimed rows would make the first live run skip everybody, send to
 *      nobody, report success, and look exactly like a working feature.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  runReminders,
  dedupeKeyFor,
  buildReminderMessage,
  isLiveSendingEnabled,
} from "../../services/reminderScheduler.js";
import { MEMBER_COHORTS } from "../../services/memberCohorts.js";

// ===================================================================
// Fakes
// ===================================================================

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The slice of MongoDB query syntax the cohort filters actually use. */
const matches = (doc, filter) => {
  for (const [key, cond] of Object.entries(filter)) {
    const actual = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, operand] of Object.entries(cond)) {
        const a = actual instanceof Date ? actual.getTime() : actual;
        const b = operand instanceof Date ? operand.getTime() : operand;
        if (op === "$gte" && !(a >= b)) return false;
        if (op === "$lte" && !(a <= b)) return false;
        if (op === "$lt" && !(a < b)) return false;
        if (op === "$gt" && !(a > b)) return false;
        if (!["$gte", "$lte", "$lt", "$gt"].includes(op)) {
          throw new Error(`fake: unsupported operator ${op}`);
        }
      }
      continue;
    }
    if (actual !== cond) return false;
  }
  return true;
};

const fakeMemberModel = (members) => ({
  find(filter) {
    const chain = {
      sort: () => chain,
      limit: async () => {
        await tick();
        return members.filter((m) => matches(m, filter));
      },
    };
    return chain;
  },
});

/**
 * Stands in for the ReminderLog collection INCLUDING its unique index on
 * `{ channel, dedupeKey }`.
 *
 * The `await tick()` before the uniqueness check is the network round trip —
 * the only place a concurrent run can interleave. The check and the insert then
 * happen in one synchronous block, which is what a unique index buys you on the
 * real server. A duplicate throws `{ code: 11000 }`, exactly as the driver does,
 * because that code is what the scheduler branches on.
 */
const fakeReminderLogModel = () => {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async create(doc) {
      await tick();
      // ---- atomic section: no await below this line ----
      const clash = rows.some(
        (r) => r.channel === doc.channel && r.dedupeKey === doc.dedupeKey,
      );
      if (clash) {
        const err = new Error("E11000 duplicate key error collection: reminderlogs");
        err.code = 11000;
        throw err;
      }
      const row = { _id: `log-${nextId++}`, ...doc };
      rows.push(row);
      return row;
      // ---- end atomic section ----
    },
    async updateOne(filter, update) {
      await tick();
      const row = rows.find((r) => r._id === filter._id);
      if (row) Object.assign(row, update.$set || {});
      return { matchedCount: row ? 1 : 0 };
    },
    async countDocuments(filter) {
      await tick();
      return rows.filter((r) => matches(r, filter)).length;
    },
  };
};

/** A channel that records what it was asked to send instead of sending it. */
const fakeChannel = ({ failOn = () => false } = {}) => {
  const sent = [];
  return {
    name: "EMAIL",
    sent,
    addressOf: (member) => (member.email ? String(member.email).trim() : null),
    async send(message) {
      await tick();
      if (failOn(message)) throw new Error("SMTP said no");
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
};

/**
 * A logger that captures instead of printing.
 *
 * Two reasons, and the second one is not cosmetic:
 *   1. the dry-run recipient list is a PRODUCT of the scheduler, so asserting on
 *      the captured lines is a real test rather than scraping stdout;
 *   2. `node --test` multiplexes a V8-serialised IPC protocol over the child's
 *      stdout, and a few hundred log lines from a run corrupts it — the suite
 *      dies with "Unable to deserialize cloned data" partway through, which
 *      looks like a test failure and is not one.
 */
const capturingLogger = () => {
  const lines = [];
  const push =
    () =>
    (...args) =>
      lines.push(args.map(String).join(" "));
  return { lines, log: push(), warn: push(), error: push() };
};

// ===================================================================
// Fixtures
// ===================================================================

const NOW = new Date("2026-09-13T09:00:00");

/** Expires in 4 days, fully paid, contactable. */
const expiringMember = (over = {}) => ({
  _id: "m-expiring",
  fullName: "Asha Patel",
  email: "asha@example.com",
  branch: "Vasna",
  isActive: true,
  endDate: new Date("2026-09-17"),
  totalFee: 6000,
  payments: [{ amount: 6000 }],
  ...over,
});

/** Lapsed last week. */
const expiredMember = (over = {}) => ({
  _id: "m-expired",
  fullName: "Ravi Shah",
  email: "ravi@example.com",
  branch: "Gotri",
  isActive: true,
  endDate: new Date("2026-09-06"),
  totalFee: 6000,
  payments: [{ amount: 6000 }],
  ...over,
});

/** In date, but ₹2,000 short. */
const owingMember = (over = {}) => ({
  _id: "m-owing",
  fullName: "Meera Joshi",
  email: "meera@example.com",
  branch: "Vasna",
  isActive: true,
  endDate: new Date("2026-12-31"),
  totalFee: 6000,
  payments: [{ amount: 4000 }],
  ...over,
});

/** Runs a pass with live sending forced ON, bypassing the environment. */
const runLive = (members, log, channel, extra = {}) =>
  runReminders({
    now: NOW,
    liveAllowed: true,
    channel,
    deps: { Member: fakeMemberModel(members), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
    // The owner digest reads the EmailSetup row from Mongo to resolve its
    // recipient, and these suites are deliberately DB-free. Tests that care
    // about it pass their own stub through `extra`.
    ownerDigest: false,
    ...extra,
  });

// ===================================================================
// 1. DRY RUN — the default, and it must leave no trace
// ===================================================================

test("a dry run sends nothing and writes NOTHING to ReminderLog", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const report = await runReminders({
    now: NOW,
    liveAllowed: false,
    channel,
    deps: {
      Member: fakeMemberModel([expiringMember(), expiredMember(), owingMember()]),
      ReminderLog: log,
    },
    sendGapMs: 0,
    logger: capturingLogger(),
  });

  assert.equal(report.dryRun, true);
  assert.equal(channel.sent.length, 0, "a dry run must send no mail");
  assert.equal(
    log.rows.length,
    0,
    "a dry run must claim NO ReminderLog rows — claiming them would make the " +
      "first live run skip everybody and silently send to nobody",
  );
  assert.equal(report.totals.wouldSend, 3);
  assert.equal(report.recipients.length, 3);
  assert.ok(report.recipients.every((r) => r.action === "WOULD_SEND"));
});

test("a dry run is repeatable — running it twice still sends and writes nothing", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [expiringMember()];

  for (let i = 0; i < 3; i += 1) {
    const report = await runReminders({
      now: NOW,
      liveAllowed: false,
      channel,
      deps: { Member: fakeMemberModel(members), ReminderLog: log },
      sendGapMs: 0,
      logger: capturingLogger(),
    logger: capturingLogger(),
    });
    assert.equal(report.totals.wouldSend, 1, `pass ${i + 1} should still list the member`);
  }
  assert.equal(channel.sent.length, 0);
  assert.equal(log.rows.length, 0);
});

test("a request cannot switch sending ON — only the environment can", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  // This is the shape of `?dryRun=false` arriving from an HTTP caller.
  const report = await runReminders({
    now: NOW,
    liveAllowed: false,
    dryRun: false,
    channel,
    deps: { Member: fakeMemberModel([expiringMember()]), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
  });

  assert.equal(report.dryRun, true, "dryRun:false from a caller must not enable sending");
  assert.equal(channel.sent.length, 0);
});

test("a caller CAN force a dry run on a live deployment", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const report = await runReminders({
    now: NOW,
    liveAllowed: true,
    dryRun: true,
    channel,
    deps: { Member: fakeMemberModel([expiringMember()]), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
  });

  assert.equal(report.dryRun, true);
  assert.equal(channel.sent.length, 0);
  assert.equal(log.rows.length, 0);
});

test("REMINDERS_LIVE must be the exact string 'true'", () => {
  const original = process.env.REMINDERS_LIVE;
  try {
    for (const value of ["", "1", "yes", "TRUE", "True", " true ", "false"]) {
      process.env.REMINDERS_LIVE = value;
      assert.equal(
        isLiveSendingEnabled(),
        value.trim() === "true",
        `REMINDERS_LIVE=${JSON.stringify(value)} should not arm live sending`,
      );
    }
    process.env.REMINDERS_LIVE = "true";
    assert.equal(isLiveSendingEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.REMINDERS_LIVE;
    else process.env.REMINDERS_LIVE = original;
  }
});

// ===================================================================
// 2. THE DEDUPE — nobody is contacted twice for the same reason
// ===================================================================

test("a second run on the same day contacts nobody again", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [expiringMember(), expiredMember(), owingMember()];

  const first = await runLive(members, log, channel);
  assert.equal(first.totals.sent, 3);
  assert.equal(channel.sent.length, 3);
  assert.equal(log.rows.length, 3);

  const second = await runLive(members, log, channel);
  assert.equal(second.totals.sent, 0, "the second run must send nothing");
  assert.equal(second.totals.skippedAlreadySent, 3);
  assert.equal(channel.sent.length, 3, "no extra mail may leave");
  assert.equal(log.rows.length, 3, "no extra claim rows may be written");
});

test("running every day for a week still mails an expiring member exactly once", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [expiringMember({ endDate: new Date("2026-09-20") })];

  for (let day = 0; day < 7; day += 1) {
    await runReminders({
      now: new Date(`2026-09-1${3 + day}T06:00:00`),
      liveAllowed: true,
      channel,
      cohorts: [MEMBER_COHORTS.EXPIRING_SOON],
      deps: { Member: fakeMemberModel(members), ReminderLog: log },
      sendGapMs: 0,
      logger: capturingLogger(),
    logger: capturingLogger(),
    });
  }

  assert.equal(
    channel.sent.length,
    1,
    "seven daily runs over the seven-day window must produce ONE email",
  );
});

test("two overlapping runs race the unique index, and only one send wins", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [expiringMember(), expiredMember(), owingMember()];

  // A retry firing on top of the scheduled run, or a manual invocation while
  // the cron is mid-flight. Both see "not contacted" if they read first.
  const [a, b] = await Promise.all([
    runLive(members, log, channel),
    runLive(members, log, channel),
  ]);

  assert.equal(
    a.totals.sent + b.totals.sent,
    3,
    `three members, two concurrent runs, three emails total — got ${a.totals.sent + b.totals.sent}`,
  );
  assert.equal(channel.sent.length, 3);
  assert.equal(log.rows.length, 3);
  assert.equal(a.totals.skippedAlreadySent + b.totals.skippedAlreadySent, 3);
});

test("renewing mints a new period, so the next expiry is reminded about again", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const member = expiringMember({ endDate: new Date("2026-09-17") });
  await runLive([member], log, channel, { cohorts: [MEMBER_COHORTS.EXPIRING_SOON] });
  assert.equal(channel.sent.length, 1);

  // The member renews; endDate moves. Same member, new membership period.
  const renewed = { ...member, endDate: new Date("2026-12-17") };
  await runReminders({
    now: new Date("2026-12-13T09:00:00"),
    liveAllowed: true,
    channel,
    cohorts: [MEMBER_COHORTS.EXPIRING_SOON],
    deps: { Member: fakeMemberModel([renewed]), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
  });

  assert.equal(
    channel.sent.length,
    2,
    "a renewed membership's next expiry is a new period and gets its own reminder",
  );
});

test("PAYMENT_DUE is keyed by month — once in September, again in October", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [owingMember()];
  const cohorts = [MEMBER_COHORTS.PAYMENT_DUE];

  await runLive(members, log, channel, { cohorts });
  await runReminders({
    now: new Date("2026-09-28T09:00:00"),
    liveAllowed: true,
    channel,
    cohorts,
    deps: { Member: fakeMemberModel(members), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
  });
  assert.equal(channel.sent.length, 1, "twice in one month is nagging, not reminding");

  await runReminders({
    now: new Date("2026-10-01T09:00:00"),
    liveAllowed: true,
    channel,
    cohorts,
    deps: { Member: fakeMemberModel(members), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
  });
  assert.equal(channel.sent.length, 2, "a new month is a new period");
});

test("a part payment does not mint a new PAYMENT_DUE key", () => {
  const before = dedupeKeyFor(MEMBER_COHORTS.PAYMENT_DUE, owingMember(), NOW);
  const after = dedupeKeyFor(
    MEMBER_COHORTS.PAYMENT_DUE,
    owingMember({ payments: [{ amount: 5000 }] }),
    NOW,
  );
  assert.equal(before, after, "the key must not contain the amount");
});

test("the three cohorts have distinct keys for the same member", () => {
  const m = expiringMember();
  const keys = new Set([
    dedupeKeyFor(MEMBER_COHORTS.EXPIRING_SOON, m, NOW),
    dedupeKeyFor(MEMBER_COHORTS.EXPIRED, m, NOW),
    dedupeKeyFor(MEMBER_COHORTS.PAYMENT_DUE, m, NOW),
  ]);
  assert.equal(keys.size, 3, "'the same reason' means the same COHORT, not the same member");
});

// ===================================================================
// 3. Failure, and why it must not silence a member forever
// ===================================================================

test("a failed send releases its claim so the next run retries that member", async () => {
  const log = fakeReminderLogModel();
  const failing = fakeChannel({ failOn: () => true });
  const members = [expiringMember()];
  const cohorts = [MEMBER_COHORTS.EXPIRING_SOON];

  const first = await runLive(members, log, failing, { cohorts });
  assert.equal(first.totals.failed, 1);
  assert.equal(first.totals.sent, 0);
  assert.equal(log.rows.length, 1, "the failure is kept as evidence");
  assert.equal(log.rows[0].status, "FAILED");
  assert.match(
    log.rows[0].dedupeKey,
    /#failed:/,
    "a failed claim must be taken out of the unique constraint, or one SMTP " +
      "hiccup silences that member for the whole period",
  );

  const working = fakeChannel();
  const second = await runLive(members, log, working, { cohorts });
  assert.equal(second.totals.sent, 1, "the next run must retry the member");
  assert.equal(working.sent.length, 1);
});

// ===================================================================
// 4. Who is skipped, and why it is reported rather than hidden
// ===================================================================

test("a member with no email address is reported, not silently dropped", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const report = await runLive(
    [expiringMember({ email: "" }), expiringMember({ _id: "m-2" })],
    log,
    channel,
    { cohorts: [MEMBER_COHORTS.EXPIRING_SOON] },
  );

  assert.equal(report.totals.skippedNoAddress, 1);
  assert.equal(report.totals.sent, 1);
  assert.equal(
    log.rows.length,
    1,
    "an unreachable member must not consume a claim — they were never contacted",
  );
});

test("a deactivated member is never in any cohort", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const report = await runLive([owingMember({ isActive: false })], log, channel);
  assert.equal(report.totals.considered, 0);
  assert.equal(channel.sent.length, 0);
});

test("a fully paid member is not chased for money", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();

  const report = await runLive([expiringMember()], log, channel, {
    cohorts: [MEMBER_COHORTS.PAYMENT_DUE],
  });
  assert.equal(
    report.totals.sent,
    0,
    "PAYMENT_DUE's query fragment is only `isActive` — the balance check must " +
      "happen in JavaScript, or every active member gets chased",
  );
});

// ===================================================================
// 5. The caps — Gmail's daily ceiling and the function's time budget
// ===================================================================

test("the daily cap stops the run and leaves the rest for tomorrow", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = Array.from({ length: 10 }, (_, i) =>
    expiringMember({ _id: `m-${i}`, email: `m${i}@example.com` }),
  );

  const report = await runLive(members, log, channel, {
    cohorts: [MEMBER_COHORTS.EXPIRING_SOON],
    dailyCap: 4,
  });

  assert.equal(report.totals.sent, 4);
  assert.equal(report.totals.skippedCapped, 6);
  assert.equal(report.stoppedEarly, true);
  assert.equal(
    log.rows.length,
    4,
    "only the members actually attempted may hold a claim, or the remainder is " +
      "never picked up tomorrow",
  );

  // Tomorrow: the cap resets (the fake counts today's SENT rows), and the six
  // who were skipped are contacted.
  const tomorrow = fakeChannel();
  const next = await runReminders({
    now: new Date("2026-09-14T09:00:00"),
    liveAllowed: true,
    channel: tomorrow,
    cohorts: [MEMBER_COHORTS.EXPIRING_SOON],
    deps: { Member: fakeMemberModel(members), ReminderLog: log },
    sendGapMs: 0,
    logger: capturingLogger(),
    dailyCap: 400,
  });
  assert.equal(next.totals.sent, 6, "the backlog drains on the following run");
  assert.equal(next.totals.skippedAlreadySent, 4);
});

test("the per-invocation batch ceiling is a whole-run ceiling, not per cohort", async () => {
  const log = fakeReminderLogModel();
  const channel = fakeChannel();
  const members = [expiringMember(), expiredMember(), owingMember()];

  const report = await runLive(members, log, channel, { batchMax: 2 });
  assert.equal(report.totals.sent, 2);
  assert.equal(report.totals.skippedOutOfTime, 1);
  assert.equal(report.stoppedEarly, true);
});

// ===================================================================
// 6. The copy. A reminder that dead-ends is a reminder that does not work.
// ===================================================================

test("every cohort's message names the member, the action, and where to take it", () => {
  const cases = [
    [MEMBER_COHORTS.EXPIRING_SOON, expiringMember()],
    [MEMBER_COHORTS.EXPIRED, expiredMember()],
    [MEMBER_COHORTS.PAYMENT_DUE, owingMember()],
  ];

  for (const [cohort, member] of cases) {
    const msg = buildReminderMessage(cohort, member, NOW);
    assert.ok(msg.subject.length > 0, `${cohort} needs a subject`);
    assert.ok(msg.text.includes(member.fullName), `${cohort} should address the member`);
    assert.match(msg.text, /reception/i, `${cohort} must say where to go`);
    assert.ok(msg.html.includes("<p"), `${cohort} needs an HTML part`);
    // The reminders go to people who are still customers.
    assert.doesNotMatch(msg.text, /overdue|debt|final notice|suspend/i);
  }
});

test("an unknown cohort throws rather than sending a blank email", () => {
  assert.throws(() => buildReminderMessage("NOT_A_COHORT", expiringMember(), NOW));
});

test("the expiring message counts days the way the dashboard does", () => {
  const today = buildReminderMessage(
    MEMBER_COHORTS.EXPIRING_SOON,
    expiringMember({ endDate: new Date("2026-09-13") }),
    NOW,
  );
  assert.match(today.subject, /today/);

  const tomorrow = buildReminderMessage(
    MEMBER_COHORTS.EXPIRING_SOON,
    expiringMember({ endDate: new Date("2026-09-14") }),
    NOW,
  );
  assert.match(tomorrow.subject, /tomorrow/);
});

// ===================================================================
// 7. The dry-run LOG is the inspection surface. It has to say who and how.
// ===================================================================

test("a dry run logs every recipient and says how to go live", async () => {
  const logger = capturingLogger();

  await runReminders({
    now: NOW,
    liveAllowed: false,
    channel: fakeChannel(),
    deps: {
      Member: fakeMemberModel([expiringMember(), owingMember()]),
      ReminderLog: fakeReminderLogModel(),
    },
    sendGapMs: 0,
    logger,
  });

  const output = logger.lines.join("\n");
  assert.match(output, /DRY RUN/, "the mode must be unmistakable in the log");
  assert.match(output, /asha@example\.com/);
  assert.match(output, /meera@example\.com/);
  assert.match(
    output,
    /REMINDERS_LIVE=true/,
    "the log must name the switch — an operator reading it should not have to " +
      "go and find the variable",
  );
  assert.match(output, /Nothing was written to ReminderLog/);
});

test("a live run does not print the whole recipient list", async () => {
  const logger = capturingLogger();

  await runReminders({
    now: NOW,
    liveAllowed: true,
    channel: fakeChannel(),
    deps: {
      Member: fakeMemberModel([expiringMember()]),
      ReminderLog: fakeReminderLogModel(),
    },
    sendGapMs: 0,
    logger,
  });

  const output = logger.lines.join("\n");
  assert.match(output, /LIVE/);
  assert.doesNotMatch(
    output,
    /would email/,
    "a live run must not claim it 'would' send anything — it did",
  );
});
