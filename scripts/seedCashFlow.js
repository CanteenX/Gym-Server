/**
 * One-off seed for the cash-flow feature:
 *   1. the default expense categories
 *   2. an "Accounts" menu group with Cash Flow + Expense Categories items
 *   3. permissions for those menus on every existing role
 *
 * Run from the Gym Server directory:  node scripts/seedCashFlow.js
 * Safe to re-run — every step checks for an existing document first.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import ExpenseCategory, {
  DEFAULT_EXPENSE_CATEGORIES,
} from "../models/ExpenseCategory.js";

dotenv.config();

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  // ---- 1. Expense categories ----
  let createdCats = 0;
  for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
    const exists = await ExpenseCategory.findOne({ name: cat.name });
    if (!exists) {
      await new ExpenseCategory(cat).save();
      createdCats += 1;
    }
  }
  console.log(
    `✅ Expense categories: ${createdCats} created, ${
      DEFAULT_EXPENSE_CATEGORIES.length - createdCats
    } already present`,
  );

  // ---- 2. Menu group ----
  let group = await MenuGroupMaster.findOne({ menuGroupName: "Accounts" });
  if (!group) {
    group = await new MenuGroupMaster({
      menuGroupName: "Accounts",
      sequence: 2,
      isActive: true,
      isLink: false,
      menuUrl: "#",
      icon: "ri-wallet-3-line",
    }).save();
    console.log("✅ Created menu group: Accounts");
  } else {
    console.log("• Menu group 'Accounts' already exists");
  }

  // ---- 3. Menu items ----
  const items = [
    {
      menuName: "Cash Flow",
      menuUrl: "/cash-flow",
      sequence: 1,
      icon: "ri-exchange-funds-line",
    },
    {
      menuName: "Expense Categories",
      menuUrl: "/expense-categories",
      sequence: 2,
      icon: "ri-price-tag-3-line",
    },
  ];

  const menuIds = [];
  for (const item of items) {
    let menu = await MenuMaster.findOne({
      menuName: item.menuName,
      menuGroup: group._id,
    });
    if (!menu) {
      menu = await new MenuMaster({
        ...item,
        menuGroup: group._id,
        isActive: true,
        isParent: false,
        parentMenu: null,
      }).save();
      console.log(`✅ Created menu item: ${item.menuName} → ${item.menuUrl}`);
    } else {
      console.log(`• Menu item '${item.menuName}' already exists`);
    }
    menuIds.push(menu._id);
  }

  // ---- 4. Permissions ----
  const roles = await EmployeeRoles.find({});
  let updated = 0;
  for (const role of roles) {
    let changed = false;
    for (const menuId of menuIds) {
      const already = (role.roles || []).some(
        (r) => String(r.menuId) === String(menuId),
      );
      if (already) continue;
      role.roles.push({
        menuId,
        menuGroupId: group._id,
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
    `✅ Menu permissions granted to ${updated} role(s) (${roles.length} total)`,
  );

  await mongoose.disconnect();
  console.log("✅ Done. Reload the admin panel to see the Accounts menu.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
