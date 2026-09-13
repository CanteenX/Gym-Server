/**
 * The retention reminder scheduler: who to contact, about what, and not twice.
 *
 * ============================================================================
 * IT SHIPS IN DRY-RUN MODE. IT SENDS NOTHING UNTIL SOMEBODY SAYS SO.
 * ============================================================================
 * `REMINDERS_LIVE` must be the exact string "true" in the environment before a
 * single email leaves this file. Anything else — unset, "1", "yes", "TRUE",
 * empty — is a dry run: the cohorts are resolved, the recipient list is logged
 * and returned in the response, and no mail is sent and NO ReminderLog ROW IS
 * WRITTEN.
 *
 * Why the strict string, when `=== "true"` looks pedantic next to the
 * `toBool()` helpers elsewhere in this codebase: every other boolean here is
 * about how a row renders. This one is about whether a few hundred people get
 * an unsolicited email from a gym. The failure directions are not symmetric, so
 * the switch is deliberately awkward to flip by accident and impossible to flip
 * by typo.
 *
 * Why a dry run writes NOTHING to ReminderLog: a claimed row is a promise that
 * the person WAS contacted. If a dry run claimed rows, the first real run would
 * find every one of them already claimed, send to nobody, report success, and
 * look exactly like a working feature. That is the single worst bug this file
 * could have, so the dry-run branch returns before the claim rather than after.
 *
 * ============================================================================
 * CHANNEL-AGNOSTIC BY CONSTRUCTION (plan.md §1: email only, for now)
 * ============================================================================
 * There is no SMS or WhatsApp provider and none is to be added. But the cohort
 * resolution, the dedupe, the cap and the batching below know nothing about
 * email: a channel is an object with a `name`, an `addressOf(member)` and a
 * `send(message)`, and EMAIL_CHANNEL at the bottom is the only implementation.
 * Adding one later is writing a second such object — the dedupe key is already
 * scoped by channel (models/ReminderLog.js), so switching one on cannot
 * suppress the other.
 *
 * ============================================================================
 * COHORTS ARE NOT DEFINED HERE
 * ============================================================================
 * They come from services/memberCohorts.js, which the admin dashboard also
 * reads. Re-deriving "expiring in 7 days" in this file is how the email and the
 * dashboard end up disagreeing about who is expiring — see that file's header.
 */
import MemberModel from "../models/Member.js";
import ReminderLogModel from "../models/ReminderLog.js";
import { sendMail, getMailFromAddress } from "./mailService.js";
import {
  MEMBER_COHORTS,
  MEMBER_COHORT_LIST,
  cohortFilter,
  daysToExpiry,
  isInCohort,
  memberBalance,
  startOfToday,
} from "./memberCohorts.js";

/**
 * ============================================================================
 * GMAIL'S CEILING IS THE BINDING CONSTRAINT, AND IT IS ACCOUNT-WIDE.
 * ============================================================================
 * Gmail SMTP allows roughly 500 recipients per day for the WHOLE account — the
 * same account that sends OTPs and lead notifications (plan.md §1). Past it,
 * Gmail does not queue: it starts rejecting with a 550 "Daily user sending
 * limit exceeded", and sustained abuse gets the account temporarily locked,
 * which would take OTP login down with it.
 *
 * So the default is 400, not 500: ~100 a day of headroom for the traffic this
 * job does not control. A cohort larger than the remaining budget is not
 * dropped — the run sends what it can and reports the rest, and because a
 * dedupe row is claimed ONLY for the members actually attempted, tomorrow's run
 * picks up exactly where this one stopped. A 900-member backlog therefore
 * drains over three days instead of failing on day one. That is the honest
 * behaviour, but it IS a behaviour: a "your membership expires in 7 days" email
 * that arrives three days late is a worse email. If the member base ever grows
 * past a few hundred reminders a day, the fix is a real sending domain
 * (Resend/SES/Postmark), not a bigger number here.
 */
const DEFAULT_DAILY_CAP = 400;

