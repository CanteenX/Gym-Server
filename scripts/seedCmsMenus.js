/**
 * Seeds the "CMS" menu group and one screen per website page.
 *
 * WHAT IT BUILDS (the tree lives in config/cmsMenus.js, not here):
 *
 *   CMS
 *   ├── Home                 /cms/home
 *   ├── About                /cms/about
 *   ├── Contact Us           /cms/contact
 *   ├── Content Management   (parent row, no screen)
 *   │   ├── Programs         /cms/programs
 *   │   ├── Pricing          /cms/pricing
 *   │   ├── FAQs             /cms/faqs
 *   │   ├── Trainers         /cms/trainers
 *   │   ├── Testimonials     /cms/testimonials
 *   │   └── Classes          /cms/classes
 *   ├── Header               /cms/header
 *   ├── Footer               /cms/footer
 *   └── Social & Media       /cms/social
 *
 * WHY IT IS A REAL ROUTE PER PAGE rather than one screen with `?page=faqs`:
 * the admin panel's MenuContext.findMenuIdByUrlInComplete strips the query off
 * the INCOMING url (`url.split("?")[0]`) and compares it against `menu.url`
 * UN-stripped, so a menu row carrying a query string matches nothing, resolves
 * to no menuId, and PermissionProtected denies the route outright. A row must
 * hold a bare path.
 *
 * THIS SEED IS NOT STRICTLY REQUIRED, unlike scripts/seedWebsiteMenus.js, and
 * that is by design. middlewares/cmsPermission.js falls back to the existing
 * /website-pages permission whenever a /cms/* row is missing, so the server
 * behaves exactly as it does today until this runs. What the seed buys is the
 * sidebar and the ability to grant FAQ editing without pricing editing.
 *
 * Run from the Gym-Server directory:  npm run seed:cms-menus
 *
 * Idempotent, and safe to re-run: the group is matched on menuGroupName, leaf
 * rows on menuUrl (the join key that actually matters — a duplicate URL is the
 * failure mode), and the parent row on (menuName, menuGroup) because its
 * menuUrl is "#", which is shared with other parent rows elsewhere in the
 * panel. An existing row is left exactly as it is — this never rewrites a name,
 * an icon or a sequence the owner has changed.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import { CMS_GROUP_NAME, CMS_MENU_TREE } from "../config/cmsMenus.js";

dotenv.config();

/**
 * What --grant-all actually grants, and why it stops short of delete.
 *
 * read/write/edit — see a page, add a block or a list row, change one. That is
 *         the whole job of a content editor.
 * delete— NOT granted. Deleting a SiteContent block removes a section from the
 *         live website, and deleting a SiteItem row removes a programme card or
 *         a price. Switching `isActive` off is the reversible alternative and
 *         only needs `edit`. The super admin can grant delete per role on the
 *         Employee Roles screen if it is genuinely wanted.
 * print/mail — nothing on the CMS routes reads either flag. Granting a
 *         permission that authorises nothing today silently authorises
 *         something the day an endpoint starts checking it.
 *
 * Matches scripts/seedClassMenus.js rather than the older
 * scripts/seedWebsiteMenus.js, which granted all six flags.
 */
const GRANT = {
  read: true,
  write: true,
  edit: true,
  delete: false,
  print: false,
  mail: false,
};

/**
 * Creates one MenuMaster row if it is not already there.
 *
 * @param {object} spec row from CMS_MENU_TREE
 * @param {mongoose.Types.ObjectId} groupId the CMS group
 * @param {mongoose.Types.ObjectId|null} parentId parent row, or null
 * @returns {Promise<{menu: object, created: boolean}>}
 */
const ensureMenu = async (spec, groupId, parentId) => {
  const isParent = Boolean(spec.isParent);

  /**
   * A parent row's menuUrl is "#", which is NOT unique across the panel —
   * scripts/seedMenus.js seeds "Faq Master" with the same value. Matching a
   * parent on menuUrl would find that unrelated row and skip creating this one,
   * leaving six orphaned children. Leaves are matched on menuUrl, which is the
   * key checkPermission resolves and therefore the one that must be unique.
   */
  const query = isParent
    ? { menuName: spec.menuName, menuGroup: groupId }
    : { menuUrl: spec.menuUrl };

  const existing = await MenuMaster.findOne(query);
  if (existing) {
    console.log(
      `• Menu item '${spec.menuName}' (${spec.menuUrl}) already exists`,
    );
    return { menu: existing, created: false };
  }

  const menu = await new MenuMaster({
    menuName: spec.menuName,
    menuGroup: groupId,
    menuUrl: spec.menuUrl,
    sequence: spec.sequence,
    isActive: true,
    isParent,
    parentMenu: parentId || null,
    icon: spec.icon || "",
  }).save();

  console.log(`✅ Created menu item: ${spec.menuName} → ${spec.menuUrl}`);
  return { menu, created: true };
};

