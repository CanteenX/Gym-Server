/**
 * Tidies the admin sidebar and moves the super admin login to its real address.
 *
 * Four things the owner reported, all of them fair:
 *
 * 1. Setup › "CMS" › "Email" › {Email For, Email Template, Email Setup}
 *    The parent is named CMS but everything under it is email configuration.
 *    It is also nested one level deeper than it needs to be. Renamed to "Email
 *    Settings" and the redundant middle "Email" node is removed by promoting
 *    its three children up to it.
 *
 * 2. Blog Master and Faq Master are not used by this gym. Hidden.
 *    NOTE: website FAQs are a different thing and stay - they live at
 *    /cms/faqs and feed the public site. These are the template's own blog and
 *    FAQ admin screens.
 *
 * 3. "Website" and "CMS" were two separate top-level groups covering the same
 *    subject, which is genuinely confusing: /website-pages edits the same
 *    SiteContent rows the /cms/* screens edit, just without the per-page
 *    permission split. Merged into one group named "Website".
 *
 * 4. The super admin logs in as websupport@barodaweb.net. Moved to the
 *    address the owner actually uses.
 *
 * WHY HIDE RATHER THAN DELETE: a menu row is referenced by every EmployeeRoles
 * permission row that grants it. Deleting the menu orphans those references,
 * which is the same shape as the dangling-roleId bug that silently took four
 * branch logins down. Setting isActive:false removes it from the sidebar and
 * from permission resolution, is reversible in one field, and leaves nothing
 * pointing at a document that no longer exists. The grants are stripped
 * separately so a hidden screen is not still granted to anyone.
 *
 *   node scripts/tidyAdminMenus.js            # dry run, prints every change
 *   node scripts/tidyAdminMenus.js --apply
 *
 * Idempotent: re-running once applied reports nothing to do.
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const NEW_SA_EMAIL = "nventra@gmail.com";

/**
 * Template screens this gym does not use, matched BY URL.
 *
 * Matching by menuName was tried first and was wrong: two rows are named
 * "FAQs" - Setup's /faq and the website's /cms/faqs - so a name match would
 * have hidden the CMS screen that feeds the public site's FAQ section, which
 * is content the owner does use. The dry run listed five rows where four were
 * intended, which is the only reason it was caught.
 *
 * "Faq Master" is a parent with url "#", so it is matched by name explicitly
 * and no other row shares that name.
 */
/**
 * /department joins the list on the owner's call.
 *
 * The two rows in it were "SuperAdmin" and "Gym Admin" — role names, not
 * departments, duplicating a concept the Roles screen already owns — and not
 * one of the four staff was assigned to either, so the Department column on
 * the Employee screen was blank for every row. Employee.departmentId is
 * already optional in the schema for exactly this reason: a branch admin is a
 * login, not an HR record.
 *
 * Hidden, not deleted, so a gym that later grows into needing departments gets
 * them back by flipping one field.
 */
const HIDE_URLS = ["/blog-master", "/faq-category", "/faq", "/department"];
const HIDE_PARENT_NAMES = ["Faq Master"];

await mongoose.connect(process.env.DATABASE);
const db = mongoose.connection.db;
const menus = db.collection("menumasters");
const groups = db.collection("menugroupmasters");
const roles = db.collection("employeeroles");
const company = db.collection("companymasters");

const planned = [];
const plan = (what) => planned.push(what);
const now = () => new Date();

// ── 1. Setup › CMS  ->  Setup › Email Settings, one level flatter ──────────
const misnamed = await menus.findOne({ menuName: "CMS", menuUrl: "#" });
if (misnamed) {
  const emailNode = await menus.findOne({ menuName: "Email", parentMenu: misnamed._id });
  plan(`rename menu "CMS" -> "Email Settings"`);
  if (APPLY) {
    await menus.updateOne({ _id: misnamed._id }, { $set: { menuName: "Email Settings", updatedAt: now() } });
  }
  if (emailNode) {
    const children = await menus.find({ parentMenu: emailNode._id }).toArray();
    plan(`promote ${children.length} email screen(s) up one level, drop the redundant "Email" node`);
    if (APPLY) {
      await menus.updateMany(
        { parentMenu: emailNode._id },
        { $set: { parentMenu: misnamed._id, updatedAt: now() } },
      );
      // Hidden, not deleted: permission rows may still reference it.
      await menus.updateOne({ _id: emailNode._id }, { $set: { isActive: false, updatedAt: now() } });
    }
  }
} else {
  plan(`(already done) no menu named "CMS" with url "#"`);
}

