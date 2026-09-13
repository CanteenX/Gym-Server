import mongoose from "mongoose";

/**
 * One gym visit by one member — or, since Phase 3, one shift by one trainer.
 *
 * WHY A ROW PER SESSION RATHER THAN A COUNTER ON Member:
 * a counter answers "how many times has he trained" and nothing else. The
 * portal asks harder questions — streaks, this month's minutes, "did I train on
 * the 5th" — and every one of those needs the individual visits kept.
 *
 * Rows are OWNED BY THE SUBJECT: memberId/trainerId always come from the
 * verified JWT, never from the request, so nobody can check in as somebody else.
 *
 * ============================================================================
 * ONE COLLECTION, TWO SUBJECTS — READ THIS BEFORE WRITING ANY QUERY HERE.
 * ============================================================================
 * plan.md D3 chose a discriminator (`subjectType`) over a second
 * `TrainerAttendance` collection, because "who is in the gym now" and per-day
 * footfall are then one query instead of two plus a merge, and the auto-close
 * behaviour is written once instead of twice.
 *
 * The price of that decision, accepted knowingly and payable HERE:
 *
 *     EVERY QUERY AGAINST THIS COLLECTION MUST FILTER ON subjectType.
 *
 * A query that forgets it does not throw, does not warn, and does not look
 * wrong on screen — it just quietly adds trainer shifts to member footfall and
 * the owner's numbers become wrong with no symptom. The only queries that may
 * legitimately span both are the ones asking about the COLLECTION rather than
 * about people (branch.controller.js's "is this branch still referenced?"),
 * and those say so in a comment.
 */
