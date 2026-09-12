/**
 * Seeds the EmailSetup row that services/mailService.js sends every outbound
 * email through (OTP password resets, website lead notifications).
 *
 * Run from the Gym-Server directory:
 *
 *     GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx npm run seed:email
 *
 * THE APP PASSWORD IS NEVER WRITTEN INTO THIS FILE, and must never be. It is a
 * live credential for a real mailbox, and this repository already has a history
 * of committing .env — a secret in a script is a secret in git forever. It is
 * read from the environment at run time and the script refuses to run without
 * it, which is a loud failure instead of a silently-broken mailer.
 *
 * Idempotent: the row is matched on its email address and updated in place, so
 * re-running after a password rotation is the supported way to rotate.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import EmailSetup from "../models/EmailSetup.js";

dotenv.config();

/**
 * The sending account. Host/port/SSL are Gmail's SMTP-over-implicit-TLS
 * endpoint; mailService special-cases gmail hosts onto nodemailer's `service`
 * preset, but the row still records the real values so a future migration to
 * another provider is a data edit.
 */
const SETUP = {
  email: "nventra01@gmail.com",
  host: "smtp.gmail.com",
  port: 465,
  SSL: true,
};

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  const appPassword = process.env.GMAIL_APP_PASSWORD?.trim();
  if (!appPassword) {
    console.error(
      "❌ GMAIL_APP_PASSWORD is not set.\n" +
        "   This script will not hardcode a mailbox credential. Generate an app\n" +
        "   password at https://myaccount.google.com/apppasswords for\n" +
        `   ${SETUP.email}, then run:\n\n` +
        "     GMAIL_APP_PASSWORD=<16-char app password> npm run seed:email\n",
    );
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  const existing = await EmailSetup.findOne({ email: SETUP.email });

  if (existing) {
    // Update in place rather than inserting a second row: mailService picks the
    // newest ACTIVE row, so a duplicate would make "which account is sending?"
    // depend on write order.
    existing.host = SETUP.host;
    existing.port = SETUP.port;
    existing.SSL = SETUP.SSL;
    existing.appPassword = appPassword;
    existing.isActive = true;
    await existing.save();
    console.log(`✅ Updated existing EmailSetup for ${SETUP.email}`);
  } else {
    await new EmailSetup({ ...SETUP, appPassword, isActive: true }).save();
    console.log(`✅ Created EmailSetup for ${SETUP.email}`);
  }

  // Any other active row would compete to be "the newest active row".
  const demoted = await EmailSetup.updateMany(
    { email: { $ne: SETUP.email }, isActive: true },
    { $set: { isActive: false } },
  );
  if (demoted.modifiedCount) {
    console.log(
      `⚠️ Deactivated ${demoted.modifiedCount} other active EmailSetup row(s) so there is exactly one sender`,
    );
  }

  await mongoose.disconnect();
  console.log("✅ Done.");
};

run().catch(async (err) => {
  console.error("❌ Email setup seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
