import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

const NOTIFICATION_MENU = {
  menuName: "Notification Centre",
  menuUrl: "/notification-centre",
  sequence: 22,
  icon: "ri-notification-3-line",
};

export const seedNotificationMenu = async () => {
  const existingGroup = await MenuGroupMaster.findOne({
    $or: [{ menuUrl: NOTIFICATION_MENU.menuUrl }, { menuGroupName: NOTIFICATION_MENU.menuName }],
  });

  if (existingGroup) {
    console.log(`ℹ️ Menu Group "${NOTIFICATION_MENU.menuName}" already exists at ${NOTIFICATION_MENU.menuUrl}`);
    return;
  }

  if (!APPLY) {
    console.log(`[DRY RUN] Would seed separate top-level menu "${NOTIFICATION_MENU.menuName}" at ${NOTIFICATION_MENU.menuUrl}`);
    console.log("Re-run with --apply to commit.");
    return;
  }

  const newGroup = new MenuGroupMaster({
    menuGroupName: NOTIFICATION_MENU.menuName,
    sequence: 3,
    isActive: true,
    isLink: true,
    menuUrl: NOTIFICATION_MENU.menuUrl,
    icon: NOTIFICATION_MENU.icon,
  });

  await newGroup.save();

  // Also create MenuMaster record linked to the group
  const newMenu = new MenuMaster({
    menuName: NOTIFICATION_MENU.menuName,
    menuGroup: newGroup._id,
    menuUrl: NOTIFICATION_MENU.menuUrl,
    sequence: 1,
    isActive: true,
    isParent: false,
    parentMenu: null,
    icon: NOTIFICATION_MENU.icon,
  });

  await newMenu.save();
  console.log(`✅ Seeded separate top-level menu "${NOTIFICATION_MENU.menuName}" (isLink: true)`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI missing in environment");
    process.exit(1);
  }
  await mongoose.connect(uri);
  await seedNotificationMenu();
  await mongoose.disconnect();
}
