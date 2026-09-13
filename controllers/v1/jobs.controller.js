import crypto from "node:crypto";
import {
  runReminders,
  isLiveSendingEnabled,
} from "../../services/reminderScheduler.js";
import { MEMBER_COHORT_LIST } from "../../services/memberCohorts.js";

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ isOk: false, status, message, ...extra });

/**
 * ============================================================================
 * THE CRON SECRET. ENV VAR NAME: `CRON_SECRET`.
 * ============================================================================
 * `CRON_SECRET` is Vercel's own convention, not one invented here, and that is
 * why it was chosen: when a project has an environment variable of that exact
 * name, Vercel's cron scheduler automatically sends
 * `Authorization: Bearer <CRON_SECRET>` on every invocation. Picking any other
 * name would mean the header had to be configured by hand somewhere it cannot
 * be — vercel.json's `crons` entries take a path and a schedule and nothing else.
 *
 * The header `x-cron-secret` is also accepted, for invoking the job by hand
 * (`curl -H "x-cron-secret: …"`) without minting a Bearer token.
 *
 * NO VALUE IS INVENTED OR DEFAULTED HERE. Generate one and set it on the
 * project:  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 *
 * FAILS CLOSED. An unset `CRON_SECRET` is a 503, not an open endpoint. The
 * alternative — "no secret configured, so allow" — is how an endpoint that
 * sends mail to the entire member base ends up reachable by anybody who guesses
 * the path, and it would fail open exactly in the environment where the
 * variable was forgotten. This is the same fail-closed rule REVALIDATE_SECRET
 * follows in services/siteRevalidate.js.
 */
const CRON_SECRET_ENV = "CRON_SECRET";

/**
 * Constant-time string comparison that does not leak the secret's length.
 *
 * `a === b` on a secret returns as soon as two bytes differ, which is a timing
 * oracle — measurable across enough requests. `timingSafeEqual` throws when the
 * buffers differ in length, which would itself leak the length, so both sides
 * are hashed to a fixed 32 bytes first and the digests are compared.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const secretsMatch = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

/**
 * Guard for every route under /jobs/*.
 *
 * This is NOT authMiddleware and NOT requireMember: a cron invocation has no
 * staff session and no member token, and giving it either would mean minting a
 * credential that lives in an environment variable and can do everything that
 * credential can do. A shared secret that authorises exactly one endpoint is
 * the smaller thing to leak.
 */
export const requireCronSecret = (req, res, next) => {
  // Read at call time, never captured at module scope: ESM imports evaluate
  // before server.js runs dotenv.config(), so a value captured at import time
  // is reliably the empty string (see memberSecret() in memberAuth.controller.js).
  const expected = process.env[CRON_SECRET_ENV];

  if (!expected) {
    console.error(
      `❌ [jobs] ${CRON_SECRET_ENV} is not set — refusing every job invocation`,
    );
    return fail(
      res,
      503,
      "Scheduled jobs are not configured on this deployment.",
    );
  }

  const header = req.headers?.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const custom = String(req.headers?.["x-cron-secret"] || "").trim();

  if (secretsMatch(bearer, expected) || secretsMatch(custom, expected)) {
    return next();
  }

  // Deliberately terse and deliberately 401, with nothing about which header
  // was tried or how close it was.
  console.warn(`[SECURITY] Rejected job invocation from ${req.ip} for ${req.path}`);
  return fail(res, 401, "Unauthorized");
};

/**
 * The reminder cron.
 *
 * POST /api/v1/jobs/reminders   (and GET — see routes/v1/jobs.routes.js for why)
 *
 * ============================================================================
 * IT IS A DRY RUN UNLESS `REMINDERS_LIVE=true` IS SET ON THE DEPLOYMENT.
 * ============================================================================
 * A dry run resolves the cohorts, logs and returns exactly who WOULD be mailed,
 * sends nothing, and writes nothing to ReminderLog. That last part is what makes
 * it safe to run repeatedly while the list is being inspected — see the header
 * of services/reminderScheduler.js.
 *
 * `?dryRun=true` FORCES a dry run even on a live deployment, so the list can be
 * previewed at any time. There is deliberately NO parameter that forces the
 * opposite: a request must never be able to switch sending on. That decision
 * belongs to whoever can set an environment variable.
 *
 * NOT BRANCH-SCOPED, and it must not be: there is no session behind a cron, so
 * `scopedBranch(req)` would read undefined and the "unrestricted" answer would
 * be right by accident rather than by design. It is stated explicitly instead —
 * the job mails every branch's members, because there is one gym with two
 * floors and nobody's membership expires more than once.
 */
export const runRemindersJob = async (req, res) => {
  const startedAt = Date.now();
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };

    // Only "true" forces a preview; anything else leaves the environment in
    // charge. Note the asymmetry: this can only ever make the run SAFER.
    const forcedDryRun = String(params.dryRun ?? "").trim() === "true";

    const requestedCohorts =
      typeof params.cohorts === "string"
        ? params.cohorts.split(",").map((c) => c.trim().toUpperCase())
        : Array.isArray(params.cohorts)
          ? params.cohorts.map((c) => String(c).trim().toUpperCase())
          : null;

    const cohorts = requestedCohorts
      ? requestedCohorts.filter((c) => MEMBER_COHORT_LIST.includes(c))
      : MEMBER_COHORT_LIST;

    if (requestedCohorts && cohorts.length === 0) {
      return fail(
        res,
        400,
        `cohorts must name at least one of: ${MEMBER_COHORT_LIST.join(", ")}`,
      );
    }

    const report = await runReminders({
      cohorts,
      dryRun: forcedDryRun || undefined,
      scope: {}, // every branch — see the header.
    });

    return ok(
      res,
      200,
      report.dryRun
        ? `Dry run — ${report.totals.wouldSend} member(s) would be emailed. Nothing was sent and nothing was logged. Set REMINDERS_LIVE=true to send.`
        : `Sent ${report.totals.sent} reminder(s).`,
      report,
    );
  } catch (error) {
    console.error("❌ [jobs] reminder run failed:", error);
    return fail(res, 500, "Reminder run failed", {
      durationMs: Date.now() - startedAt,
      // The message, not the stack. sanitizeErrors would strip a stack anyway.
      detail: error?.message || String(error),
    });
  }
};

/**
 * A read-only answer to "is this thing armed?", behind the same secret.
 *
 * Exists because the single most likely operational mistake with this feature is
 * believing it is live when it is not (or the reverse), and the only way to tell
 * otherwise is to trigger a run and read the logs.
 *
 * GET /api/v1/jobs/status
 */
export const getJobsStatus = (_req, res) =>
  ok(res, 200, "Jobs status", {
    reminders: {
      live: isLiveSendingEnabled(),
      mode: isLiveSendingEnabled() ? "LIVE — emails are sent" : "DRY RUN — nothing is sent",
      switch: "REMINDERS_LIVE",
      cohorts: MEMBER_COHORT_LIST,
      dailyCap: Number(process.env.REMINDER_DAILY_CAP) || 400,
      batchMax: Number(process.env.REMINDER_BATCH_MAX) || 60,
    },
    now: new Date().toISOString(),
  });
