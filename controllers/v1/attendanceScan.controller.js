import Attendance from "../../models/Attendance.js";
import Member from "../../models/Member.js";
import Trainer from "../../models/Trainer.js";
import Branch from "../../models/Branch.js";
import {
  evaluateEligibility,
  VERDICT,
} from "../../services/attendanceEligibility.js";
import { scopedBranch } from "../../middlewares/branchScope.js";

/**
 * QR check-in (plan.md D2, D2b, D3, D4).
 *
 * ============================================================================
 * WHAT THIS IS NOT: PROOF OF ATTENDANCE.
 * ============================================================================
 * The QR is a printed sticker on a wall. Nobody stands at the door. A sticker
 * can be photographed once and the link used from a sofa forever, and the
 * portal's own check-in button needs no QR at all. A row here therefore records
 * that somebody pressed something, not that they were in the building — and a
 * DENY informs and flags, it cannot refuse entry. A rotating token, a kiosk
 * page and a geofence were all explicitly declined in D2; do not add one here
 * without reopening that decision.
 *
 * What the sticker DOES buy, and the only reasons this endpoint exists:
 *   1. BRANCH ATTRIBUTION. The QR carries its branch, so the visit is credited
 *      to Vasna or Gotri without the member choosing — which is the single
 *      thing that makes per-branch footfall mean anything.
 *   2. AN EXPLICIT VERDICT. The existing button evaluates nothing, so an
 *      expired member can start a session and hear about it at the desk a week
 *      later. This path says so on their screen, and records the refusal.
 *
 * THE SUBJECT ALWAYS COMES FROM THE VERIFIED TOKEN, NEVER FROM THE BODY.
 * req.portalUser is set by requirePortalUser from a signed JWT claim. The body
 * supplies only the branch, which is attribution rather than authorisation —
 * and even that is validated against the Branch master below, so a hand-edited
 * request cannot invent a branch name and fragment the footfall grouping.
 */

/** Midnight local — Attendance.date is stored normalised the same way. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Defaults to 90 for records written before sessionMinutes existed. */
const MEMBER_DEFAULT_MINUTES = 90;

/**
 * How long a trainer's shift runs before an unclosed row is reconstructed.
 *
 * Trainers have no `sessionMinutes` — that field is a member's own preference,
 * capped at 120 because a workout is not a working day. A shift is, so it gets
 * its own, much longer constant. Without one, a trainer who forgets to tap out
 * would have their day rewritten as a 90-minute session.
 */
const TRAINER_SHIFT_MINUTES = 480;

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/**
 * Close this subject's own open sessions that have outrun their expected
 * length, exactly as the button path does (attendance.controller.js).
 *
 * The close time is checkInAt + expected, never "now": the person left roughly
 * when they said they would, they just never tapped out. Stamping "now" would
 * credit a forgotten tab as a six-hour workout.
 *
 * Scoped to this one subject's rows and to their own subjectType, so a sweep
 * triggered by a trainer can never touch a member's row and vice versa.
 */
const autoCloseStale = async (subjectFilter, minutes) => {
  const open = await Attendance.find({ ...subjectFilter, checkOutAt: null });
  if (!open.length) return;

  const now = Date.now();
  await Promise.all(
    open.map((session) => {
      const expected = new Date(
        new Date(session.checkInAt).getTime() + minutes * 60000,
      );
      if (expected.getTime() > now) return null; // still legitimately inside
      session.checkOutAt = expected;
      session.autoClosed = true;
      return session.save();
    }),
  );
};

/**
 * The branch this scan should be attributed to.
 *
 * Priority: the branch the QR carried, if it names a REAL PHYSICAL branch;
 * otherwise the subject's own home branch. Never a free string from the client.
 *
 * Why validate at all, when this is attribution and not security: Attendance.
 * branch is a denormalised STRING, deliberately frozen at write time so a
 * member transferring branches does not rewrite last March's footfall. A typo
 * or an invented name written into it is therefore permanent, and it would
 * appear as a third branch in every group-by from then on. Cheaper to reject.
 *
 * `isPhysical: false` is excluded because that is the "Common" bookkeeping
 * bucket (models/Branch.js) — nobody trains at a cost centre.
 */
const resolveScanBranch = async (requested, fallback) => {
  const wanted = String(requested || "").trim();
  if (!wanted) return fallback || null;

  // Case-insensitive exact match: the QR is generated from this same master, but
  // a deep link survives being retyped, lower-cased by a scanner app, or shared
  // in a chat that title-cased it.
  const branch = await Branch.findOne({
    name: new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    isPhysical: { $ne: false },
  }).lean();

  // An unknown branch falls back to the subject's own rather than failing the
  // scan. The person is standing in a gym either way; refusing to record their
  // visit because a sticker was reprinted with the wrong slug would be the
  // worse outcome, and the fallback is still a real branch.
  return branch ? branch.name : fallback || null;
};

