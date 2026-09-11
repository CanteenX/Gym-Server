/**
 * One-off seed: adds the "Gym" menu group and its "Members" item so the
 * DB-driven sidebar surfaces the new page, then grants every existing role
 * full permissions on it (otherwise the item stays hidden).
 *
 * Run from the Gym Server directory:  node scripts/seedMemberMenu.js
 *
 * Safe to re-run — every step checks for an existing document first.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";

dotenv.config();

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  // 1. Menu group
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

  // 2. Members menu item
  let membersMenu = await MenuMaster.findOne({
    menuName: "Members",
    menuGroup: gymGroup._id,
  });
  if (!membersMenu) {
    membersMenu = await new MenuMaster({
      menuName: "Members",
      menuGroup: gymGroup._id,
      menuUrl: "/members",
      sequence: 1,
      isActive: true,
      isParent: false,
      parentMenu: null,
      icon: "ri-group-line",
    }).save();
    console.log("✅ Created menu item: Members → /members");
  } else {
    console.log("• Menu item 'Members' already exists");
  }

  // 3. Grant the new menu to every existing role, so it is actually visible.
  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    const already = (role.roles || []).some(
      (r) => String(r.menuId) === String(membersMenu._id),
    );
    if (already) continue;

    role.roles.push({
      menuId: membersMenu._id,
      menuGroupId: gymGroup._id,
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
  console.log("✅ Done. Reload the admin panel to see the Members menu.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
