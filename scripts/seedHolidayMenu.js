/**
 * Seeds the MenuMaster row for /holiday-master.
 *
 * THIS SEED IS NOT OPTIONAL. routes/v1/holidays.routes.js applies
 * checkPermission to every staff route, and checkPermission resolves a menu BY
 * URL — a missing MenuMaster row is a 403 ("Menu '/holiday-master' not
 * found"), not a fallback.
 *
 * The failure is asymmetric and therefore easy to miss: checkPermission
 * returns next() immediately for the SUPER ADMIN (isSuperAdmin, not the role
 * string — see middlewares/superAdmin.js), so the owner sees a working screen
 * while every branch admin and every employee gets 403 on the same one.
 *
 * Sits in the "Gym" group, right after Classes — a holiday closure is exactly
 * the kind of thing that affects the same screens (attendance, bookings) that
 * group already owns.
 *
 * Role GRANTS are NOT made here. scripts/repairRbac.js's TIER_BASELINES is the
 * one place that decides who holds which action on `/holiday-master` — admin
 * tier gets read+write+edit+delete, staff tier gets read only, per the
 * owner's brief. Run this seed first, then `npm run repair:rbac -- --apply`.
 *
 * Run from the Gym-Server directory:
 *
 *     node scripts/seedHolidayMenu.js            # dry run
 *     node scripts/seedHolidayMenu.js --apply
 *
 * Idempotent: the row is looked up by menuUrl before it is created.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import Holiday from "../models/Holiday.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

/**
 * menuUrl is the join key checkPermission and Gym-Admin's
 * PermissionProtected both match on, so this string must stay identical to
 * the admin panel's route path.
 */
const HOLIDAY_MENU = {
  menuName: "Holiday Master",
  menuUrl: "/holiday-master",
  // After Classes (20). A high number keeps it at the end of the Gym group
  // without having to know exactly what else is already seeded there.
  sequence: 21,
  icon: "ri-calendar-2-line",
};

export const seedHolidayMenu = async () => {
  // Builds the { branch, date } index deterministically before anything reads
  // it, same reasoning seedClassMenus.js gives for ClassSession.init().
  await Holiday.init();
  console.log("✅ Index ensured: Holiday { branch, date }");

  // The Gym group already exists (scripts/seedMemberMenu.js creates it).
  // Created here only so this seed works on a fresh database in any order.
  let gymGroup = await MenuGroupMaster.findOne({ menuGroupName: "Gym" });
  if (!gymGroup) {
    if (!APPLY) {
      console.log("would create menu group: Gym");
    } else {
      gymGroup = await new MenuGroupMaster({
        menuGroupName: "Gym",
        sequence: 1,
        isActive: true,
        isLink: false,
        menuUrl: "#",
        icon: "ri-heart-pulse-line",
      }).save();
      console.log("✅ Created menu group: Gym");
    }
  } else {
    console.log("• Menu group 'Gym' already exists");
  }

  const existing = await MenuMaster.findOne({ menuUrl: HOLIDAY_MENU.menuUrl });
  if (existing) {
    console.log(
      `✅ ${HOLIDAY_MENU.menuUrl} already exists (${existing.menuName}) — nothing to do.`,
    );
    return;
  }

  console.log(
    `${APPLY ? "WRITING" : "would write"}: ${HOLIDAY_MENU.menuName} -> ${HOLIDAY_MENU.menuUrl} under Gym at sequence ${HOLIDAY_MENU.sequence}`,
  );

  if (!APPLY) {
    console.log("Dry run. Re-run with --apply.");
    return;
  }

  if (!gymGroup) {
    console.error("❌ Refusing to create the menu with no Gym group to attach it to.");
    return;
  }

  await new MenuMaster({
    menuName: HOLIDAY_MENU.menuName,
    menuGroup: gymGroup._id,
    menuUrl: HOLIDAY_MENU.menuUrl,
    sequence: HOLIDAY_MENU.sequence,
    isActive: true,
    isParent: false,
    parentMenu: null,
    icon: HOLIDAY_MENU.icon,
  }).save();

  console.log(
    `✅ Created menu item: ${HOLIDAY_MENU.menuName} → ${HOLIDAY_MENU.menuUrl}. ` +
      "Now run `npm run repair:rbac -- --apply` to grant the tier baselines.",
  );
};

// Direct execution owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedHolidayMenu.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedHolidayMenu();
    process.exit(0);
  } catch (err) {
    console.error("❌ Holiday menu seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedHolidayMenu;
