/**
 * Creates the super-admin account and the Branch Admin role.
 *
 * WHY THE PASSWORD COMES FROM .env:
 * this account owns both branches and every rupee of financial data. Passing it
 * on the command line would put it in shell history; hardcoding it would put it
 * in git — and this repository is public. Reading it from the environment keeps
 * it in exactly one place the operator already controls.
 *
 * USAGE
 *   1. Add to Gym Server/.env:
 *        SUPERADMIN_PASSWORD=<choose something long>
 *   2. From the Gym Server directory:
 *        node scripts/seedSuperAdmin.js
 *   3. Delete the line from .env afterwards if you prefer — it is only read here.
 *
 * Safe to re-run: every step checks for an existing document first. Re-running
 * will NOT reset the password of an account that already exists, because that
 * would silently undo a password the operator changed by hand.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import Employee from "../models/Employee.js";
import RoleMaster from "../models/RoleMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import MenuMaster from "../models/MenuMaster.js";
import MenuGroupMaster from "../models/MenuGroupMaster.js";

dotenv.config();

const SUPER_ADMIN_EMAIL = "websupport@barodaweb.net";
const SUPER_ADMIN_NAME = "Mid City Gym Super Admin";
const BRANCH_ADMIN_ROLE = "Branch Admin";

/**
 * Menus a branch admin must NOT reach.
 *
 * These two edit the permission system itself: with access here a branch admin
 * could grant themselves the other branch, which would make branch scoping
 * decorative. Everything else is allowed, per the agreed scope.
 */
const FORBIDDEN_FOR_BRANCH_ADMIN = ["Employee Roles", "Menu Master"];

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  const password = process.env.SUPERADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      "❌ SUPERADMIN_PASSWORD is not set in .env, or is shorter than 8 characters.\n" +
        "   Add a line to Gym Server/.env, then re-run:\n" +
        "     SUPERADMIN_PASSWORD=your-chosen-password",
    );
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  // ===== 1. A role for the super admin =====
  // Employee.roleId is required, so the account needs a role even though
  // isSuperAdmin is what actually grants its reach.
  let superRole = await RoleMaster.findOne({ roleName: "Super Admin" });
  if (!superRole) {
    superRole = await new RoleMaster({
      roleName: "Super Admin",
      isActive: true,
      createdBy: null,
    }).save();
    console.log("✅ Created role: Super Admin");
  } else {
    console.log("• Role 'Super Admin' already exists");
  }

  // ===== 2. The super-admin account =====
  const existing = await Employee.findOne({ emailOffice: SUPER_ADMIN_EMAIL });
  if (existing) {
    console.log(
      `• ${SUPER_ADMIN_EMAIL} already exists — password left untouched.\n` +
        "  Delete the Employee record first if you need to re-seed it.",
    );
  } else {
    const hash = await bcrypt.hash(password, 10);
    await new Employee({
      employeeName: SUPER_ADMIN_NAME,
      emailOffice: SUPER_ADMIN_EMAIL,
      password: hash,
      roleId: superRole._id,
      // branch null = every branch. isSuperAdmin is the explicit flag the
      // scoping middleware reads.
      branch: null,
      isSuperAdmin: true,
      isActive: true,
    }).save();
    console.log(`✅ Created super admin: ${SUPER_ADMIN_EMAIL}`);
  }

  // ===== 3. The Branch Admin role =====
  let branchRole = await RoleMaster.findOne({ roleName: BRANCH_ADMIN_ROLE });
  if (!branchRole) {
    branchRole = await new RoleMaster({
      roleName: BRANCH_ADMIN_ROLE,
      isActive: true,
      createdBy: null,
    }).save();
    console.log(`✅ Created role: ${BRANCH_ADMIN_ROLE}`);
  } else {
    console.log(`• Role '${BRANCH_ADMIN_ROLE}' already exists`);
  }

  // ===== 4. Branch Admin permissions =====
  // Everything except the two permission-system screens.
  const allMenus = await MenuMaster.find({ isActive: true }).lean();
  const groups = await MenuGroupMaster.find({}).lean();
  const groupById = new Map(groups.map((g) => [String(g._id), g]));

  const granted = allMenus.filter(
    (m) => !FORBIDDEN_FOR_BRANCH_ADMIN.includes(m.menuName),
  );
  const withheld = allMenus.filter((m) =>
    FORBIDDEN_FOR_BRANCH_ADMIN.includes(m.menuName),
  );

  let branchPerms = await EmployeeRoles.findOne({ roleId: branchRole._id });
  if (!branchPerms) {
    branchPerms = new EmployeeRoles({ roleId: branchRole._id, roles: [] });
  }

  let added = 0;
  for (const menu of granted) {
    const already = (branchPerms.roles || []).some(
      (r) => String(r.menuId) === String(menu._id),
    );
    if (already) continue;

    branchPerms.roles.push({
      menuId: menu._id,
      menuGroupId: menu.menuGroup,
      read: true,
      write: true,
      edit: true,
      delete: true,
      print: true,
      mail: true,
    });
    added += 1;
  }
  await branchPerms.save();

  console.log(
    `✅ Branch Admin granted ${added} new menu(s); ${granted.length} total permitted`,
  );
  console.log(
    `   Withheld deliberately: ${
      withheld.map((m) => m.menuName).join(", ") || "(none found)"
    }`,
  );
  if (groupById.size === 0) {
    console.log("   (no menu groups found — check MenuGroupMaster)");
  }

  // ===== 5. What still needs a human =====
  const unscoped = await Employee.countDocuments({
    $or: [{ branch: null }, { branch: { $exists: false } }],
    isSuperAdmin: { $ne: true },
  });

  console.log("\n───────────────────────────────────────────────");
  console.log(`Log in as: ${SUPER_ADMIN_EMAIL}`);
  console.log("Password:  the SUPERADMIN_PASSWORD you set in .env");
  console.log("───────────────────────────────────────────────");
  if (unscoped > 0) {
    console.log(
      `\n⚠️  ${unscoped} existing staff account(s) have no branch, which currently\n` +
        "   reads as ALL BRANCHES. Assign each a branch in Setup → Employee,\n" +
        "   or leave them if they are meant to see everything.\n" +
        "   This was left as a manual step on purpose: defaulting them\n" +
        "   automatically could scope you out of your own working login.",
    );
  }

  await mongoose.disconnect();
  console.log("\n✅ Done.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
