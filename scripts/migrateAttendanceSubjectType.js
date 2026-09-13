/**
 * One-off, IDEMPOTENT migration for Phase 3 (plan.md D3).
 *
 * Run from the Gym-Server directory:
 *
 *     node scripts/migrateAttendanceSubjectType.js
 *     node scripts/migrateAttendanceSubjectType.js --dry-run     (changes nothing)
 *
 * Safe to re-run: every step is expressed as "make it so", not "do it again".
 *
 * ============================================================================
 * RUN THIS BEFORE ANY TRAINER SCANS. NOT AFTER.
 * ============================================================================
 * Step 2 is the reason. `memberId_1_date_1` currently exists in the database as
 * a PLAIN unique index, and a plain unique index treats null as a value — so a
 * trainer row (memberId: null) collides with the previous trainer row on the
 * same date:
 *
 *     E11000 duplicate key ... index: memberId_1_date_1 dup key: { memberId: null }
 *
 * which is the same trap the receipt-number index fell into
 * (scripts/fixReceiptIndex.js). Mongoose will NOT rewrite an index that already
 * exists just because the schema's options changed: it logs an
 * IndexOptionsConflict on boot and carries on with the old one. Only this
 * script drops and recreates it. Until it has run, the FIRST trainer to check
 * in each day succeeds and everyone after them gets a 500.
 *
 * WHAT IT DOES
 *   1. Backfill  subjectType: "MEMBER", source: "SELF" on every row that
 *      predates the discriminator. Those rows are all members' — members were
 *      the only thing that could create one — and a row with no subjectType
 *      matches no `subjectType: "MEMBER"` query, so leaving one behind removes
 *      a real visit from footfall silently.
 *   2. Rebuild  memberId_1_date_1 as a PARTIAL unique index (see above) and add
 *      the matching trainerId_1_date_1.
 *   3. Create   the { subjectType, branch, checkInAt } index the staff views
 *      now read through.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It does not touch `trainerId` or `deniedReason`. Both are legitimately
 *     absent on every historical row, and absent reads as null in Mongo for an
 *     equality match, so `deniedReason: null` already selects them correctly.
 *     Writing nulls into two million rows to change nothing is not a migration,
 *     it is a rewrite with a chance of failure.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const DRY = process.argv.includes("--dry-run");

const MEMBER_DATE_INDEX = "memberId_1_date_1";
const TRAINER_DATE_INDEX = "trainerId_1_date_1";
const SUBJECT_INDEX = "subjectType_1_branch_1_checkInAt_-1";

const describe = (i) =>
  `  ${i.name}  ${JSON.stringify(i.key)}` +
  `${i.unique ? " unique" : ""}` +
  `${i.sparse ? " sparse" : ""}` +
  `${i.partialFilterExpression ? ` partial ${JSON.stringify(i.partialFilterExpression)}` : ""}`;

const run = async () => {
  if (!process.env.DATABASE) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log(`✅ Connected to MongoDB${DRY ? "  (DRY RUN — no writes)" : ""}`);

  const col = mongoose.connection.db.collection("attendances");

  const total = await col.countDocuments({});
  console.log(`\nattendances: ${total} row(s)`);

  console.log("\n--- indexes before ---");
  for (const i of await col.indexes()) console.log(describe(i));

  // =========================================================================
  // 1. Backfill the discriminator.
  // =========================================================================
  // Two separate updates rather than one $set of both fields: a row could in
  // principle have gained one field and not the other (a partially-applied
  // earlier run, an interrupted deploy), and counting them separately is what
  // makes the output honest about what was actually missing.
  const needSubject = await col.countDocuments({
    subjectType: { $exists: false },
  });
  const needSource = await col.countDocuments({ source: { $exists: false } });

  console.log(
    `\nrows missing subjectType: ${needSubject}` +
      `\nrows missing source:      ${needSource}`,
  );

  if (!DRY) {
    // $exists: false, NOT `{ subjectType: null }` — the latter would also match
    // a row deliberately holding null and is a wider net than intended. And it
    // is what makes re-running a no-op: the second run matches nothing.
    const a = await col.updateMany(
      { subjectType: { $exists: false } },
      { $set: { subjectType: "MEMBER" } },
    );
    const b = await col.updateMany(
      { source: { $exists: false } },
      { $set: { source: "SELF" } },
    );
    console.log(
      `✅ subjectType backfilled on ${a.modifiedCount} row(s)` +
        `\n✅ source backfilled on      ${b.modifiedCount} row(s)`,
    );
  }

  // =========================================================================
  // 2. Rebuild the per-day uniqueness indexes as PARTIAL.
  // =========================================================================
  if (!DRY) {
    try {
      await col.dropIndex(MEMBER_DATE_INDEX);
      console.log(`\n✅ Dropped ${MEMBER_DATE_INDEX}`);
    } catch (err) {
      // Absent already (fresh database, or a second run) is success, not failure.
      console.log(`\n• dropIndex ${MEMBER_DATE_INDEX}: ${err.message}`);
    }

    await col.createIndex(
      { memberId: 1, date: 1 },
      {
        unique: true,
        partialFilterExpression: { memberId: { $type: "objectId" } },
        name: MEMBER_DATE_INDEX,
      },
    );
    console.log(`✅ Recreated ${MEMBER_DATE_INDEX} as partial unique`);

    await col.createIndex(
      { trainerId: 1, date: 1 },
      {
        unique: true,
        partialFilterExpression: { trainerId: { $type: "objectId" } },
        name: TRAINER_DATE_INDEX,
      },
    );
    console.log(`✅ Created ${TRAINER_DATE_INDEX} as partial unique`);

    // =======================================================================
    // 3. The index every staff view now reads through.
    // =======================================================================
    await col.createIndex(
      { subjectType: 1, branch: 1, checkInAt: -1 },
      {
        partialFilterExpression: { subjectType: { $exists: true } },
        name: SUBJECT_INDEX,
      },
    );
    console.log(`✅ Created ${SUBJECT_INDEX}`);
  }

  console.log("\n--- indexes after ---");
  for (const i of await col.indexes()) console.log(describe(i));

  // A final read-back, because "the update said it modified 0 rows" is only
  // reassuring if 0 was the right answer.
  const remaining = await col.countDocuments({
    subjectType: { $exists: false },
  });
  const members = await col.countDocuments({ subjectType: "MEMBER" });
  const trainers = await col.countDocuments({ subjectType: "TRAINER" });
  console.log(
    `\nsubjectType MEMBER:  ${members}` +
      `\nsubjectType TRAINER: ${trainers}` +
      `\nstill missing:       ${remaining}`,
  );

  if (remaining > 0 && !DRY) {
    console.warn(
      "⚠️  Some rows still have no subjectType. They will be INVISIBLE to " +
        "every footfall query. Investigate before trusting the numbers.",
    );
  }

  await mongoose.disconnect();
  console.log(
    DRY
      ? "\n✅ Dry run complete. Nothing was written."
      : "\n✅ Done. Trainer check-in can now be enabled.",
  );
};

run().catch(async (err) => {
  console.error("❌ Failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
