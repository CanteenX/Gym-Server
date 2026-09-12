/**
 * Menu seeds for the FAQ and "Help and Guide" screens.
 *
 * These used to run inline on every server boot. A serverless deployment cold-
 * starts constantly, so running them there would re-issue both seeds on every
 * scale-out; they live here instead and run once per release from CI
 * (npm run seed:menus), while the long-running PM2 process still calls them at
 * boot through the exports below.
 *
 * Both functions are idempotent - they look each row up before creating it.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import MenuMaster from "../models/MenuMaster.js";
import { seedWebsiteMenus } from "./seedWebsiteMenus.js";

const seedFaqMenus = async () => {
  try {
    const setupGroup = await MenuGroupMaster.findOne({ menuGroupName: "Setup" });
    if (!setupGroup) {
      console.log("⚠️ Setup menu group not found. Cannot seed FAQ menus.");
      return;
    }

    // 1. Create or Find "Faq Master" parent menu under Setup
    let faqMasterMenu = await MenuMaster.findOne({
      menuName: "Faq Master",
      menuGroup: setupGroup._id,
    });

    if (!faqMasterMenu) {
      faqMasterMenu = new MenuMaster({
        menuName: "Faq Master",
        menuGroup: setupGroup._id,
        menuUrl: "#",
        sequence: 6,
        isActive: true,
        isParent: true,
        parentMenu: null,
        icon: "ri-question-answer-line",
      });
      await faqMasterMenu.save();
      console.log("✅ Seeded parent FAQ Master menu");
    }

    // 2. Create or Find "FAQ Categories" child menu
    let faqCategoryMenu = await MenuMaster.findOne({
      menuName: "FAQ Categories",
      parentMenu: faqMasterMenu._id,
    });

    if (!faqCategoryMenu) {
      faqCategoryMenu = new MenuMaster({
        menuName: "FAQ Categories",
        menuGroup: setupGroup._id,
        menuUrl: "/faq-category",
        sequence: 1,
        isActive: true,
        isParent: false,
        parentMenu: faqMasterMenu._id,
      });
      await faqCategoryMenu.save();
      console.log("✅ Seeded child FAQ Categories menu");
    }

    // 3. Create or Find "FAQs" child menu
    let faqsMenu = await MenuMaster.findOne({
      menuName: "FAQs",
      parentMenu: faqMasterMenu._id,
    });

    if (!faqsMenu) {
      faqsMenu = new MenuMaster({
        menuName: "FAQs",
        menuGroup: setupGroup._id,
        menuUrl: "/faq",
        sequence: 2,
        isActive: true,
        isParent: false,
        parentMenu: faqMasterMenu._id,
      });
      await faqsMenu.save();
      console.log("✅ Seeded child FAQs menu");
    }
  } catch (err) {
    console.error("❌ Error seeding FAQ menus =>", err);
  }
};

const seedHelpAndGuideMenus = async () => {
  try {
    let helpGroup = await MenuGroupMaster.findOne({ menuGroupName: "Help and Guide" });
    if (!helpGroup) {
      helpGroup = new MenuGroupMaster({
        menuGroupName: "Help and Guide",
        sequence: 5,
        isActive: true,
        isLink: false,
        menuUrl: "#",
        icon: "ri-customer-service-line",
      });
      await helpGroup.save();
      console.log("✅ Seeded Help and Guide menu group");
    }

    let guidesGalleryMenu = await MenuMaster.findOne({
      menuName: "Guides Gallery",
      menuGroup: helpGroup._id,
    });

    if (!guidesGalleryMenu) {
      guidesGalleryMenu = new MenuMaster({
        menuName: "Guides Gallery",
        menuGroup: helpGroup._id,
        menuUrl: "/guides-gallery",
        sequence: 1,
        isActive: true,
        isParent: false,
        parentMenu: null,
      });
      await guidesGalleryMenu.save();
      console.log("✅ Seeded Guides Gallery menu");
    }

    let manageGuidesMenu = await MenuMaster.findOne({
      menuName: "Manage Guides",
      menuGroup: helpGroup._id,
    });

    if (!manageGuidesMenu) {
      manageGuidesMenu = new MenuMaster({
        menuName: "Manage Guides",
        menuGroup: helpGroup._id,
        menuUrl: "/manage-guides",
        sequence: 2,
        isActive: true,
        isParent: false,
        parentMenu: null,
      });
      await manageGuidesMenu.save();
      console.log("✅ Seeded Manage Guides menu");
    }
  } catch (err) {
    console.error("❌ Error seeding Help and Guide menus =>", err);
  }
};
export { seedFaqMenus, seedHelpAndGuideMenus };

export async function seedAllMenus() {
  await seedFaqMenus();
  await seedHelpAndGuideMenus();
  // The Website screens differ from every other gym route: site.routes.js DOES
  // apply checkPermission, which 403s when the menu row is absent. Boot-time
  // seeding is therefore what keeps those screens reachable on the PM2
  // deployment; the serverless pipeline runs `npm run seed:website-menus`.
  try {
    await seedWebsiteMenus();
  } catch (err) {
    console.error("❌ Error seeding Website menus =>", err);
  }
}

// Direct execution (npm run seed:menus) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedMenus.js")) {
  dotenv.config();
  try {
    await mongoose.connect(process.env.DATABASE, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ DB connected");
    await seedAllMenus();
    console.log("✅ Menu seeding complete");
    process.exit(0);
  } catch (err) {
    console.error("❌ Menu seeding failed =>", err);
    process.exit(1);
  }
}
