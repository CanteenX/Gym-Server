/**
 * Registers the "Member Exercise Plan" admin screen in the menu system and
 * grants every existing role full permissions on it.
 *
 * WHY THIS SCRIPT EXISTS: the admin sidebar is driven by the MenuMaster
 * collection, not by the React route table. Adding the page and its route is
 * not enough — without a MenuMaster row the item never appears, and
 * PermissionProtected redirects non-admins away from the URL because it denies
 * any path it cannot resolve to a menu.
 *
 * Run from the Gym Server directory:  node scripts/seedMemberExercisePlanMenu.js
 *
 * Safe to re-run — every step checks for an existing document first.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";

dotenv.config();

const MENU_NAME = "Member Exercise Plan";
const MENU_URL = "/member-exercise-plan";
const GROUP_NAME = "Master";

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  // The page lives in pages/Master and its breadcrumb reads "Master", so it
  // belongs beside Membership Plans rather than in the Gym group.
  const group = await MenuGroupMaster.findOne({ menuGroupName: GROUP_NAME });
  if (!group) {
    console.error(
      `❌ Menu group "${GROUP_NAME}" not found. Create it first, or check the spelling in the menu_group_masters collection.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`• Using menu group: ${GROUP_NAME}`);

  // Sequence is derived rather than hardcoded: a fixed number would collide
  // with whatever already sits in this group and silently reorder the sidebar.
  const siblings = await MenuMaster.find({ menuGroup: group._id })
    .select("sequence")
    .lean();
  const nextSequence =
    siblings.reduce((max, m) => Math.max(max, m.sequence || 0), 0) + 1;

  let menu = await MenuMaster.findOne({
    menuName: MENU_NAME,
    menuGroup: group._id,
  });

  if (!menu) {
    menu = await new MenuMaster({
      menuName: MENU_NAME,
      menuGroup: group._id,
      menuUrl: MENU_URL,
      sequence: nextSequence,
      isActive: true,
      isParent: false,
      parentMenu: null,
      icon: "ri-run-line",
    }).save();
    console.log(
      `✅ Created menu item: ${MENU_NAME} → ${MENU_URL} (sequence ${nextSequence})`,
    );
  } else {
    console.log(`• Menu item "${MENU_NAME}" already exists`);
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
      menuGroupId: group._id,
      read: true,
      write: true,
      edit: true,
      delete: true,
      print: true,
      mail: true,
    });
    await role.save();
    updated += 1;
  }
  console.log(
    `✅ Menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );

  await mongoose.disconnect();
  console.log(
    `✅ Done. Reload the admin panel to see the ${MENU_NAME} menu under ${GROUP_NAME}.`,
  );
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
