/**
 * Seeds the MenuMaster row for /currency-master.
 *
 * The screen exists and is routed (Gym-Admin allRoutes.jsx) and the API is
 * gated with `checkPermission("/currency-master", …)`, but no menu row was
 * ever created. checkPermission resolves a menu BY URL, so with no row:
 *
 *   - the super admin bypasses the check and the screen works, which is why
 *     nobody noticed;
 *   - every other account gets "Menu '/currency-master' not found" — a 403 on
 *     a screen they were never able to be granted in the first place;
 *   - and it can never appear in any sidebar, because the sidebar is built
 *     from MenuMaster.
 *
 * A gated route with no menu row is broken by construction: there is no set of
 * permissions anyone could tick that would make it work. Seeding the row is
 * what makes the existing permission system able to describe it at all.
 *
 * It goes under "Location" beside Country / State / City, which is where the
 * currency master already sits in this template's information architecture,
 * at the next free sequence.
 *
 *   node scripts/seedCurrencyMenu.js            # dry run
 *   node scripts/seedCurrencyMenu.js --apply
 *
 * Idempotent: re-running changes nothing once the row exists.
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const MENU_URL = "/currency-master";
const PARENT_NAME = "Location";

await mongoose.connect(process.env.DATABASE);
const menus = mongoose.connection.db.collection("menumasters");

const existing = await menus.findOne({ menuUrl: MENU_URL });
if (existing) {
  console.log(`✅ ${MENU_URL} already exists (${existing.menuName}) — nothing to do.`);
  await mongoose.disconnect();
  process.exit(0);
}

const parent = await menus.findOne({ menuName: PARENT_NAME, menuUrl: "#" });
if (!parent) {
  console.error(`❌ parent menu "${PARENT_NAME}" not found — refusing to guess a home for ${MENU_URL}.`);
  await mongoose.disconnect();
  process.exit(1);
}

// Sit after the existing children rather than colliding with one of them.
const siblings = await menus.find({ parentMenu: parent._id }).toArray();
const sequence = siblings.reduce((max, s) => Math.max(max, s.sequence || 0), 0) + 1;

const row = {
  menuName: "Currency Master",
  menuUrl: MENU_URL,
  parentMenu: parent._id,
  sequence,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

console.log(`${APPLY ? "WRITING" : "would write"}: ${row.menuName} -> ${MENU_URL} under ${PARENT_NAME} at sequence ${sequence}`);

if (APPLY) {
  await menus.insertOne(row);
  console.log("✅ inserted. Grant it on a role to make the screen reachable for non-super-admins.");
} else {
  console.log("Dry run. Re-run with --apply.");
}

await mongoose.disconnect();