export const seedCmsMenus = async () => {
  // 1. Menu group. After Gym (1) and Website (2), alongside Insights (3):
  //    these are the screens that edit the public site, and they sit next to
  //    the Website group that already holds Adverts, Leads and SEO Manager.
  let cmsGroup = await MenuGroupMaster.findOne({
    menuGroupName: CMS_GROUP_NAME,
  });
  if (!cmsGroup) {
    cmsGroup = await new MenuGroupMaster({
      menuGroupName: CMS_GROUP_NAME,
      sequence: 2,
      isActive: true,
      isLink: false,
      menuUrl: "#",
      icon: "ri-article-line",
    }).save();
    console.log(`✅ Created menu group: ${CMS_GROUP_NAME}`);
  } else {
    console.log(`• Menu group '${CMS_GROUP_NAME}' already exists`);
  }

  // 2. The tree, parents before their children so parentMenu can be set in one
  //    pass. Only two levels exist; MenuMaster self-references so deeper is
  //    possible, but the reference panel does not go deeper and neither do we.
  const allMenus = [];
  for (const spec of CMS_MENU_TREE) {
    const { menu } = await ensureMenu(spec, cmsGroup._id, null);
    allMenus.push(menu);

    for (const child of spec.children || []) {
      const { menu: childMenu } = await ensureMenu(
        child,
        cmsGroup._id,
        menu._id,
      );
      allMenus.push(childMenu);
    }
  }
  console.log(`✅ CMS tree ensured: ${allMenus.length} menu row(s)`);

  /**
   * 3. Role grants are OPT-IN, and deliberately not the default.
   *
   *    The rows above are enough for the owner: cmsPermission and
   *    checkPermission both return next() immediately for the SUPER ADMIN
   *    (isSuperAdmin, NOT the role string — a branch-level CompanyMaster admin
   *    also has role "ADMIN" and is deliberately refused the CMS),
   *    PermissionProtected short-circuits on isAdmin, and getMenuByGroups
   *    returns every active menu without filtering on permissions. A super
   *    admin can use every screen the moment the rows exist.
   *
   *    Handing every existing role write access to twelve website screens is
   *    not a safe default — it is the opposite of the reason this restructure
   *    was asked for, which was to be able to grant FAQ editing WITHOUT pricing
   *    editing. Least privilege wins: the super admin assigns these per role on
   *    the Employee Roles screen.
   *
   *    Pass --grant-all to apply the GRANT above (still without delete).
   */
  if (!process.argv.includes("--grant-all")) {
    console.log(
      "• Role grants skipped (default). Super admins already have access; " +
        "assign per-page permissions on the Employee Roles screen, " +
        "or re-run with --grant-all.",
    );
    return;
  }

  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    let changed = false;
    // The parent row is granted too. It authorises nothing (checkPermission is
    // never called with "#"), but a permission row for it costs nothing and
    // means the panel cannot hide a submenu whose parent it finds ungranted.
    for (const menu of allMenus) {
      const already = (role.roles || []).some(
        (r) => String(r.menuId) === String(menu._id),
      );
      if (already) continue;

      role.roles.push({
        menuId: menu._id,
        menuGroupId: cmsGroup._id,
        ...GRANT,
      });
      changed = true;
    }
    if (changed) {
      await role.save();
      updated += 1;
    }
  }
  console.log(
    `✅ CMS menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );
};

// Direct execution (npm run seed:cms-menus) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedCmsMenus.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedCmsMenus();
    console.log("✅ Done. Reload the admin panel to see the CMS menu.");
    process.exit(0);
  } catch (err) {
    console.error("❌ CMS menu seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedCmsMenus;