/**
 * ============================================================================
 * THE OTHER CEILING: THE FUNCTION IS KILLED AT maxDuration.
 * ============================================================================
 * vercel.json caps api/index.js at 30 seconds. An SMTP send costs roughly
 * 200-600 ms, so a run that tried to clear a 400-member cap in one invocation
 * would be killed somewhere around email 60 — mid-send, with no chance to mark
 * the row. So the run stops ON ITS OWN with time to spare and reports what is
 * left. Deliberately well under 30 s: the cohort queries and the final response
 * have to fit too.
 */
const DEFAULT_MAX_RUN_MS = 22000;

/** Emails per invocation, independent of the time budget. Whichever binds first wins. */
const DEFAULT_BATCH_MAX = 60;

/**
 * A pause between sends.
 *
 * Not politeness — Gmail throttles bursts from one account independently of the
 * daily limit, and a tight loop is what trips it. 150 ms is invisible against
 * the send itself and keeps the run under ~7/second.
 */
const DEFAULT_SEND_GAP_MS = 150;

/** How many members one cohort query will pull at most. A safety rail, not a page size. */
const COHORT_FETCH_LIMIT = 2000;

/**
 * Ceiling on the call list carried in the report and the owner digest.
 *
 * A digest nobody can read is a digest nobody reads. Past this the email says
 * how many more there are and points at the export, rather than pasting a
 * thousand rows into an inbox.
 */
const UNREACHABLE_CAP = 200;

const sleep = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms).unref?.()) : undefined;

/** "2026-09-20" — a date with no time and no timezone suffix, for a key. */
const isoDate = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "no-end-date";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "2026-09" — the PAYMENT_DUE period. */
const isoMonth = (value) => isoDate(value).slice(0, 7);

/** Escapes a value for interpolation into an HTML email body. */
const esc = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * THE ONLY PLACE A DEDUPE KEY IS BUILT. Never parse one; see models/ReminderLog.js
 * for what each cohort's period means and why.
 *
 * @param {string} cohort
 * @param {object} member
 * @param {Date} now
 * @returns {string}
 */
export const dedupeKeyFor = (cohort, member, now = new Date()) => {
  const id = String(member?._id ?? member?.id ?? "unknown");
  if (cohort === MEMBER_COHORTS.PAYMENT_DUE) {
    // Month, NOT the amount: a part payment must not mint a new key and send a
    // second chase in the same month.
    return `${cohort}:${id}:${isoMonth(now)}`;
  }
  // Both date cohorts key on the membership's own end date, so a renewal mints
  // a fresh key with no expiry logic anywhere.
  return `${cohort}:${id}:${isoDate(member?.endDate)}`;
};

/**
 * Is live sending switched on? Read at CALL TIME, never captured at module
 * scope — ESM imports are evaluated before server.js runs dotenv.config(), so a
 * value captured at import is reliably the wrong one (the same trap
 * memberSecret() documents in memberAuth.controller.js).
 *
 * @returns {boolean}
 */
export const isLiveSendingEnabled = () =>
  String(process.env.REMINDERS_LIVE ?? "").trim() === "true";

const numberFromEnv = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

// ===================================================================
// Message content — channel-agnostic in shape, see EMAIL_CHANNEL below.
// ===================================================================

/**
 * Builds what to say. Returns `{ subject, text, html }`; a channel takes the
 * parts it can use (an SMS channel would send `text` and ignore the rest),
 * which is the whole reason the content is built here and not inside the
 * sender.
 *
 * TONE: these go to people who are still customers. Nothing here dead-ends —
 * every message names the action and where to take it, the same rule
 * services/attendanceEligibility.js applies to a DENY verdict.
 *
 * @param {string} cohort
 * @param {object} member
 * @param {Date} now
 * @returns {{subject: string, text: string, html: string}}
 */
