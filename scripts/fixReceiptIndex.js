/**
 * One-off repair for the receipt-number index.
 *
 * THE BUG: the index was created as `{ unique: true, sparse: true }`, but the
 * schema also gave `receiptNo` a `default: ""`. Sparse only skips documents
 * where the field is ABSENT — an empty string is a real value, so every expense
 * row indexed "" and the second expense collided with the first:
 *   E11000 duplicate key ... index: receiptNo_1 dup key: { receiptNo: "" }
 *
 * THE FIX, in three steps:
 *   1. drop the stale index (Mongoose will not replace an existing index just
 *      because the schema changed),
 *   2. unset the empty-string receiptNo on expense rows,
 *   3. recreate it as a PARTIAL unique index covering only rows that actually
 *      carry a receipt number.
 *
 * Income rows keep their real receipt numbers — the filter never matches them.
 *
 * Run from the Gym Server directory:  node scripts/fixReceiptIndex.js
 * Safe to re-run.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const INDEX_NAME = "receiptNo_1";

const run = async () => {
  if (!process.env.DATABASE) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log("✅ Connected to MongoDB");

  const col = mongoose.connection.db.collection("transactions");

  console.log("\n--- indexes before ---");
  for (const i of await col.indexes()) {
    console.log(
      `  ${i.name}  ${JSON.stringify(i.key)}` +
        `${i.sparse ? " sparse" : ""}${i.unique ? " unique" : ""}` +
        `${i.partialFilterExpression ? " partial" : ""}`,
    );
  }

  // 1. Drop the stale index.
  try {
    await col.dropIndex(INDEX_NAME);
    console.log(`\n✅ Dropped ${INDEX_NAME}`);
  } catch (err) {
    console.log(`\n• dropIndex: ${err.message}`);
  }

  // 2. Clear the empty-string receiptNo that expense rows stored.
  //    Income rows hold a real number and are not matched.
  const res = await col.updateMany(
    { receiptNo: "" },
    { $unset: { receiptNo: "" } },
  );
  console.log(
    `✅ Cleared empty receiptNo on ${res.modifiedCount} expense row(s)`,
  );

  // 3. Recreate as a partial unique index.
  await col.createIndex(
    { receiptNo: 1 },
    {
      unique: true,
      partialFilterExpression: { receiptNo: { $exists: true, $gt: "" } },
      name: INDEX_NAME,
    },
  );
  console.log(`✅ Recreated ${INDEX_NAME} as partial unique`);

  console.log("\n--- indexes after ---");
  for (const i of await col.indexes()) {
    console.log(
      `  ${i.name}  ${JSON.stringify(i.key)}` +
        `${i.unique ? " unique" : ""}` +
        `${i.partialFilterExpression ? " partial" : ""}`,
    );
  }

  const rows = await col
    .find(
      {},
      { projection: { direction: 1, amount: 1, receiptNo: 1, category: 1 } },
    )
    .toArray();
  console.log("\n--- rows ---");
  for (const r of rows) {
    console.log(
      `  ${r.direction}  ${r.amount}  receipt=${r.receiptNo ?? "(none)"}  ${
        r.category || ""
      }`,
    );
  }

  await mongoose.disconnect();
  console.log("\n✅ Done. Expenses can now be recorded without collisions.");
};

run().catch(async (err) => {
  console.error("❌ Failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
