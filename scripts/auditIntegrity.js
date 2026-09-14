/**
 * Sweeps for the class of bug that took four branch logins down without
 * anything erroring: a reference that still LOOKS right but resolves to
 * nothing at run time.
 *
 * The RBAC failure was invisible because every surface lied consistently. The
 * EmployeeRoles rows existed, the roleId field was linked correctly, and
 * /auth/me returned the raw ObjectId, so the sidebar rendered a full menu of
 * screens the user was then 403'd out of. Only .populate() noticed, and only
 * at login. Nothing threw, nothing logged, and a spot check passed by picking
 * a route that carries no permission check.
 *
 * So this does not read code and reason about it. It resolves every reference
 * against the live database the way the server does, and reports what does not
 * come back.
 *
 *   node scripts/auditIntegrity.js
 *
 * Read-only. Writes nothing, ever.
 */
import "dotenv/config";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

const problems = [];
const notes = [];
const ok = [];

const fail = (area, detail) => problems.push(`${area}: ${detail}`);
const note = (area, detail) => notes.push(`${area}: ${detail}`);
const pass = (area, detail) => ok.push(`${area}: ${detail}`);

await mongoose.connect(process.env.DATABASE);
const db = mongoose.connection.db;
const col = (n) => db.collection(n);

/** Collection names vary by pluralisation; resolve once rather than guess. */
const names = (await db.listCollections().toArray()).map((c) => c.name);
const find = (...candidates) => candidates.find((c) => names.includes(c));

const C = {
  employee: find("employees", "employee"),
  companyMaster: find("companymasters", "companymaster"),
  employeeRoles: find("employeeroles", "employeerole"),
  roleMaster: find("rolemasters", "rolemaster"),
  menuMaster: find("menumasters", "menumaster"),
  menuGroup: find("menugroupmasters", "menugroupmaster"),
  member: find("members", "member"),
  branch: find("branchmasters", "branches", "branchmaster"),
  transaction: find("transactions", "transaction"),
  attendance: find("attendances", "attendance"),
  workoutPlan: find("workoutplans", "workoutplan"),
  siteItem: find("siteitems", "siteitem"),
  siteContent: find("sitecontents", "sitecontent"),
  department: find("departments", "department", "departmentmasters"),
};

// ── 1. Dangling references, resolved not assumed ───────────────────────────
// Every one of these is the same shape as the RBAC bug: an ObjectId that
// points at a document nobody ever created.
const refChecks = [
  { from: C.employee, field: "roleId", to: C.roleMaster, label: "Employee.roleId -> RoleMaster" },
  { from: C.employeeRoles, field: "roleId", to: C.roleMaster, label: "EmployeeRoles.roleId -> RoleMaster" },
  { from: C.member, field: "workoutPlanId", to: C.workoutPlan, label: "Member.workoutPlanId -> WorkoutPlan" },
  // `menuGroup`, NOT `menuGroupId`. This read menuGroupId until 2026-09-14,
  // which is not a field models/MenuMaster.js declares — so `distinct` came
  // back empty, the loop printed "no references to check", and the sweep
  // reported a PASS for a check it had never once performed. That is why the
  // misconfiguration guard below exists.
  { from: C.menuMaster, field: "menuGroup", to: C.menuGroup, label: "MenuMaster.menuGroup -> MenuGroup" },
  { from: C.menuMaster, field: "parentMenu", to: C.menuMaster, label: "MenuMaster.parentMenu -> MenuMaster" },
  // Optional on purpose (a branch admin is a login, not an HR record), so an
  // absent departmentId is normal — a departmentId pointing at nothing is not.
  { from: C.employee, field: "departmentId", to: C.department, label: "Employee.departmentId -> Department" },
];

for (const { from, field, to, label } of refChecks) {
  if (!from || !to) { note("refs", `skipped ${label} (collection missing)`); continue; }

  /**
   * Does this field exist on ANY document at all?
   *
   * A check aimed at a field nobody writes cannot fail, and the empty-result
   * branch below reads as a clean pass. That is exactly how the menuGroupId
   * typo above survived every previous sweep: the audit's own green tick was
   * the evidence that nothing was wrong with it. An always-empty field is a
   * misconfigured check, not a healthy collection, and it has to be louder
   * than the thing it was meant to catch.
   *
   * A genuinely optional field that simply nobody has filled in yet lands
   * here too. That is the right trade: "this check is currently proving
   * nothing" is worth saying either way.
   */
  const everSet = await col(from).countDocuments({ [field]: { $exists: true } }, { limit: 1 });
  if (!everSet) {
    fail("refs", `${label} — NO document in ${from} has a "${field}" field. The check is proving nothing: either the field name is wrong, or nothing writes it.`);
    continue;
  }

  const ids = await col(from).distinct(field, { [field]: { $ne: null } });
  if (!ids.length) { pass("refs", `${label} — field present but every value is null`); continue; }
  const present = await col(to).distinct("_id", { _id: { $in: ids } });
  const presentSet = new Set(present.map(String));
  const missing = ids.filter((id) => !presentSet.has(String(id)));
  if (missing.length) {
    const holders = await col(from)
      .find({ [field]: { $in: missing } }, { projection: { email: 1, name: 1, title: 1 } })
      .limit(8).toArray();
    fail("refs", `${label} — ${missing.length} dangling: ${holders.map((h) => h.emailOffice || h.email || h.employeeName || h.name || h.title || h._id).join(", ")}`);
  } else {
    pass("refs", `${label} — all ${ids.length} resolve`);
  }
}