export const buildReminderMessage = (cohort, member, now = new Date()) => {
  const name = member?.fullName || "there";
  const days = daysToExpiry(member, now);
  const ends = member?.endDate ? isoDate(member.endDate) : "";
  const branch = member?.branch ? ` at ${member.branch}` : "";

  if (cohort === MEMBER_COHORTS.EXPIRING_SOON) {
    const when =
      days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    const subject = `Your Mid City Gym membership ends ${when}`;
    const body =
      `Hi ${name},\n\n` +
      `Your membership${branch} ends ${when}${ends ? ` (${ends})` : ""}.\n\n` +
      `Drop in at reception to renew — it takes a minute and your training ` +
      `carries on without a break.\n\n` +
      `See you at the gym,\nMid City Gym`;
    return { subject, text: body, html: htmlWrap(subject, body) };
  }

  if (cohort === MEMBER_COHORTS.EXPIRED) {
    const subject = "Your Mid City Gym membership has ended";
    const body =
      `Hi ${name},\n\n` +
      `Your membership${branch} ended${ends ? ` on ${ends}` : ""}.\n\n` +
      `We would like to have you back. Speak to reception and they will get ` +
      `you set up again — your workout plan and history are all still here.\n\n` +
      `Mid City Gym`;
    return { subject, text: body, html: htmlWrap(subject, body) };
  }

  if (cohort === MEMBER_COHORTS.PAYMENT_DUE) {
    /**
     * The amount comes from memberBalance(), which reads Member.payments[] —
     * the CURRENT-PERIOD balance, and the correct source for this one question.
     * It is the identical number the admin dashboard shows, which is the point:
     * a member who rings up about this email must hear the same figure from the
     * person who answers. Nothing here is a revenue total; see the money note
     * in services/memberCohorts.js.
     */
    const balance = memberBalance(member);
    const subject = "A pending balance on your Mid City Gym membership";
    const body =
      `Hi ${name},\n\n` +
      `There is a pending balance of ₹${balance.toLocaleString("en-IN")} on ` +
      `your membership${branch}.\n\n` +
      `Please settle it at reception on your next visit. If you have already ` +
      `paid, ignore this — and do let reception know so we can correct our ` +
      `records.\n\n` +
      `Mid City Gym`;
    return { subject, text: body, html: htmlWrap(subject, body) };
  }

  throw new Error(`No reminder message defined for cohort '${cohort}'`);
};

/** Minimal, inline-styled HTML. No images, no tracking, no external CSS. */
const htmlWrap = (subject, text) =>
  `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#222;">` +
  `<h2 style="font-size:18px;margin:0 0 12px;">${esc(subject)}</h2>` +
  text
    .split("\n\n")
    .map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("") +
  `</div>`;

// ===================================================================
// Channels
// ===================================================================

/**
 * The email channel — the only implemented one.
 *
 * `addressOf` returning null is NORMAL, not an error: `Member.email` is
 * optional and frequently blank (mobile is the required contact field). Those
 * members are counted as `skippedNoAddress` and reported, because "we have no
 * way to reach 40% of the expiring cohort" is a business fact the owner should
 * see rather than a silent zero.
 */
export const EMAIL_CHANNEL = {
  name: "EMAIL",
  addressOf: (member) => {
    const email = typeof member?.email === "string" ? member.email.trim() : "";
    return email || null;
  },
  send: async ({ to, subject, text, html }) =>
    sendMail({ to, subject, text, html, fromName: "Mid City Gym" }),
};

/** Channels by name, so a caller can pick one without importing it. */
export const CHANNELS = { EMAIL: EMAIL_CHANNEL };

/** Human label per cohort, for the digest. */
const COHORT_LABEL = {
  EXPIRING_SOON: "Expiring within 7 days",
  EXPIRED: "Already expired",
  PAYMENT_DUE: "Payment outstanding",
};

const asDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

