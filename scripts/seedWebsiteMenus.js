/**
 * Seeds the "Website" menu group and its three screens.
 *
 * Role grants are NOT applied by default - see step 3. Super admins do not
 * need them, and handing every role delete rights over the public website is
 * not a safe default. Use --grant-all only if that is genuinely wanted.
 *
 * THIS SEED IS NOT OPTIONAL. routes/v1/site.routes.js applies checkPermission
 * to every admin write, and checkPermission resolves a menu BY URL — a missing
 * MenuMaster row is a 403 ("Menu '/website-pages' not found"), not a fallback.
 * Without this seed the three admin screens are unreachable even for a super
 * admin's employees, and the sidebar never shows them.
 *
 * Run from the Gym-Server directory:  npm run seed:website-menus
 *
 * Idempotent: every row is looked up before it is created, and a role that
 * already holds a permission row for a menu is skipped.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";

dotenv.config();

/**
 * menuUrl is the join key checkPermission and Gym-Admin's PermissionProtected
 * both match on, so these strings must stay identical to the admin panel's
 * route paths. Changing one without the other silently locks staff out.
 */
const WEBSITE_MENUS = [
  {
    menuName: "Website Pages",
    menuUrl: "/website-pages",
    sequence: 1,
    icon: "ri-pages-line",
  },
  {
    menuName: "Adverts",
    menuUrl: "/website-adverts",
    sequence: 2,
    icon: "ri-advertisement-line",
  },
  {
    menuName: "Leads",
    menuUrl: "/website-leads",
    sequence: 3,
    icon: "ri-inbox-archive-line",
  },
];

export const seedWebsiteMenus = async () => {
  // 1. Menu group
  let websiteGroup = await MenuGroupMaster.findOne({ menuGroupName: "Website" });
  if (!websiteGroup) {
    websiteGroup = await new MenuGroupMaster({
      menuGroupName: "Website",
      // After Gym (1) and before the Setup/Help groups, so the marketing tools
      // sit next to the day-to-day gym screens rather than under admin config.
      sequence: 2,
      isActive: true,
      isLink: false,
      menuUrl: "#",
      icon: "ri-global-line",
    }).save();
    console.log("✅ Created menu group: Website");
  } else {
    console.log("• Menu group 'Website' already exists");
  }

  // 2. Menu items. Matched on menuUrl, not menuName: the URL is what
  //    checkPermission looks up, so a duplicate URL is the failure that matters.
  const created = [];
  for (const item of WEBSITE_MENUS) {
    let menu = await MenuMaster.findOne({ menuUrl: item.menuUrl });
    if (!menu) {
      menu = await new MenuMaster({
        menuName: item.menuName,
        menuGroup: websiteGroup._id,
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

  // 3. Role grants are OPT-IN, and deliberately not the default.
  //
  //    The menu rows above are sufficient for the owner: checkPermission
  //    returns next() immediately for role === "ADMIN", PermissionProtected
  //    short-circuits on isAdmin, and getMenuByGroups returns every active menu
  //    without filtering on permissions. So a super admin can see and use these
  //    screens the moment the rows exist.
  //
  //    Granting read+write+edit+delete on site content, adverts and the lead
  //    inbox to EVERY existing role would hand a trainer or receptionist the
  //    ability to delete the public website's copy. Least privilege wins:
  //    the super admin assigns these per role on the Employee Roles screen.
  //
  //    Pass --grant-all to restore the blanket behaviour.
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
    let changed = false;
    for (const menu of created) {
      const already = (role.roles || []).some(
        (r) => String(r.menuId) === String(menu._id),
      );
      if (already) continue;

      role.roles.push({
        menuId: menu._id,
        menuGroupId: websiteGroup._id,
        read: true,
        write: true,
        edit: true,
        delete: true,
        print: true,
        mail: true,
      });
      changed = true;
    }
    if (changed) {
      await role.save();
      updated += 1;
    }
  }
  console.log(
    `✅ Website menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );
};

// Direct execution (npm run seed:website-menus) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedWebsiteMenus.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedWebsiteMenus();
    console.log("✅ Done. Reload the admin panel to see the Website menu.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Website menu seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedWebsiteMenus;