// ── 2. Hide the template's blog and FAQ admin screens ──────────────────────
const hideFilter = { $or: [{ menuUrl: { $in: HIDE_URLS } }, { menuName: { $in: HIDE_PARENT_NAMES }, menuUrl: "#" }] };
const toHide = await menus.find({ ...hideFilter, isActive: true }).toArray();
if (toHide.length) {
  plan(`hide ${toHide.length} unused screen(s): ${toHide.map((m) => `${m.menuName} [${m.menuUrl}]`).join(", ")}`);
  if (APPLY) {
    await menus.updateMany(
      { _id: { $in: toHide.map((m) => m._id) } },
      { $set: { isActive: false, updatedAt: now() } },
    );
  }
}
// Strip the grants too, so nothing still permits a screen nobody can see.
const hiddenIds = (await menus.find(hideFilter).toArray()).map((m) => String(m._id));
if (hiddenIds.length) {
  for (const r of await roles.find({}).toArray()) {
    const kept = (r.roles || []).filter((x) => !hiddenIds.includes(String(x.menuId)));
    if (kept.length !== (r.roles || []).length) {
      plan(`role ${r.roleId}: drop ${(r.roles || []).length - kept.length} grant(s) for hidden screens`);
      if (APPLY) {
        // save()-equivalent: bump updatedAt so checkPermission's staleness
        // comparison refreshes live sessions instead of waiting for a logout.
        await roles.updateOne({ _id: r._id }, { $set: { roles: kept, updatedAt: now() } });
      }
    }
  }
}

// ── 3. One "Website" group instead of "Website" + "CMS" ────────────────────
const websiteGroup = await groups.findOne({ menuGroupName: "Website" });
const cmsGroup = await groups.findOne({ menuGroupName: "CMS" });
if (websiteGroup && cmsGroup) {
  const moving = await menus.find({ menuGroup: websiteGroup._id }).toArray();
  plan(`move ${moving.length} menu(s) from the "Website" group into "CMS", then rename "CMS" -> "Website"`);
  plan(`  moving: ${moving.map((m) => m.menuName).join(", ")}`);
  if (APPLY) {
    // Sequence them after the existing CMS entries so the per-page screens
    // stay at the top and the advanced/all-pages tools sit below them.
    const maxSeq = (await menus.find({ menuGroup: cmsGroup._id, parentMenu: null }).toArray())
      .reduce((m, x) => Math.max(m, x.sequence || 0), 0);
    let seq = maxSeq;
    for (const m of moving) {
      seq += 1;
      await menus.updateOne(
        { _id: m._id },
        { $set: { menuGroup: cmsGroup._id, sequence: seq, updatedAt: now() } },
      );
    }
    await groups.updateOne({ _id: cmsGroup._id }, { $set: { menuGroupName: "Website", updatedAt: now() } });
    await groups.updateOne({ _id: websiteGroup._id }, { $set: { isActive: false, updatedAt: now() } });
  }
} else {
  plan(`(already done) only one of the Website/CMS groups exists`);
}

// ── 4. Super admin login address ───────────────────────────────────────────
const sa = await company.findOne({ isSuperAdmin: true });
if (sa && sa.email !== NEW_SA_EMAIL) {
  const clash = await company.countDocuments({ email: NEW_SA_EMAIL, _id: { $ne: sa._id } });
  if (clash) {
    plan(`REFUSING to move the super admin: ${NEW_SA_EMAIL} is already used by another account`);
  } else {
    plan(`super admin login ${sa.email} -> ${NEW_SA_EMAIL} (password unchanged)`);
    if (APPLY) {
      await company.updateOne({ _id: sa._id }, { $set: { email: NEW_SA_EMAIL, updatedAt: now() } });
    }
  }
} else if (sa) {
  plan(`(already done) super admin is ${sa.email}`);
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — ${planned.length} item(s):`);
for (const p of planned) console.log(`  ${p}`);
if (!APPLY) console.log("\nRe-run with --apply to write.");

await mongoose.disconnect();
