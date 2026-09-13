/**
 * Retire admin@barodaweb.net — a CompanyMaster with isSuperAdmin: false and no
 * roleId, so it cannot pass any PermissionProtected screen.
 *
 * Default is dry-run. Pass --apply to set isActive: false.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import CompanyMaster from "../models/CompanyMaster.js";

dotenv.config();

const EMAIL = "admin@barodaweb.net";
const apply = process.argv.includes("--apply");

async function main() {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("DATABASE is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const doc = await CompanyMaster.findOne({
    email: new RegExp(`^${EMAIL}$`, "i"),
  }).lean();

  if (!doc) {
    console.log(`No CompanyMaster found for ${EMAIL}`);
    await mongoose.disconnect();
    return;
  }

  console.log(
    `Found ${EMAIL}: isSuperAdmin=${doc.isSuperAdmin} roleId=${doc.roleId ?? "null"} isActive=${doc.isActive}`,
  );

  if (!apply) {
    console.log("Dry run. Re-run with --apply to set isActive: false.");
    await mongoose.disconnect();
    return;
  }

  await CompanyMaster.updateOne({ _id: doc._id }, { $set: { isActive: false } });
  console.log(`✅ Deactivated ${EMAIL}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
