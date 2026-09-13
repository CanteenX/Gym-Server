import express from "express";
import {
  requireCronSecret,
  runRemindersJob,
  getJobsStatus,
} from "../../controllers/v1/jobs.controller.js";

const router = express.Router();

/**
 * Scheduled jobs — invoked by Vercel Cron, not by a person and not by a browser.
 *
 * ============================================================================
 * AUTHENTICATION IS A SHARED SECRET, NOT A SESSION AND NOT A JWT.
 * ============================================================================
 * A cron invocation has no staff session cookie and no member token. Giving it
 * either would mean minting a long-lived credential that lives in an
 * environment variable and can do everything that credential can do; a shared
 * secret that authorises exactly these two endpoints is the smaller thing to
 * leak. See controllers/v1/jobs.controller.js for the env var name
 * (`CRON_SECRET`), why that name, and why an unset value fails CLOSED.
 *
 * checkPermission is NOT applied and there is no MenuMaster row: there is no
 * admin screen here. checkPermission reads req.session.user, which a cron does
 * not have, so it would 401 every invocation.
 *
 * ============================================================================
 * WHY THE REMINDER JOB IS REGISTERED ON BOTH POST AND GET
 * ============================================================================
 * plan.md Phase 5 and the admin runbook both name it `POST /api/v1/jobs/reminders`,
 * and POST is the honest verb — the run sends email and writes ReminderLog rows,
 * so it is not a safe method. But **Vercel Cron invokes a path with a GET**: a
 * `crons` entry in vercel.json takes a path and a schedule and there is nowhere
 * to specify a method. Registering only POST would mean the scheduled run 404s
 * every morning with nothing to notice except an absence of email.
 *
 * So both are registered, pointing at the same handler. They are not a
 * duplicate route (different methods) and neither shadows the other. The GET is
 * not idempotent, which is the compromise being made knowingly: it is
 * unreachable without the secret, and ReminderLog's unique index means a second
 * invocation on the same day contacts nobody twice regardless of method.
 */
router.post("/jobs/reminders", requireCronSecret, runRemindersJob);
router.get("/jobs/reminders", requireCronSecret, runRemindersJob);

/**
 * @swagger
 * /jobs/status:
 *   get:
 *     summary: Is the reminder job armed, and with what limits?
 *     tags: [Jobs]
 *     responses:
 *       200: { description: "{ reminders: { live, mode, switch, dailyCap, ... } }" }
 *       401: { description: Missing or wrong cron secret }
 *       503: { description: CRON_SECRET is not configured on this deployment }
 */
/**
 * Behind the same secret. Read-only, but it reports whether a deployment will
 * send real email — which is exactly the fact an attacker probing the endpoint
 * would like confirmed, and exactly the fact an operator most often gets wrong.
 */
router.get("/jobs/status", requireCronSecret, getJobsStatus);

export default router;
