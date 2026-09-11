/**
 * One-off seed: adds the "Trainers" item to the existing "Gym" menu group so
 * the DB-driven sidebar surfaces the new page, then grants every existing role
 * full permissions on it.
 *
 * Run from the Gym Server directory:  node scripts/seedTrainerMenu.js
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

  // The Gym group was created by seedMemberMenu.js; create it if missing so
  // this script also works standalone.
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

  let trainersMenu = await MenuMaster.findOne({
    menuName: "Trainers",
    menuGroup: gymGroup._id,
  });
  if (!trainersMenu) {
    trainersMenu = await new MenuMaster({
      menuName: "Trainers",
      menuGroup: gymGroup._id,
      menuUrl: "/trainers",
      sequence: 2,
      isActive: true,
      isParent: false,
      parentMenu: null,
      icon: "ri-user-star-line",
    }).save();
    console.log("✅ Created menu item: Trainers → /trainers");
  } else {
    console.log("• Menu item 'Trainers' already exists");
  }

  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    const already = (role.roles || []).some(
      (r) => String(r.menuId) === String(trainersMenu._id),
    );
    if (already) continue;

    role.roles.push({
      menuId: trainersMenu._id,
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
  console.log("✅ Done. Reload the admin panel to see the Trainers menu.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
