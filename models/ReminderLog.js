import mongoose from "mongoose";
import { MEMBER_COHORT_LIST } from "../services/memberCohorts.js";

/**
 * Channels a reminder could go out on.
 *
 * ONLY "EMAIL" IS IMPLEMENTED, and per plan.md §1 no SMS or WhatsApp provider
 * is to be added. The enum is wider than the implementation on purpose: the
 * dedupe key is scoped BY CHANNEL (see the index at the bottom), so adding a
 * channel later is a new sender function and nothing else — no migration, and
 * no risk that switching a channel on silently suppresses the email because
 * "this member was already contacted". A one-value enum would have had to be
 * widened at exactly the moment that mistake is easiest to make.
 */
export const REMINDER_CHANNELS = ["EMAIL", "SMS", "WHATSAPP"];

export const REMINDER_STATUSES = ["SENT", "FAILED"];

/**
 * One record of "this person was contacted about this, on this channel, for
 * this period" — the thing that stops the cron mailing somebody every morning
 * for the seven days their membership is expiring.
 *
 * ============================================================================
 * THE DEDUPE IS THE UNIQUE INDEX, NOT A findOne
 * ============================================================================
 * The scheduler CLAIMS a send by inserting this row BEFORE the mail is
 * attempted, and treats a duplicate-key error as "somebody already did this".
 * Checking with `findOne` first and inserting after would be a read-then-write
 * with the same race as the booking capacity check — two overlapping cron runs
 * (a retry, a manual invocation on top of the scheduled one) would both read
 * "not contacted" and both send. The index is evaluated by the server at write
 * time and cannot be raced.
 *
 * WHAT "THE SAME PERIOD" MEANS, PER COHORT — this is the whole design:
 *
 *   EXPIRING_SOON   keyed by the member's own endDate.
 *                   "Your membership ends on 2026-09-20" is one fact about one
 *                   membership period, so it is sent ONCE for that period, not
 *                   once a day for the seven days it is true. Renewing moves
 *                   endDate, which mints a fresh key — so the next period gets
 *                   its own reminder with no expiry logic anywhere.
 *
 *   EXPIRED         keyed by endDate as well, and for the same reason: one
 *                   "your membership has lapsed" per lapse. A member who lets
 *                   two separate memberships lapse is contacted twice, which is
 *                   correct.
 *
 *   PAYMENT_DUE     keyed by CALENDAR MONTH, because an unpaid balance has no
 *                   natural period of its own — it is simply true until it is
 *                   not. Monthly is the rate a person would call it a reminder
 *                   rather than nagging. It deliberately does NOT include the
 *                   amount: a partial payment must not mint a new key and
 *                   trigger a second email in the same month.
 *
 * ============================================================================
 * NOTHING IS WRITTEN HERE IN DRY-RUN MODE
 * ============================================================================
 * A dry run that claimed rows would poison the first live run — every member it
 * "would have" mailed would then be skipped as already contacted, and the
 * feature would ship having sent nothing to anybody, looking like it worked.
 * See services/reminderScheduler.js.
 */
const ReminderLogSchema = new mongoose.Schema(
  {
    /**
     * Only members are reminded today. Trainers have no membership to expire
     * and no balance; leads are chased by a person, not a cron.
     */
    subjectType: {
      type: String,
      enum: ["MEMBER"],
      default: "MEMBER",
    },

    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      required: true,
    },

    /** Which cohort triggered it — the "reason" half of "not twice for the same reason". */
    cohort: {
      type: String,
      enum: MEMBER_COHORT_LIST,
      required: true,
    },

    channel: {
      type: String,
      enum: REMINDER_CHANNELS,
      default: "EMAIL",
      required: true,
    },

    /**
     * The uniqueness token. Built by services/reminderScheduler.js — never by a
     * caller, and never parsed by one. See the header for its shape per cohort.
     */
    dedupeKey: { type: String, required: true, trim: true },

    /**
     * The address (or, one day, number) actually contacted.
     *
     * Stored so "why did this member not get it" is answerable — the usual
     * answer being that Member.email was blank, which is COMMON here: email is
     * optional on Member and mobile is the required field (see models/Lead.js
     * for the same observation about Vadodara gym enquiries).
     */
    to: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: REMINDER_STATUSES,
      default: "SENT",
      required: true,
    },

    /** SMTP message id, when the provider returned one. For tracing a bounce. */
    messageId: { type: String, trim: true, default: "" },

    /**
     * Why it failed. Present only on FAILED rows.
     *
     * A FAILED row has its dedupeKey SUFFIXED by the scheduler so that it no
     * longer blocks the constraint — the member was not actually contacted, so
     * the next run must be allowed to try again. The row survives as evidence;
     * it just stops being a claim. That is the one place the key is not purely
     * derived from the cohort, and it is the reason nothing should ever parse it.
     */
    error: { type: String, trim: true, default: "" },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/**
 * THE CONSTRAINT. Per channel, because an email and a (hypothetical) SMS about
 * the same expiry are two different contacts, not a duplicate.
 */
ReminderLogSchema.index(
  { channel: 1, dedupeKey: 1 },
  { unique: true, name: "uniq_channel_dedupeKey" },
);

/** "What has this member been sent" — the support question. */
ReminderLogSchema.index({ member: 1, sentAt: -1 });

/**
 * The daily-cap count: how many were SENT today, on this channel.
 *
 * Gmail's ceiling is roughly 500 recipients a day across the WHOLE account —
 * which this shares with OTP mail and lead notifications — so the cap has to be
 * measured, not assumed. See REMINDER_DAILY_CAP in services/reminderScheduler.js.
 */
ReminderLogSchema.index({ channel: 1, status: 1, sentAt: -1 });

export default mongoose.model("ReminderLog", ReminderLogSchema);