/**
 * Emails the front desk the members this run could not reach.
 *
 * WHY: `Member.email` is optional and mobile is the required field, so today
 * essentially every member lands in `unreachable`. Without this the scheduler
 * computes three correct cohorts every morning and then does nothing with
 * them — a feature that runs, passes its tests, and reaches nobody.
 *
 * The gym HAS these people's phone numbers. So the work goes to the front desk
 * as a call list instead of vanishing. This is not a substitute for messaging
 * the member directly; it is what can be delivered with the contact details
 * that actually exist. As members gain addresses they drop out of this list on
 * their own and get mailed directly, with no change here.
 *
 * One email per run, to the gym, so it costs nothing against the daily cap
 * that protects OTP login.
 *
 * Never throws: the digest is the last thing a run does, and a dead SMTP
 * server must not turn a successful reminder run into a failed one.
 */
export const sendOwnerDigest = async (report, options = {}) => {
  const rows = report.unreachable || [];
  if (!rows.length) return { sent: false, reason: "nobody to report" };

  const to =
    options.to || process.env.LEAD_NOTIFY_TO || (await getMailFromAddress());
  if (!to) return { sent: false, reason: "no recipient configured" };

  const byCohort = new Map();
  for (const r of rows) {
    if (!byCohort.has(r.cohort)) byCohort.set(r.cohort, []);
    byCohort.get(r.cohort).push(r);
  }

  const lines = [];
  const htmlParts = [];
  for (const [cohort, list] of byCohort) {
    const label = COHORT_LABEL[cohort] || cohort;
    lines.push(`${label} (${list.length})`);
    htmlParts.push(`<h3 style="margin:18px 0 6px">${label} (${list.length})</h3><ul>`);
    for (const m of list) {
      const bits = [m.name, m.phone, m.branch || "no branch"];
      if (cohort === "PAYMENT_DUE" && m.balance) bits.push(`owes ${m.balance}`);
      else bits.push(`ends ${asDate(m.endDate)}`);
      lines.push(`  • ${bits.join(" — ")}`);
      htmlParts.push(`<li>${bits.join(" — ")}</li>`);
    }
    htmlParts.push("</ul>");
  }

  const capped = report.totals.skippedNoAddress > rows.length;
  if (capped) {
    const more = report.totals.skippedNoAddress - rows.length;
    lines.push("", `…and ${more} more. Export the member list for the full set.`);
    htmlParts.push(`<p>…and ${more} more. Export the member list for the full set.</p>`);
  }

  const intro =
    "These members are due a reminder and have no email address on file, so " +
    "nobody could be emailed. Their phone numbers are below.";

  try {
    await EMAIL_CHANNEL.send({
      to,
      subject: `Mid City Gym — ${rows.length} member${rows.length === 1 ? "" : "s"} to call`,
      text: [intro, "", ...lines].join("\n"),
      html: `<p>${intro}</p>${htmlParts.join("")}`,
    });
    return { sent: true, to, count: rows.length };
  } catch (error) {
    (options.logger || console).warn(`[reminders] owner digest failed: ${error?.message || error}`);
    return { sent: false, reason: error?.message || "send failed" };
  }
};

// ===================================================================
// The run
// ===================================================================

/**
 * Claims one send by INSERTING the log row, and reports whether the claim was
 * ours to make.
 *
 * A duplicate key (11000) is the expected, non-exceptional outcome: it means
 * this member has already been contacted for this reason in this period. It is
 * not logged as an error.
 *
 * @returns {Promise<{claimed: boolean, row?: object}>}
 */
const claimSend = async (ReminderLog, doc) => {
  try {
    const row = await ReminderLog.create(doc);
    return { claimed: true, row };
  } catch (error) {
    if (error?.code === 11000) return { claimed: false };
    throw error;
  }
};

/**
 * Releases a claim after the send failed, WITHOUT losing the evidence.
 *
 * The row stays (so "why did this bounce" is answerable) but its dedupeKey is
 * suffixed, which takes it out of the unique constraint and lets the next run
 * try this member again. Deleting the row would also work and would lose the
 * reason; leaving the key intact would mean one SMTP hiccup permanently
 * silences that member for that period.
 *
 * Best-effort: if this update itself fails there is nothing further to do, and
 * failing the whole run over it would strand the members still queued behind.
 */