// ── 2. Routes that checkPermission gates but no menu row backs ─────────────
// /currency-master is already known to be in this state: gated, unseeded, so
// every non-super-admin gets "Menu not found" while the super admin bypasses
// and never sees it.
const routeFiles = fs.readdirSync("routes/v1").filter((f) => f.endsWith(".js"));
const gated = new Set();
for (const f of routeFiles) {
  const src = fs.readFileSync(path.join("routes/v1", f), "utf8");
  // checkPermission("/thing", ...) — first string argument is the menu url.
  for (const m of src.matchAll(/checkPermission\(\s*["'`](\/[^"'`]+)["'`]/g)) gated.add(m[1]);
}
/**
 * ACTIVE rows only.
 *
 * checkPermission does not merely look the url up, it resolves an ACTIVE menu
 * — so a row that exists but is switched off 403s every non-super-admin
 * exactly as a missing row does, while a plain existence check sees it and
 * says everything is fine. The super admin bypasses and never notices, which
 * is precisely the failure mode this whole sweep was written to catch.
 *
 * Deactivating a menu row is therefore not a cosmetic act: it silently
 * revokes every route gated on that url.
 */
const activeMenuUrls = new Set(
  (await col(C.menuMaster).distinct("menuUrl", { isActive: { $ne: false } })).filter(Boolean),
);
const allMenuUrls = new Set((await col(C.menuMaster).distinct("menuUrl")).filter(Boolean));

/**
 * Urls whose menu row is inactive ON PURPOSE, with the consequence accepted.
 *
 * An entry here is a decision, not a suppression: it says "this screen is
 * hidden deliberately, and we have checked what that switches off". Anything
 * NOT listed still FAILs, so the check keeps its teeth for the accidental
 * case — which is the one that actually hurts.
 */
const DELIBERATELY_HIDDEN_MENUS = {
  "/department":
    "Department screen hidden on purpose (this is a gym, not an HR system). " +
    "Its three READS were un-gated and are now plain staff lookups, because " +
    "the Employee form's dropdown depends on them. The remaining write/edit/" +
    "delete gates gating to super-admin-only is the intended effect of hiding " +
    "the screen. See routes/v1/departments.routes.js.",
};

const gatedWithoutMenu = [...gated].filter((u) => !allMenuUrls.has(u));
// Present but switched off — reported separately, because the fix differs:
// one needs seeding, the other needs reactivating.
const inactiveGated = [...gated].filter((u) => allMenuUrls.has(u) && !activeMenuUrls.has(u));
const gatedButInactive = inactiveGated.filter((u) => !DELIBERATELY_HIDDEN_MENUS[u]);
for (const u of inactiveGated.filter((u) => DELIBERATELY_HIDDEN_MENUS[u])) {
  note("menus", `${u} is gated on an inactive menu BY DESIGN — ${DELIBERATELY_HIDDEN_MENUS[u]}`);
}

if (gatedWithoutMenu.length) {
  fail("menus", `gated by checkPermission but absent from MenuMaster (every non-super-admin gets "Menu not found"): ${gatedWithoutMenu.join(", ")}`);
}
if (gatedButInactive.length) {
  fail("menus", `gated by checkPermission and present in MenuMaster but INACTIVE — 403s every non-super-admin just as a missing row does: ${gatedButInactive.join(", ")}`);
}
if (!gatedWithoutMenu.length && !gatedButInactive.length && gated.size) {
  pass("menus", `all ${gated.size} checkPermission menu urls have an ACTIVE MenuMaster row`);
} else if (!gated.size) {
  note("menus", "no inline checkPermission menu urls found — it resolves by request path");
}

// ── 3. Admin routes vs menu urls ───────────────────────────────────────────
// A menu url with no screen is a dead sidebar entry; a /cms/* screen with no
// menu row silently falls back to the all-pages grant, which is how a CMS
// screen stops being per-page permissioned without anything erroring.
const adminRoutes = path.resolve("../Gym-Admin/src/Routes/allRoutes.jsx");
if (fs.existsSync(adminRoutes)) {
  const src = fs.readFileSync(adminRoutes, "utf8");
  const declared = new Set([...src.matchAll(/path:\s*["'`](\/[^"'`]*)["'`]/g)].map((m) => m[1]));
  const cmsMenus = [...activeMenuUrls].filter((u) => u.startsWith("/cms/"));
  const cmsWithoutScreen = cmsMenus.filter((u) => !declared.has(u));
  if (cmsWithoutScreen.length) {
    fail("cms", `menu row exists but no admin screen (sidebar entry 404s): ${cmsWithoutScreen.join(", ")}`);
  } else {
    pass("cms", `all ${cmsMenus.length} /cms/* menu rows have a matching admin route`);
  }
  const cmsScreensWithoutMenu = [...declared].filter((u) => u.startsWith("/cms/") && !activeMenuUrls.has(u));
  if (cmsScreensWithoutMenu.length) {
    fail("cms", `admin screen exists but no menu row (falls back to the all-pages grant): ${cmsScreensWithoutMenu.join(", ")}`);
  }
} else {
  note("cms", "Gym-Admin not beside this repo — skipped route cross-check");
}

// ── 4. Branch values that no branch row backs ──────────────────────────────
// Branch is a free string on Employee and Member. A typo scopes a user to a
// branch that does not exist, which reads as "sees nothing" rather than as an
// error.
if (C.branch) {
  const known = new Set((await col(C.branch).distinct("name")).filter(Boolean));
  known.add("Common"); // the deliberate third value for shared financials
  for (const [label, cname] of [["Employee", C.employee], ["Member", C.member], ["Transaction", C.transaction]]) {
    if (!cname) continue;
    const used = (await col(cname).distinct("branch")).filter((b) => b !== null && b !== undefined && b !== "");
    const unknown = used.filter((b) => !known.has(b));
    if (unknown.length) fail("branch", `${label}.branch has values no BranchMaster row matches: ${unknown.join(", ")}`);
    else pass("branch", `${label}.branch — all ${used.length} value(s) known`);
  }
}

// ── 5. Accounts that cannot actually log in ────────────────────────────────
// The exact failure that hid: active account, roleId present, role row absent.
if (C.employee && C.employeeRoles) {
  const who = (e) => e.emailOffice || e.email || e.employeeName || e._id;
  const staff = await col(C.employee).find({ isActive: { $ne: false } }).toArray();
  const broken = [];
  for (const e of staff) {
    if (!e.roleId) { if (!e.isSuperAdmin) broken.push(`${who(e)} (no roleId)`); continue; }
    const perms = await col(C.employeeRoles).findOne({ roleId: e.roleId, isActive: true });
    // The array is `roles`, and the login email is `emailOffice`. Both were
    // guessed wrong on the first pass of this script and it reported five
    // healthy accounts as locked out - the same shape of mistake it exists to
    // catch, which is why it now reads the field names off the documents.
    const n = perms?.roles?.length || 0;
    if (!n && !e.isSuperAdmin) broken.push(`${who(e)} (0 permissions at login)`);
  }
  if (broken.length) fail("login", `active staff who would land a session with no permissions: ${broken.join(", ")}`);
  else pass("login", `all ${staff.length} active staff resolve a non-empty permission set`);
}

// ── 6. Super admin really is super ─────────────────────────────────────────
if (C.companyMaster) {
  const sas = await col(C.companyMaster).find({ isSuperAdmin: true }).toArray();
  if (!sas.length) fail("superadmin", "no CompanyMaster row has isSuperAdmin: true — nobody can reach the CMS");
  else {
    const active = sas.filter((s) => s.isActive !== false);
    if (!active.length) fail("superadmin", `${sas.length} super admin(s) exist but all are inactive`);
    else pass("superadmin", `${active.length} active: ${active.map((s) => s.email).join(", ")}`);
  }
}

// ── 7. CMS rows the frontend asks for ──────────────────────────────────────
if (C.siteItem) {
  const counts = {};
  for (const k of await col(C.siteItem).distinct("collectionKey")) {
    counts[k] = await col(C.siteItem).countDocuments({ collectionKey: k, isActive: { $ne: false } });
  }
  const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
  if (empty.length) note("cms-data", `collections with no active rows (the site falls back to site.ts): ${empty.join(", ")}`);
  pass("cms-data", Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" "));
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log("\n".padEnd(1) + "=".repeat(64));
for (const o of ok) console.log(`  ok    ${o}`);
if (notes.length) { console.log("\n  -- notes --"); for (const n of notes) console.log(`  note  ${n}`); }
console.log("=".repeat(64));
if (problems.length) {
  console.log(`\n  ${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  FAIL  ${p}`);
} else {
  console.log("\n  No integrity problems found.");
}
await mongoose.disconnect();
process.exit(problems.length ? 1 : 0);
