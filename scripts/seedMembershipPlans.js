/**
 * One-off seed for the Membership Plan Master:
 *
 *  1. Inserts the five plans that used to be hardcoded in models/Member.js into
 *     the new membershipplans collection.
 *  2. Adds the "Membership Plans" item under the existing "Master" menu group
 *     (falling back to "Gym" when no Master group exists) so the DB-driven
 *     sidebar surfaces the new page.
 *  3. Grants every existing role full permissions on it — otherwise the item
 *     stays hidden.
 *
 * Run from the Gym Server directory:  node scripts/seedMembershipPlans.js
 *
 * Safe to re-run — every step checks for an existing document first.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MembershipPlan from "../models/MembershipPlan.js";
import { MEMBERSHIP_PLANS } from "../models/Member.js";
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

  // 1. The plans themselves.
  let created = 0;
  for (let i = 0; i < MEMBERSHIP_PLANS.length; i += 1) {
    const seed = MEMBERSHIP_PLANS[i];
    const existing = await MembershipPlan.findOne({ code: seed.code });
    if (existing) {
      console.log(`• Plan '${seed.code}' already exists`);
      continue;
    }

    await new MembershipPlan({
      code: seed.code,
      label: seed.label,
      months: seed.months,
      defaultFee: seed.defaultFee,
      // Personal Training is the one plan that needs a dedicated coach.
      requiresTrainer: seed.code === "PERSONAL_TRAINING",
      sequence: i + 1,
      isActive: true,
    }).save();
    console.log(`✅ Created plan: ${seed.code} — ${seed.label}`);
    created += 1;
  }
  console.log(`✅ ${created} plan(s) inserted`);

  // 2. Menu item. Prefer the "Master" group; fall back to "Gym".
  let menuGroup = await MenuGroupMaster.findOne({ menuGroupName: "Master" });
  if (menuGroup) {
    console.log("• Using menu group 'Master'");
  } else {
    menuGroup = await MenuGroupMaster.findOne({ menuGroupName: "Gym" });
    if (menuGroup) {
      console.log("• 'Master' group not found — using 'Gym'");
    } else {
      menuGroup = await new MenuGroupMaster({
        menuGroupName: "Gym",
        sequence: 1,
        isActive: true,
        isLink: false,
        menuUrl: "#",
        icon: "ri-heart-pulse-line",
      }).save();
      console.log("✅ Created menu group: Gym");
    }
  }

  let plansMenu = await MenuMaster.findOne({
    menuName: "Membership Plans",
    menuGroup: menuGroup._id,
  });
  if (!plansMenu) {
    plansMenu = await new MenuMaster({
      menuName: "Membership Plans",
      menuGroup: menuGroup._id,
      menuUrl: "/membership-plans",
      sequence: 3,
      isActive: true,
      isParent: false,
      parentMenu: null,
      icon: "ri-price-tag-3-line",
    }).save();
    console.log("✅ Created menu item: Membership Plans → /membership-plans");
  } else {
    console.log("• Menu item 'Membership Plans' already exists");
  }

  // 3. Grant the new menu to every existing role, so it is actually visible.
  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    const already = (role.roles || []).some(
      (r) => String(r.menuId) === String(plansMenu._id),
    );
    if (already) continue;

    role.roles.push({
      menuId: plansMenu._id,
      menuGroupId: menuGroup._id,
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
  console.log("✅ Done. Reload the admin panel to see the Membership Plans menu.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