const releaseClaim = async (ReminderLog, row, error, log = console) => {
  try {
    await ReminderLog.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "FAILED",
          error: String(error?.message || error).slice(0, 500),
          dedupeKey: `${row.dedupeKey}#failed:${Date.now()}`,
        },
      },
    );
  } catch (releaseError) {
    log.error(
      `❌ [reminders] could not release a failed claim (${row?._id}):`,
      releaseError?.message || releaseError,
    );
  }
};

/**
 * Runs one reminder pass.
 *
 * @param {object} [options]
 * @param {Date}     [options.now]        injected so a test can pin the date.
 * @param {boolean}  [options.dryRun]     defaults to `!isLiveSendingEnabled()`.
 *   A caller may force TRUE (to preview) but a `false` here still cannot send
 *   unless REMINDERS_LIVE says so — see the `&&` in the resolution below. A
 *   request must never be able to switch sending ON.
 * @param {string[]} [options.cohorts]    subset of MEMBER_COHORT_LIST.
 * @param {object}   [options.scope]      a branch filter fragment, spread LAST
 *   over the cohort filter. `{}` means every branch, which is what the cron
 *   wants — it has no session and therefore no branch.
 * @param {object}   [options.channel]    defaults to EMAIL_CHANNEL.
 * @param {object}   [options.deps]       { Member, ReminderLog } — injected so
 *   scripts/tests/reminders.test.mjs can run offline against fakes.
 * @param {object}   [options.logger]     anything with log/warn/error, default
 *   `console`. Injected for the same reason the models are: the dry-run
 *   recipient list is a PRODUCT of this function, not a side effect of it, so a
 *   test should be able to assert on the lines rather than scrape stdout. (It
 *   also keeps `node --test`'s stdout-based IPC out of the way of a few hundred
 *   log lines, which it does not survive.)
 * @returns {Promise<object>} a report: per-cohort counts and the recipient list.
 */