const AttendanceSchema = new mongoose.Schema(
  {
    /**
     * Which kind of person this row is about. The discriminator from D3.
     *
     * Defaulted rather than left undefined so a row written by code that has
     * not been updated still lands in the MEMBER bucket — the pre-Phase-3
     * meaning of every existing row — instead of in neither bucket, where a
     * `subjectType: "MEMBER"` filter would silently drop it from footfall.
     * scripts/migrateAttendanceSubjectType.js backfills the historical rows for
     * the same reason.
     */
    subjectType: {
      type: String,
      enum: ["MEMBER", "TRAINER"],
      required: true,
      default: "MEMBER",
      // A standalone index as well as the compound one at the bottom of this
      // file, which looks redundant and is not: the compound is PARTIAL on
      // `subjectType: { $exists: true }`, so it cannot answer
      // `{ subjectType: { $exists: false } }` — which is exactly the question
      // the migration asks to find rows it has not backfilled yet. This plain
      // index indexes a missing field as null and can.
      index: true,
    },

    /**
     * Null ONLY on a trainer row. Required for a member row, and enforced by a
     * function rather than `required: true` because the field genuinely has two
     * modes now — a flat `true` would reject every trainer shift.
     */
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
      required() {
        return this.subjectType !== "TRAINER";
      },
      index: true,
    },

    /** Null on a member row; the mirror of memberId for a trainer shift. */
    trainerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trainer",
      default: null,
      required() {
        return this.subjectType === "TRAINER";
      },
    },

    /**
     * Why a scan was refused, or null when it was allowed.
     *
     * A DENIED ATTEMPT IS STILL A ROW. Nobody stands at the door (plan.md D2),
     * so a denial cannot stop anyone walking in — all the system can do is tell
     * the member and leave a trace staff can act on. An absent row would be
     * indistinguishable from "never scanned", which is exactly the information
     * the front desk needs.
     *
     * Because a denial IS a row, the counting views have to exclude it or a
     * lapsed member tapping the sticker five times becomes five visits. Denied
     * rows are written with checkOutAt === checkInAt so they can never be
     * mistaken for an open session either.
     */
    deniedReason: {
      type: String,
      default: null,
    },

    /**
     * The staff override of a refusal — "was denied for X, overridden by Y at Z".
     *
     * ========================================================================
     * WHY THE REFUSAL IS MOVED HERE RATHER THAN LEFT IN deniedReason.
     * ========================================================================
     * A member wrongly refused at the door settles it at reception, and staff
     * mark the row allowed (controllers/v1/attendanceOverride.controller.js).
     * Two things have to be true afterwards and they pull against each other:
     *
     *   1. The row must stop being a refusal. Sixteen audited call sites count
     *      attendance with `deniedReason: null` — the live feed, footfall, the
     *      exports, the churn list. Leaving deniedReason set and adding an
     *      "overridden" flag beside it would mean teaching EVERY one of those
     *      queries about the flag, and the one that got missed would keep
     *      showing a resolved refusal in the front desk's face forever.
     *
     *   2. The refusal must not be erasable. Simply nulling deniedReason
     *      produces a clean row that looks like the member was never turned
     *      away — destroying the evidence of a staff override that may have
     *      involved money owed, which is exactly what an audit trail exists to
     *      prevent.
     *
     * So deniedReason IS cleared (every existing query keeps working untouched)
     * and the original is copied in here together with who overrode it and
     * when. Nothing is lost and nothing has to be re-taught.
     *
     * Null on every row that was never overridden, which is almost all of them.
     * `_id: false` because this is one embedded fact about the parent, not a
     * collection member; it needs no identity of its own.
     *
     * NOTE the self-service path is deliberately NOT recorded here: when a
     * member pays at the desk and re-scans, attendanceScan.controller.js
     * upgrades the row itself and no staff decision was made. This field means
     * "a member of staff overrode the system", which is the auditable event.
     */
    denialOverride: {
      type: new mongoose.Schema(
        {
          /** The deniedReason this row carried before the override. */
          originalReason: { type: String, required: true },
          /** When the refusal itself was recorded. */
          deniedAt: { type: Date, default: null },
          /** Copied, not referenced — the row must still read after a leaver. */
          actorId: { type: String, default: "" },
          actorName: { type: String, default: "" },
          actorRole: { type: String, default: "" },
          overriddenAt: { type: Date, required: true },
          /** Optional free text from reception, e.g. "paid, receipt 1042". */
          note: { type: String, default: "" },
          /**
           * Whether the override also opened a live session. False when the
           * refusal was not from today — see the controller.
           */
          sessionOpened: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: null,
    },

    /**
     * How the session was started: the portal button, or the branch QR.
     *
     * Both paths write the same shape of row on purpose (plan.md D2b) — if the
     * QR wrote a different shape the two sets of footfall numbers could not be
     * compared. This field is the only thing that separates them, which is what
     * makes "is anyone actually using the stickers?" answerable.
     */
    source: {
      type: String,
      enum: ["SELF", "QR"],
      required: true,
      default: "SELF",
    },

    checkInAt: {
      type: Date,
      required: true,
    },

    /** Null while the member is still inside. */
    checkOutAt: {
      type: Date,
      default: null,
    },

    /**
     * True when the SERVER closed the session, not the member.
     *
     * Worth recording separately: a run of auto-closed sessions means the
     * check-out button isn't being found, which is a UI problem, not a member
     * problem. Collapsing both into "checked out" would hide that entirely.
     */
    autoClosed: {
      type: Boolean,
      default: false,
    },

    /**
     * Denormalised from the member at check-in — deliberately a copy, not a
     * lookup through memberId.
     *
     * A member who transfers from Vasna to Gotri must not retroactively move
     * every past visit with them. Vasna's footfall for last March happened at
     * Vasna, and a join against the member's CURRENT branch would silently
     * rewrite that history.
     *
     * The enum moved to the Branch master (models/Branch.js) so opening a
     * third gym is a data change, not a schema change. Still a STRING, not a
     * branchId reference — that is exactly what makes the snapshot above work:
     * the recorded name is a frozen copy, immune to any later master edit.
     */
    branch: {
      type: String,
      required: true,
    },

    /**
     * The check-in DAY, normalised to midnight.
     *
     * Stored alongside checkInAt rather than derived from it so "did I train on
     * the 5th" is one indexed equality match, instead of a $gte/$lt range scan
     * built per day — which is what the calendar view would otherwise need for
     * all thirty-odd days it renders at once.
     */
    date: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

/**
 * One session per member per day.
 *
 * A second tap of check-in on the same day is a mistake or a double-tap, not a
 * second workout: the handler resumes/reopens the existing row rather than
 * creating a duplicate. The index guarantees that even if a future caller
 * forgets to check first — and it's what makes the streak maths trustworthy,
 * since a day can never contribute two entries.
 *
 * ============================================================================
 * NOW PARTIAL, AND IT HAS TO BE. RUN THE MIGRATION BEFORE ANY TRAINER SCANS.
 * ============================================================================
 * Trainer rows carry `memberId: null`. A plain unique index treats null as a
 * value, so the SECOND trainer to check in on any given day would collide with
 * the first:
 *     E11000 duplicate key ... index: memberId_1_date_1 dup key: { memberId: null }
 * — the exact trap the receipt-number index fell into (scripts/fixReceiptIndex.js).
 * The partial filter restricts uniqueness to rows that actually name a member.
 *
 * Mongoose will NOT rewrite an index that already exists in the database just
 * because the options here changed; it logs an IndexOptionsConflict and carries
 * on with the old, dangerous one. scripts/migrateAttendanceSubjectType.js drops
 * and recreates it. Until that has run, trainer check-in is broken for everyone
 * but the first trainer of the day.
 */
AttendanceSchema.index(
  { memberId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { memberId: { $type: "objectId" } },
  },
);

/** The same guarantee for a trainer's shift, on the mirror field. */
AttendanceSchema.index(
  { trainerId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { trainerId: { $type: "objectId" } },
  },
);

/** The recent-activity list reads newest-first for one member. */
AttendanceSchema.index({ memberId: 1, checkInAt: -1 });

/**
 * Staff footfall: "check-ins at this branch between these two dates".
 *
 * Added for the staff attendance views (Phase 4). Every index above is keyed on
 * memberId, which is right for the member portal and useless for the panel —
 * a branch/date question against a memberId index is a collection scan that
 * grows with every visit ever recorded. Branch first because it is an equality
 * match and date is a range, which is the order a compound index needs.
 */
AttendanceSchema.index({ branch: 1, date: 1 });

/**
 * "Who is in the gym right now": open sessions at a branch, newest first.
 *
 * checkOutAt leads because the query is `checkOutAt: null` — an equality match
 * that selects the handful of open rows out of the whole history before branch
 * or time are considered.
 */
AttendanceSchema.index({ checkOutAt: 1, branch: 1, checkInAt: -1 });

/**
 * The Phase 3 index: every staff-facing question is now asked per subject type.
 *
 * subjectType leads because it is the equality match that every one of those
 * queries carries (see the file header), branch is the second equality, and
 * checkInAt is the range — which is the order a compound index needs to be
 * usable from left to right.
 *
 * PARTIAL on `subjectType: { $exists: true }` so it indexes only rows that have
 * been migrated. A pre-Phase-3 row without the field cannot satisfy a
 * `subjectType: "MEMBER"` query anyway, so indexing it would cost space and buy
 * nothing; and keeping the index partial makes "how many rows still need the
 * backfill?" cheap to answer. Once the migration has run it covers everything.
 */
AttendanceSchema.index(
  { subjectType: 1, branch: 1, checkInAt: -1 },
  { partialFilterExpression: { subjectType: { $exists: true } } },
);

export default mongoose.model("Attendance", AttendanceSchema);
