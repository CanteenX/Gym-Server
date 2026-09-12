/**
 * One-off seed for the Branch Master.
 *
 * Inserts the branches that used to be hardcoded as `enum: ["Vasna", "Gotri"]`
 * across five models, plus "Common" — the non-physical cost bucket that
 * Transaction.branch already allows.
 *
 * Run from the Gym Server directory:  node scripts/seedBranches.js
 *
 * Safe to re-run — every branch is checked for (case-insensitively) first, and
 * an existing row is left completely untouched so hand-edited addresses,
 * phone numbers and sequences survive a re-run.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Branch, { DEFAULT_BRANCHES } from "../models/Branch.js";

dotenv.config();

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  let created = 0;
  for (const seed of DEFAULT_BRANCHES) {
    const existing = await Branch.findOne({
      name: new RegExp(`^${escapeRegex(seed.name)}$`, "i"),
    });
    if (existing) {
      console.log(`• Branch '${seed.name}' already exists — skipped`);
      continue;
    }

    await new Branch({
      name: seed.name,
      displayName: seed.displayName,
      isPhysical: seed.isPhysical,
      address: "",
      phone: "",
      sequence: seed.sequence,
      isActive: true,
    }).save();
    console.log(
      `✅ Created branch: ${seed.name} (sequence ${seed.sequence}, isPhysical ${seed.isPhysical})`,
    );
    created += 1;
  }

  console.log(`✅ ${created} branch(es) inserted`);

  const all = await Branch.find({}).sort({ sequence: 1, name: 1 }).lean();
  console.log(
    `✅ Branch master now holds: ${all
      .map((b) => `${b.name}${b.isPhysical ? "" : " (non-physical)"}`)
      .join(", ")}`,
  );

  await mongoose.disconnect();
  console.log("✅ Done.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