export const runReminders = async (options = {}) => {
  const now = options.now instanceof Date ? options.now : new Date();
  const channel = options.channel || EMAIL_CHANNEL;
  const Member = options.deps?.Member || MemberModel;
  const ReminderLog = options.deps?.ReminderLog || ReminderLogModel;
  const log = options.logger || console;

  // Live sending requires BOTH the environment switch and the absence of a
  // caller-forced dry run. `dryRun: false` from a request is not authority.
  const liveAllowed = options.liveAllowed ?? isLiveSendingEnabled();
  const dryRun = options.dryRun === true ? true : !liveAllowed;

  const cohorts = Array.isArray(options.cohorts) && options.cohorts.length
    ? options.cohorts.filter((c) => MEMBER_COHORT_LIST.includes(c))
    : MEMBER_COHORT_LIST;

  const scope = options.scope && typeof options.scope === "object" ? options.scope : {};

  const dailyCap = options.dailyCap ?? numberFromEnv("REMINDER_DAILY_CAP", DEFAULT_DAILY_CAP);
  const batchMax = options.batchMax ?? numberFromEnv("REMINDER_BATCH_MAX", DEFAULT_BATCH_MAX);
  const maxRunMs = options.maxRunMs ?? numberFromEnv("REMINDER_MAX_RUN_MS", DEFAULT_MAX_RUN_MS);
  const sendGapMs = options.sendGapMs ?? DEFAULT_SEND_GAP_MS;

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt >= maxRunMs;

  /**
   * How much of today's budget is left.
   *
   * Counted from ReminderLog rather than tracked in memory because a serverless
   * invocation has no memory of the last one, and a manual run on top of the
   * scheduled one would otherwise get a full budget of its own.
   *
   * In a dry run this is skipped: nothing will be sent, so nothing is spent,
   * and a preview must never be limited by a cap it is not consuming.
   */
  let remainingBudget = Number.POSITIVE_INFINITY;
  if (!dryRun) {
    const sentToday = await ReminderLog.countDocuments({
      channel: channel.name,
      status: "SENT",
      sentAt: { $gte: startOfToday(now) },
    });
    remainingBudget = Math.max(0, dailyCap - sentToday);
  }

  const report = {
    dryRun,
    channel: channel.name,
    startedAt: new Date(startedAt).toISOString(),
    cohorts: {},
    totals: {
      considered: 0,
      wouldSend: 0,
      sent: 0,
      failed: 0,
      skippedAlreadySent: 0,
      skippedNoAddress: 0,
      skippedCapped: 0,
      skippedOutOfTime: 0,
    },
    /** The inspectable list — WHO, and why. Truncated so a report stays readable. */
    recipients: [],
    /**
     * The members this run could not reach, kept rather than counted.
     *
     * WHY THIS EXISTS: `Member.email` is optional and `mobileNumber` is
     * required — members sign in with a mobile number, not an address — so in
     * practice almost nobody has one. Counting them as `skippedNoAddress` and
     * discarding them turned the whole feature into a no-op: the cohorts were
     * computed correctly and then thrown away.
     *
     * They are a call list. The gym has their phone number; it just cannot
     * email them. `sendOwnerDigest` posts this to the front desk once per run,
     * so the work still reaches somebody who can act on it. When members do
     * have addresses they simply stop appearing here and get mailed directly.
     */
    unreachable: [],
    stoppedEarly: false,
  };

  for (const cohort of cohorts) {
    const counts = {
      considered: 0,
      wouldSend: 0,
      sent: 0,
      failed: 0,
      skippedAlreadySent: 0,
      skippedNoAddress: 0,
      skippedCapped: 0,
      skippedOutOfTime: 0,
    };
    report.cohorts[cohort] = counts;

    // scope is spread LAST so it overrides anything the cohort filter set —
    // the same rule scopeFilter() carries in middlewares/branchScope.js.
    const filter = { ...cohortFilter(cohort, now), ...scope };

    // NOT .lean(): memberBalance() prefers the `balanceAmount` virtual, and
    // PAYMENT_DUE is decided by it. A lean read would fall back to recomputing
    // from payments[] — which works, but only because that fallback exists.
    const members = await Member.find(filter)
      .sort({ endDate: 1 })
      .limit(COHORT_FETCH_LIMIT);

    for (const member of members) {
      // PAYMENT_DUE cannot be expressed as a query (the balance is a virtual),
      // so the cohort is CONFIRMED here. For the date cohorts this is a cheap
      // double-check of a filter that was already applied.
      if (!isInCohort(cohort, member, now)) continue;

      counts.considered += 1;
      report.totals.considered += 1;

      const to = channel.addressOf(member);
      if (!to) {
        counts.skippedNoAddress += 1;
        report.totals.skippedNoAddress += 1;
        // Kept, not just counted — this is the call list. See report.unreachable.
        if (report.unreachable.length < UNREACHABLE_CAP) {
          report.unreachable.push({
            cohort,
            name: member.fullName || "(no name)",
            phone: member.mobileNumber || "",
            branch: member.branch || "",
            endDate: member.endDate || null,
            balance: memberBalance(member),
          });
        }
        continue;
      }

      const dedupeKey = dedupeKeyFor(cohort, member, now);

      if (dryRun) {
        // ===================================================================
        // THE DRY-RUN BRANCH RETURNS BEFORE THE CLAIM. Nothing is written.
        // ===================================================================
        counts.wouldSend += 1;
        report.totals.wouldSend += 1;
        if (report.recipients.length < 500) {
          report.recipients.push({
            cohort,
            memberId: String(member._id),
            name: member.fullName,
            branch: member.branch,
            to,
            endDate: member.endDate,
            daysToExpiry: daysToExpiry(member, now),
            balance: cohort === MEMBER_COHORTS.PAYMENT_DUE ? memberBalance(member) : undefined,
            dedupeKey,
            action: "WOULD_SEND",
          });
        }
        continue;
      }

      if (remainingBudget <= 0) {
        counts.skippedCapped += 1;
        report.totals.skippedCapped += 1;
        report.stoppedEarly = true;
        continue;
      }
      // batchMax is a whole-RUN ceiling, not a per-cohort one — the time budget
      // it stands in for is shared across every cohort in the invocation.
      if (report.totals.sent >= batchMax || outOfTime()) {
        counts.skippedOutOfTime += 1;
        report.totals.skippedOutOfTime += 1;
        report.stoppedEarly = true;
        continue;
      }

      const claim = await claimSend(ReminderLog, {
        subjectType: "MEMBER",
        member: member._id,
        cohort,
        channel: channel.name,
        dedupeKey,
        to,
        status: "SENT",
        sentAt: new Date(),
      });

      if (!claim.claimed) {
        // Already contacted for this reason in this period. The normal path for
        // every day after the first — not an error, not logged per member.
        counts.skippedAlreadySent += 1;
        report.totals.skippedAlreadySent += 1;
        continue;
      }

      try {
        const message = buildReminderMessage(cohort, member, now);
        const result = await channel.send({ to, ...message });
        if (result?.messageId) {
          await ReminderLog.updateOne(
            { _id: claim.row._id },
            { $set: { messageId: String(result.messageId).slice(0, 200) } },
          );
        }
        counts.sent += 1;
        report.totals.sent += 1;
        remainingBudget -= 1;
        if (report.recipients.length < 500) {
          report.recipients.push({
            cohort,
            memberId: String(member._id),
            name: member.fullName,
            branch: member.branch,
            to,
            action: "SENT",
          });
        }
      } catch (error) {
        await releaseClaim(ReminderLog, claim.row, error, log);
        counts.failed += 1;
        report.totals.failed += 1;
        log.error(
          `❌ [reminders] ${cohort} send failed for member ${member._id}:`,
          error?.message || error,
        );
      }

      await sleep(sendGapMs);
    }
  }

  /**
   * The call list goes to the front desk — but never from a dry run.
   *
   * A dry run must send NOTHING, and that has to include this. Sending the
   * owner a digest from a preview would make "dry run" mean "sends one email",
   * which is exactly the kind of exception that makes a safety switch
   * untrustworthy.
   */
  //
  // Injectable for the same reason `channel` is: the digest resolves its
  // recipient from the EmailSetup row in Mongo, and the offline suites have no
  // database. Pass `false` to skip it, or a function to observe it.
  const digest =
    options.ownerDigest === undefined ? sendOwnerDigest : options.ownerDigest;
  if (!dryRun && digest && report.unreachable.length) {
    report.ownerDigest = await digest(report, { logger: log });
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;

  // One line per run in the platform log, so the dry-run list is inspectable
  // without calling the endpoint by hand.
  log.log(
    `${dryRun ? "🧪" : "✉️"} [reminders] ${dryRun ? "DRY RUN — nothing sent" : "LIVE"} ` +
      `considered=${report.totals.considered} ` +
      `${dryRun ? `wouldSend=${report.totals.wouldSend}` : `sent=${report.totals.sent} failed=${report.totals.failed}`} ` +
      `alreadySent=${report.totals.skippedAlreadySent} ` +
      `noAddress=${report.totals.skippedNoAddress} ` +
      `capped=${report.totals.skippedCapped} ` +
      `outOfTime=${report.totals.skippedOutOfTime} ` +
      `in ${report.durationMs}ms`,
  );

  if (dryRun) {
    for (const r of report.recipients) {
      log.log(
        `   would email ${r.to} — ${r.cohort} — ${r.name} (${r.branch || "no branch"})`,
      );
    }
    log.log(
      "   Set REMINDERS_LIVE=true in the environment to actually send. " +
        "Nothing was written to ReminderLog.",
    );
  }

  return report;
};

export default { runReminders, buildReminderMessage, dedupeKeyFor, isLiveSendingEnabled, CHANNELS };