/** Loads the subject named by the verified token, plus its branch and sweep length. */
const loadSubject = async ({ id, subjectType }) => {
  if (subjectType === "TRAINER") {
    const trainer = await Trainer.findById(id).lean();
    if (!trainer) return null;
    return {
      subjectType: "TRAINER",
      doc: trainer,
      homeBranch: trainer.branch,
      minutes: TRAINER_SHIFT_MINUTES,
      ownerFilter: { subjectType: "TRAINER", trainerId: trainer._id },
      ids: { memberId: null, trainerId: trainer._id },
    };
  }

  // balanceAmount is a VIRTUAL over payments[], so this must be a document —
  // .lean() would strip it and every member would read as owing their full fee.
  const member = await Member.findById(id);
  if (!member) return null;
  return {
    subjectType: "MEMBER",
    doc: member,
    homeBranch: member.branch,
    minutes: member.sessionMinutes || MEMBER_DEFAULT_MINUTES,
    ownerFilter: { subjectType: "MEMBER", memberId: member._id },
    ids: { memberId: member._id, trainerId: null },
  };
};

/**
 * POST /api/v1/member-portal/attendance/scan
 *
 * Body: { branch?: string, source?: "QR" | "SELF" }
 * Returns: { verdict, reason, branch, attendanceId, message }
 *
 * The attempt is recorded EITHER WAY. A denial that left no row would be
 * indistinguishable from never having scanned, and the whole point of denying
 * unattended is that the front desk can see it afterwards and act.
 */
