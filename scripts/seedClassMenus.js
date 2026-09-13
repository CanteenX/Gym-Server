/**
 * Seeds the "Classes" screen into the existing Gym menu group.
 *
 * THIS SEED IS NOT OPTIONAL. routes/v1/classes.routes.js applies
 * checkPermission to every staff route, and checkPermission resolves a menu BY
 * URL — a missing MenuMaster row is a 403 ("Menu '/class-sessions' not found"),
 * not a fallback.
 *
 * The failure is asymmetric and therefore easy to miss: checkPermission returns
 * next() immediately for the SUPER ADMIN (isSuperAdmin, not the role string —
 * see middlewares/superAdmin.js), so the owner sees a working screen while
 * every employee AND every branch admin gets 403 on the same one. Run the seed.
 *
 * ONE ROW, NOT TWO. The class diary and the roster are the same screen doing
 * the same job for the same person, so bookings are governed by
 * /class-sessions as well — see the header of routes/v1/classes.routes.js.
 * There is no row for the reminder cron: it has no admin screen, no session,
 * and is authenticated by CRON_SECRET instead (controllers/v1/jobs.controller.js).
 *
 * Run from the Gym-Server directory:  npm run seed:class-menus
 *
 * Idempotent: the row is looked up by menuUrl before it is created, and a role
 * that already holds a permission row for it is skipped.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import ClassSession from "../models/ClassSession.js";
import Booking from "../models/Booking.js";
import ReminderLog from "../models/ReminderLog.js";

dotenv.config();

/**
 * menuUrl is the join key that checkPermission and Gym-Admin's
 * PermissionProtected both match on, so this string must stay identical to the
 * admin panel's route path. Changing one without the other silently locks staff
 * out of a screen that still appears in their sidebar.
 */
const CLASS_MENU = {
  menuName: "Classes",
  menuUrl: "/class-sessions",
  // After Members (1), Trainers (2), Membership Plans (3) and the rest of the
  // Gym group. A high number keeps it at the end without having to know exactly
  // what is already there — MenuMaster sorts on sequence, ties fall back to
  // insertion order, and nothing else in the group uses 20.
  sequence: 20,
  icon: "ri-calendar-check-line",
};

/**
 * What --grant-all actually grants, and why it stops short of delete.
 *
 * read  — see the diary and the roster.
 * write — schedule a class.
 * edit  — reschedule one, and mark somebody ATTENDED or NO_SHOW. Marking
 *         attendance is the daily job, so a role with no `edit` has a roster it
 *         can look at and not use.
 * delete— NOT granted. Deleting a class deletes every booking on it
 *         (classSession.controller.js does so deliberately, to avoid orphan
 *         rows), which is a destructive act on other people's records. Switching
 *         a class off with isActive is the reversible alternative and only needs
 *         `edit`. The super admin can grant delete per role if it is genuinely
 *         wanted.
 * print/mail — nothing on these routes reads either flag. Granting a permission
 *         that authorises nothing today silently authorises something the day
 *         an endpoint starts checking it.
 */
const GRANT = {
  read: true,
  write: true,
  edit: true,
  delete: false,
  print: false,
  mail: false,
};

export const seedClassMenus = async () => {
  /**
   * 0. BUILD THE INDEXES, DETERMINISTICALLY, BEFORE ANYTHING USES THEM.
   *
   * Not decoration. Two of Phase 5's correctness guarantees ARE indexes:
   *
   *   Booking     `{ session, member }` / `{ session, lead }` unique — the only
   *               thing that stops one person taking two seats in a class.
   *   ReminderLog `{ channel, dedupeKey }` unique — the only thing that stops a
   *               member being emailed twice about the same expiry.
   *
   * Mongoose's autoIndex builds them lazily on a model's first use and does NOT
   * block queries while it does, so in principle the very first booking after a
   * deploy could land before the constraint exists. `init()` waits for the build
   * to finish, which makes running this seed the moment those guarantees become
   * real. Idempotent — an index that already matches is a no-op.
   *
   * It also surfaces a build FAILURE here, loudly, rather than at 2 a.m.: if
   * existing data already violates a new unique index, this is where you find out.
   */
  await Promise.all([ClassSession.init(), Booking.init(), ReminderLog.init()]);
  console.log(
    "✅ Indexes ensured: ClassSession, Booking (unique session+member / session+lead), " +
      "ReminderLog (unique channel+dedupeKey)",
  );

  // 1. The Gym group already exists (scripts/seedMemberMenu.js creates it).
  //    Created here only so this seed works on a fresh database in any order.
  let gymGroup = await MenuGroupMaster.findOne({ menuGroupName: "Gym" });
  if (!gymGroup) {
    gymGroup = await new MenuGroupMaster({
      menuGroupName: "Gym",
      sequence: 1,
      isActive: true,
      isLink: false,
      menuUrl: "#",
      icon: "ri-heart-pulse-line",
    }).save();
    console.log("✅ Created menu group: Gym");
  } else {
    console.log("• Menu group 'Gym' already exists");
  }

  // 2. The menu item. Matched on menuUrl, not menuName: the URL is what
  //    checkPermission looks up, so a duplicate URL is the failure that matters.
  let menu = await MenuMaster.findOne({ menuUrl: CLASS_MENU.menuUrl });
  if (!menu) {
    menu = await new MenuMaster({
      menuName: CLASS_MENU.menuName,
      menuGroup: gymGroup._id,
      menuUrl: CLASS_MENU.menuUrl,
      sequence: CLASS_MENU.sequence,
      isActive: true,
      isParent: false,
      parentMenu: null,
      icon: CLASS_MENU.icon,
    }).save();
    console.log(`✅ Created menu item: ${CLASS_MENU.menuName} → ${CLASS_MENU.menuUrl}`);
  } else {
    console.log(`• Menu item '${CLASS_MENU.menuUrl}' already exists`);
  }

  /**
   * 3. Role grants are OPT-IN, and deliberately not the default.
   *
   *    The row above is enough for the owner: checkPermission short-circuits
   *    for the super admin, PermissionProtected short-circuits on isAdmin, and
   *    getMenuByGroups returns every active menu without filtering on
   *    permissions. A super admin can use the screen the moment the row exists.
   *
   *    Handing every existing role the ability to schedule and reschedule
   *    classes is not a safe default — a trainer moving a class moves other
   *    people's bookings with it. Least privilege wins: the super admin assigns
   *    it per role on the Employee Roles screen.
   *
   *    Pass --grant-all to apply the GRANT above (still without delete).
   */
  if (!process.argv.includes("--grant-all")) {
    console.log(
      "• Role grants skipped (default). Super admins already have access; " +
        "assign per-role permissions on the Employee Roles screen, " +
        "or re-run with --grant-all.",
    );
    return;
  }

  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    const already = (role.roles || []).some(
      (r) => String(r.menuId) === String(menu._id),
    );
    if (already) continue;

    role.roles.push({
      menuId: menu._id,
      menuGroupId: gymGroup._id,
      ...GRANT,
    });
    await role.save();
    updated += 1;
  }
  console.log(
    `✅ Classes menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );
};

// Direct execution (npm run seed:class-menus) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedClassMenus.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedClassMenus();
    console.log("✅ Done. Reload the admin panel to see the Classes screen.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Classes menu seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedClassMenus;
