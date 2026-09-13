/**
 * Seeds the "Insights" menu group and its three screens:
 * /attendance-overview, /reports and /audit-log.
 *
 * THIS SEED IS NOT OPTIONAL. routes/v1/attendance.routes.js (staff half),
 * routes/v1/reports.routes.js and routes/v1/auditLog.routes.js all apply
 * checkPermission, and checkPermission resolves a menu BY URL — a missing
 * MenuMaster row is a 403 ("Menu '/reports' not found"), not a fallback.
 *
 * The failure is asymmetric and therefore easy to miss: checkPermission returns
 * next() immediately for role === "ADMIN", so the owner sees three working
 * screens while every employee gets 403 on all of them. Run the seed.
 *
 * Run from the Gym-Server directory:  npm run seed:insights-menus
 *
 * Idempotent: every row is looked up by menuUrl before it is created, and a
 * role that already holds a permission row for a menu is skipped.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";

dotenv.config();

/**
 * menuUrl is the join key that checkPermission and Gym-Admin's
 * PermissionProtected both match on, so these strings must stay identical to
 * the admin panel's route paths. Changing one without the other silently locks
 * staff out of a screen that still appears in their sidebar.
 */
const INSIGHTS_MENUS = [
  {
    menuName: "Attendance Overview",
    menuUrl: "/attendance-overview",
    sequence: 1,
    icon: "ri-user-follow-line",
  },
  {
    menuName: "Reports",
    menuUrl: "/reports",
    sequence: 2,
    icon: "ri-bar-chart-box-line",
  },
  {
    menuName: "Audit Log",
    menuUrl: "/audit-log",
    sequence: 3,
    icon: "ri-history-line",
  },
];

/**
 * What --grant-all actually grants, and why it is not read+write+edit+delete.
 *
 * These three screens have no write endpoints at all: the attendance views and
 * the reports are reads, and the audit log is deliberately read-only (a trail
 * an operator can edit is not a trail). Granting write/edit/delete would hand
 * out permissions that authorise nothing today and would silently authorise
 * something the day an endpoint is added.
 *
 * "print" is granted only on /reports, because that is the flag the CSV export
 * routes check — a download leaves the building, so it is a separate decision
 * from being allowed to look at the numbers on screen.
 */
const GRANTS = {
  "/attendance-overview": { read: true, print: false },
  "/reports": { read: true, print: true },
  "/audit-log": { read: true, print: false },
};

export const seedInsightsMenus = async () => {
  // 1. Menu group. After Gym (1) and Website (2): these are the screens the
  //    owner opens to look at the business, not to run it.
  let insightsGroup = await MenuGroupMaster.findOne({
    menuGroupName: "Insights",
  });
  if (!insightsGroup) {
    insightsGroup = await new MenuGroupMaster({
      menuGroupName: "Insights",
      sequence: 3,
      isActive: true,
      isLink: false,
      menuUrl: "#",
      icon: "ri-line-chart-line",
    }).save();
    console.log("✅ Created menu group: Insights");
  } else {
    console.log("• Menu group 'Insights' already exists");
  }

  // 2. Menu items. Matched on menuUrl, not menuName: the URL is what
  //    checkPermission looks up, so a duplicate URL is the failure that matters.
  const created = [];
  for (const item of INSIGHTS_MENUS) {
    let menu = await MenuMaster.findOne({ menuUrl: item.menuUrl });
    if (!menu) {
      menu = await new MenuMaster({
        menuName: item.menuName,
        menuGroup: insightsGroup._id,
        menuUrl: item.menuUrl,
        sequence: item.sequence,
        isActive: true,
        isParent: false,
        parentMenu: null,
        icon: item.icon,
      }).save();
      console.log(`✅ Created menu item: ${item.menuName} → ${item.menuUrl}`);
    } else {
      console.log(`• Menu item '${item.menuUrl}' already exists`);
    }
    created.push(menu);
  }

  /**
   * 3. Role grants are OPT-IN, and deliberately not the default.
   *
   *    The rows above are enough for the owner: checkPermission short-circuits
   *    for role === "ADMIN", PermissionProtected short-circuits on isAdmin, and
   *    getMenuByGroups returns every active menu without filtering on
   *    permissions. A super admin can use all three screens the moment the rows
   *    exist.
   *
   *    Handing every existing role a view of the P&L, the member export and the
   *    audit trail is not a safe default — these are the screens that show what
   *    the business earns and who changed what. Least privilege wins: the super
   *    admin assigns them per role on the Employee Roles screen.
   *
   *    Pass --grant-all to apply the read-only grants in GRANTS above.
   */
  if (!process.argv.includes("--grant-all")) {
    console.log(
      "• Role grants skipped (default). Super admins already have access; " +
        "assign per-role permissions on the Employee Roles screen, " +
        "or re-run with --grant-all for read-only grants.",
    );
    return;
  }

  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    let changed = false;
    for (const menu of created) {
      const already = (role.roles || []).some(
        (r) => String(r.menuId) === String(menu._id),
      );
      if (already) continue;

      const grant = GRANTS[menu.menuUrl] || { read: true, print: false };
      role.roles.push({
        menuId: menu._id,
        menuGroupId: insightsGroup._id,
        read: grant.read,
        print: grant.print,
        // No write path exists on any of these routes. See the GRANTS comment.
        write: false,
        edit: false,
        delete: false,
        mail: false,
      });
      changed = true;
    }
    if (changed) {
      await role.save();
      updated += 1;
    }
  }
  console.log(
    `✅ Insights menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );
};

// Direct execution (npm run seed:insights-menus) owns its own connection.
if (process.argv[1] && process.argv[1].endsWith("seedInsightsMenus.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedInsightsMenus();
    console.log("✅ Done. Reload the admin panel to see the Insights menu.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Insights menu seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedInsightsMenus;