export const scanCheckIn = async (req, res) => {
  try {
    const subject = await loadSubject(req.portalUser);
    if (!subject) {
      return fail(
        res,
        404,
        req.portalUser.subjectType === "TRAINER"
          ? "Trainer not found"
          : "Member not found",
      );
    }

    // Same lazy sweep the button path does, and for the same reason: somebody
    // who forgot to tap out yesterday must not be blocked from training today.
    await autoCloseStale(subject.ownerFilter, subject.minutes);

    const branch = await resolveScanBranch(req.body?.branch, subject.homeBranch);
    if (!branch) {
      return fail(
        res,
        400,
        "No branch could be determined for this check-in. Please see reception.",
      );
    }

    // The verdict is computed from the freshly-read record, never from anything
    // cached in the token — a member who paid at the desk five minutes ago must
    // be allowed in on the token they already hold.
    const decision = evaluateEligibility(
      subject.subjectType,
      subject.doc,
      new Date(),
    );

    // "QR" unless the caller says otherwise. Both paths write the same shape of
    // row (D2b) and this field is the only thing separating them, which is what
    // makes "is anyone actually using the stickers?" answerable later.
    const source = req.body?.source === "SELF" ? "SELF" : "QR";

    const today = startOfDay();
    const existing = await Attendance.findOne({
      ...subject.ownerFilter,
      date: today,
    });

    const saved = await recordAttempt({
      existing,
      subject,
      branch,
      source,
      today,
      decision,
    });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: decision.message,
      data: {
        verdict: decision.verdict,
        reason: decision.reason,
        branch,
        attendanceId: saved ? saved._id : null,
        subjectType: subject.subjectType,
        checkInAt: saved ? saved.checkInAt : null,
        // Repeated in the payload so no screen can present this as a turnstile.
        basis:
          "Self-reported check-in. The branch QR is a printed sticker and is not proof of presence.",
      },
    });
  } catch (error) {
    console.error("Attendance scan error:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * Write (or update) today's row for this subject.
 *
 * ============================================================================
 * ONE ROW PER SUBJECT PER DAY — THE UNIQUE INDEX ENFORCES IT, SO THE HANDLER
 * HAS TO DECIDE WHAT A SECOND SCAN MEANS RATHER THAN INSERT A DUPLICATE.
 * ============================================================================
 * Four cases, and the rule in each is "never destroy a better outcome":
 *
 *   no row + ALLOW   -> create an open session. The normal path.
 *   no row + DENY    -> create a CLOSED, denied row. Closed (checkOutAt set to
 *                       checkInAt) so a refusal can never be counted as
 *                       somebody standing on the floor by the live feed.
 *   denied row + ALLOW -> UPGRADE it in place. This is the case that matters:
 *                       a member denied at 7am who settles their balance at the
 *                       desk and scans again at 7.10 must get a real session,
 *                       and the unique index means it has to be this same row.
 *   allowed row + DENY -> leave the row alone and return the verdict. Their
 *                       session today already happened; retro-denying it would
 *                       delete a real visit from the record.
 *   allowed row + ALLOW -> idempotent. A double-tap is a double-tap, not a
 *                       second workout, so the existing row comes back
 *                       unchanged and footfall does not move.
 */
const recordAttempt = async ({
  existing,
  subject,
  branch,
  source,
  today,
  decision,
}) => {
  const now = new Date();
  const denied = decision.verdict === VERDICT.DENY;

  if (!existing) {
    return Attendance.create({
      subjectType: subject.subjectType,
      memberId: subject.ids.memberId,
      trainerId: subject.ids.trainerId,
      checkInAt: now,
      // A denied attempt is not an open session. Closing it at the same instant
      // keeps it out of "who is in the gym now" without needing that query to
      // know anything about denials.
      checkOutAt: denied ? now : null,
      autoClosed: false,
      deniedReason: denied ? decision.reason : null,
      source,
      branch,
      date: today,
    });
  }

  const wasDenied = Boolean(existing.deniedReason);

  if (wasDenied && !denied) {
    // The upgrade. Re-stamp the whole row: the real session starts now, not at
    // the moment of the refusal.
    existing.deniedReason = null;
    existing.checkInAt = now;
    existing.checkOutAt = null;
    existing.autoClosed = false;
    existing.branch = branch;
    existing.source = source;
    return existing.save();
  }

  if (wasDenied && denied) {
    // Still refused. Record the latest reason and branch — the reason can move
    // (expired today, payment due tomorrow) and the newest one is the one the
    // desk needs — but do not multiply the rows.
    existing.deniedReason = decision.reason;
    existing.branch = branch;
    existing.source = source;
    return existing.save();
  }

  // An allowed row already exists. Untouched in both remaining cases.
  return existing;
};

/**
 * GET /api/v1/attendance/qr/:branch   (staff)
 *
 * The payload for the printed sticker: the deep link a phone camera should
 * open. Generated here rather than hand-typed onto a sticker so the branch slug
 * on the wall cannot drift from the Branch master — a mistyped one would either
 * fall back to the member's home branch or, before validation existed, invent a
 * third branch in every report.
 *
 * RETURNS THE PAYLOAD, NOT A PNG. Rendering is the admin panel's job: the
 * server has no QR encoder dependency, adding one for a string this short is
 * not worth 31 more packages in an already vulnerable tree, and the admin has
 * to lay the sticker out (branch name, instructions) around the code anyway.
 * The contract's "payload/PNG" is satisfied by the payload — see the report.
 *
 * NO SECRET, NOTHING TO ROTATE. The link is deliberately guessable; D2 accepted
 * that there is no presence proof. If this ever grows a token, it stops being a
 * printed sticker and becomes the kiosk that was declined.
 */
export const getBranchQr = async (req, res) => {
  try {
    const requested = String(req.params.branch || "").trim();
    if (!requested) return fail(res, 400, "Branch is required");

    const branch = await Branch.findOne({
      name: new RegExp(
        `^${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      ),
    }).lean();

    if (!branch) return fail(res, 404, `Branch "${requested}" not found`);
    if (branch.isPhysical === false) {
      return fail(
        res,
        400,
        `"${branch.name}" is a bookkeeping branch, not a gym. There is nothing to print a QR for.`,
      );
    }

    /**
     * BRANCH SCOPING, from req.session.user via the helper — never req.user,
     * which carries no branch at all and would read as "unrestricted" for every
     * branch admin (middlewares/branchScope.js).
     *
     * A branch admin printing the other branch's sticker is not a data leak,
     * but it is how the wrong sticker ends up on the wrong wall, and every
     * visit scanned through it is then attributed to the wrong branch
     * permanently. So a branch admin gets their own branch's QR only.
     */
    const own = scopedBranch(req);
    if (own && own !== branch.name) {
      return fail(res, 403, `You can only print the QR for ${own}.`);
    }

    const origin = (process.env.PUBLIC_SITE_ORIGIN || "")
      .trim()
      .replace(/\/+$/, "");

    // The path the portal serves the check-in screen on. `src=qr` is what lets
    // the portal tell a scan from somebody opening the page themselves, and it
    // is the pair of params the LOGIN REDIRECT has to carry through — a
    // logged-out member who scans otherwise loses the attribution, which is the
    // one thing the sticker exists for (plan.md, Phase 3).
    const path = `/attendance?branch=${encodeURIComponent(branch.name)}&src=qr`;

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `QR payload for ${branch.name}`,
      data: {
        branch: branch.name,
        displayName: branch.displayName || branch.name,
        // Absolute when PUBLIC_SITE_ORIGIN is configured. Relative otherwise,
        // which is useless on a sticker — so `configured` says which it is
        // rather than letting somebody print a QR that resolves to nothing.
        url: origin ? `${origin}${path}` : path,
        path,
        configured: Boolean(origin),
        instructions:
          "Print one per branch and fix it where members enter. Scanning opens " +
          "the member portal check-in screen with this branch pre-selected.",
        notice:
          "This is not proof of attendance. A printed code can be photographed " +
          "and used from anywhere; it records a self-reported check-in.",
      },
    });
  } catch (error) {
    console.error("Branch QR error:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
