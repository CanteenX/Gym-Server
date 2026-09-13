/**
 * Grants branch-level roles the screens a branch admin needs to run their own
 * gym, now that `role === "ADMIN"` no longer bypasses the permission system.
 *
 * ============================================================================
 * READ THIS BEFORE RUNNING IT.
 * ============================================================================
 *
 * checkPermission and cmsPermission used to short-circuit on
 * `req.session.user.role === "ADMIN"`. That is a statement about which table an
 * account lives in, not about how much it may do, so every branch-level
 * CompanyMaster admin bypassed the entire RBAC system. Those gates now
 * short-circuit on `isSuperAdmin` instead (middlewares/superAdmin.js), which
 * has two consequences this script exists to manage:
 *
 *   1. A MENU GRANTED TO NOBODY IS NOW SUPER-ADMIN-ONLY, AUTOMATICALLY. That
 *      is the mechanism the owner asked for, not a side effect. It is why the
 *      CMS (/cms/*, /website-pages), the SEO manager, the website screens and
 *      the audit log are absent from the grant tables below and must STAY
 *      absent: leaving them ungranted is what keeps them the owner's alone.
 *
 *   2. Three screens a branch admin plausibly SHOULD run are currently granted
 *      to nobody and would therefore become super-admin-only by accident rather
 *      than by decision: /attendance-overview, /reports and /class-sessions.
 *      All three are already branch-scoped in the controllers — a Vasna admin
 *      cannot see Gotri through any of them, and financialScopeFilter keeps the
 *      shared "Common" cost bucket out of a single branch's P&L — so granting
 *      them widens what a branch admin may DO without widening what they may
 *      SEE. That is the whole grant this script applies.
 *
 * WHAT IT DOES NOT GRANT, ON PURPOSE:
 *   - /cms/*, /website-pages, /website-adverts, /website-leads, /seo-manager,
 *     /audit-log — see (1).
 *   - /employee-roles and /role-master. A CompanyMaster-table branch admin
 *     editing role permissions is NOT subject to the "you cannot give more
 *     permissions than you have yourself" check that constrains an EMPLOYEE
 *     (see checkUpdatePermissions in controllers/v1/employeeRoles.controller.js
 *     — the ADMIN branch only verifies the target role was not created by an
 *     employee). Granting those two would hand a branch a route back to the CMS
 *     by self-service. The super admin can still tick them per role by hand if
 *     they decide otherwise.
 *
 * SAFE BY DEFAULT: this script PRINTS THE PLAN AND WRITES NOTHING unless you
 * pass --apply. Idempotent either way — a role that already holds a row for a
 * menu is left exactly as it is, including its existing action flags, so
 * re-running never widens or narrows a grant somebody tuned by hand.
 *
 * Run from the Gym-Server directory:
 *     node scripts/seedBranchRolePermissions.js              # dry run
 *     node scripts/seedBranchRolePermissions.js --apply      # write
 *     node scripts/seedBranchRolePermissions.js --apply --adopt-company-admins
 *
 * PREREQUISITE: the menu rows must exist. checkPermission resolves a menu BY
 * URL and a missing MenuMaster row is a 403 ("Menu '/reports' not found"), not
 * a fallback. If this script reports a menu as missing, run
 * `npm run seed:insights-menus` and/or `npm run seed:class-menus` first.
 *
 * SEE ALSO scripts/repairRbac.js (`npm run repair:rbac`), which owns the three
 * things this script cannot:
 *
 *   - THE ROLE ROW ITSELF. This script tops up an EmployeeRoles document but
 *     never checks that a RoleMaster row exists at its `roleId`. `loginEmployee`
 *     does `.populate("roleId")`, and populate NULLS a dangling reference — so
 *     an account whose roleId names no RoleMaster lands a session with
 *     `roleId: null` and zero permissions, while the sidebar (which reads the
 *     un-populated id from /auth/me) still shows every screen. All four branch
 *     accounts were in exactly that state; repairRbac.js creates the missing
 *     RoleMaster AT THE EXISTING _id, which is the only fix that does not
 *     re-point a link.
 *
 *   - REVOKING. RESERVED_TO_SUPER_ADMIN below is asserted only against the rows
 *     THIS script adds. A reserved menu ticked on by hand through the Employee
 *     Roles screen is invisible to that assertion, and /employee-roles and
 *     /role-master had both been added that way. repairRbac.js removes them.
 *
 *   - The `/cms/*` DENY BY PREFIX. The list below is a fixed array; config/
 *     cmsMenus.js keeps growing, so repairRbac.js matches the prefix instead
 *     and covers CMS screens seeded after this file was last edited.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuMaster from "../models/MenuMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import RoleMaster from "../models/RoleMaster.js";
import Employee from "../models/Employee.js";
import CompanyMaster from "../models/CompanyMaster.js";

dotenv.config();

const ACTIONS = ["read", "write", "edit", "delete", "print", "mail"];

/** Every flag false; grant tables below only list what they turn on. */
const NONE = Object.fromEntries(ACTIONS.map((a) => [a, false]));
const grant = (...on) => ({ ...NONE, ...Object.fromEntries(on.map((a) => [a, true])) });

/**
 * THE GRANT: what every existing branch role gains.
 *
 * Actions are chosen per screen rather than "all six everywhere":
 *   /reports          read + print — print is the flag the CSV export routes
 *                     check, and a download leaving the building is a separate
 *                     decision from reading a number on screen. Still branch-
 *                     scoped, and "Common" stays unreachable.
 *   /attendance-overview  read ONLY. The screen has exactly one write,
 *                     POST /attendance/:id/mark-allowed behind
 *                     checkPermission("/attendance-overview", "edit") — that is
 *                     overriding a system refusal in a member's favour, usually
 *                     with money behind it. It belongs to whoever runs the
 *                     front desk, so the super admin ticks it per role.
 *   /class-sessions   full CRUD. Running your own branch's timetable is the
 *                     day job, and every route is pinned by scopeFilter(req):
 *                     a Gotri admin asking for a Vasna class gets a 404.
 */
const BRANCH_GRANTS = {
  "/attendance-overview": grant("read"),
  "/reports": grant("read", "print"),
  "/class-sessions": grant("read", "write", "edit", "delete"),
};

/**
 * The baseline for a branch role being CREATED from nothing by
 * --adopt-company-admins. Existing roles are never reshaped to match this.
 *
 * Operational screens only. Most of them are not even gated by checkPermission
 * on the server (the gym routes deliberately carry no permission middleware —
 * see CLAUDE.md), but the admin panel builds its sidebar and its client-side
 * route guard from exactly these rows, so an account with none of them signs in
 * to an empty panel.
 */
const BRANCH_BASELINE = {
  ...BRANCH_GRANTS,
  "/members": grant("read", "write", "edit", "delete", "print"),
  "/trainers": grant("read", "write", "edit", "delete"),
  "/membership-plans": grant("read"),
  "/cash-flow": grant("read", "write", "edit", "delete", "print"),
  "/expense-categories": grant("read"),
  "/member-exercise-plan": grant("read", "write", "edit", "delete"),
  "/branch-master": grant("read"),
  "/employee": grant("read"),
  "/company-details": grant("read"),
};

/** Menus that must never appear in a grant table here. Asserted, not trusted. */
const RESERVED_TO_SUPER_ADMIN = [
  "/audit-log",
  "/seo-manager",
  "/website-pages",
  "/website-adverts",
  "/website-leads",
  "/employee-roles",
  "/role-master",
];

const assertNoReservedGrants = () => {
  const offenders = Object.keys({ ...BRANCH_GRANTS, ...BRANCH_BASELINE }).filter(
    (url) => RESERVED_TO_SUPER_ADMIN.includes(url) || url.startsWith("/cms/"),
  );
  if (offenders.length) {
    throw new Error(
      `Refusing to run: these menus are reserved to the super admin but appear in a grant table: ${offenders.join(", ")}`,
    );
  }
};

/** menuUrl -> MenuMaster doc, for the URLs we intend to grant. */
const loadMenus = async (urls) => {
  const found = new Map();
  const missing = [];
  for (const url of urls) {
    const menu = await MenuMaster.findOne({ menuUrl: url });
    if (menu) found.set(url, menu);
    else missing.push(url);
  }
  return { found, missing };
};

/**
 * The roles a BRANCH person actually logs in with.
 *
 * Derived from the data rather than hardcoded by name, because role names are
 * free text a user typed ("Branch Admin", "SUPPORT", "TEST ROLE") and a seed
 * that matches on them silently does nothing the day somebody renames one.
 * A role counts as a branch role when at least one ACTIVE, NON-super-admin
 * staff account holds it. A super admin's own role is skipped: they bypass
 * every check anyway, so a grant there would be noise.
 */
const findBranchRoleIds = async () => {
  const holders = new Map();

  const employees = await Employee.find({
    isActive: true,
    isSuperAdmin: { $ne: true },
  }).select("employeeName emailOffice roleId branch");

  for (const e of employees) {
    if (!e.roleId) continue;
    const key = String(e.roleId);
    if (!holders.has(key)) holders.set(key, []);
    holders.get(key).push(`${e.emailOffice} (Employee, branch=${e.branch ?? "ALL"})`);
  }

  const companyAdmins = await CompanyMaster.find({
    isActive: true,
    isSuperAdmin: { $ne: true },
  }).select("companyName email roleId");

  for (const c of companyAdmins) {
    if (!c.roleId) continue;
    const key = String(c.roleId);
    if (!holders.has(key)) holders.set(key, []);
    holders.get(key).push(`${c.email} (CompanyMaster admin)`);
  }

  return holders;
};

/**
 * Adds any missing rows from `grants` to one EmployeeRoles document.
 * Never edits a row that already exists — see the idempotency note up top.
 *
 * @returns {{added: string[], kept: string[]}}
 */
const topUpRole = (employeeRole, grants, menus) => {
  const added = [];
  const kept = [];

  for (const [url, flags] of Object.entries(grants)) {
    const menu = menus.get(url);
    if (!menu) continue;

    const already = (employeeRole.roles || []).some(
      (r) => String(r.menuId) === String(menu._id),
    );
    if (already) {
      kept.push(url);
      continue;
    }

    employeeRole.roles.push({
      menuId: menu._id,
      menuGroupId: menu.menuGroup ?? null,
      ...flags,
    });
    added.push(url);
  }

  return { added, kept };
};

export const seedBranchRolePermissions = async ({
  apply = false,
  adoptCompanyAdmins = false,
} = {}) => {
  assertNoReservedGrants();

  const mode = apply ? "APPLY (writing)" : "DRY RUN (nothing will be written)";
  console.log(`\n=== Branch role permissions — ${mode} ===\n`);

  const wantedUrls = [
    ...new Set([...Object.keys(BRANCH_GRANTS), ...Object.keys(BRANCH_BASELINE)]),
  ];
  const { found: menus, missing } = await loadMenus(wantedUrls);

  if (missing.length) {
    console.log("⚠️  These menu rows do not exist and will be SKIPPED:");
    for (const url of missing) console.log(`      ${url}`);
    console.log(
      "    A missing row is a 403 ('Menu ... not found'), not a fallback.\n" +
        "    Run `npm run seed:insights-menus` and `npm run seed:class-menus` first.\n",
    );
  }

  // ── 1. Top up every existing branch role ────────────────────────────
  const holders = await findBranchRoleIds();

  if (holders.size === 0) {
    console.log("• No branch roles found (no active non-super-admin staff hold a role).");
  }

  let rolesChanged = 0;

  for (const [roleId, who] of holders) {
    const roleDoc = await RoleMaster.findById(roleId).select("roleName");
    const label = roleDoc?.roleName || `(role ${roleId})`;

    const employeeRole = await EmployeeRoles.findOne({ roleId, isActive: true });

    if (!employeeRole) {
      console.log(
        `⚠️  Role '${label}' has NO EmployeeRoles document — held by:\n` +
          who.map((w) => `      ${w}`).join("\n") +
          `\n    Those accounts are refused on every gated screen with\n` +
          `    "No permissions found for this role". Create the permission set on\n` +
          `    the Employee Roles screen, then re-run this script.\n`,
      );
      continue;
    }

    const { added, kept } = topUpRole(employeeRole, BRANCH_GRANTS, menus);

    console.log(`Role '${label}' — held by ${who.length} account(s):`);
    for (const w of who) console.log(`    ${w}`);
    if (kept.length) console.log(`    unchanged (already granted): ${kept.join(", ")}`);
    if (added.length) console.log(`    ${apply ? "GRANTED" : "would grant"}: ${added.join(", ")}`);
    if (!added.length) console.log("    nothing to add");
    console.log("");

    if (added.length && apply) {
      await employeeRole.save();
      rolesChanged += 1;
    }
  }

  // ── 2. Report / adopt CompanyMaster admins that have no role at all ──
  //
  // These are the accounts that LOSE access on deploy: a CompanyMaster row with
  // isSuperAdmin: false logs in as role "ADMIN", used to bypass every check on
  // the strength of that string alone, and carries no roleId — so once the gate
  // reads isSuperAdmin it has no grants to fall back on.
  const orphans = await CompanyMaster.find({
    isActive: true,
    isSuperAdmin: { $ne: true },
    $or: [{ roleId: null }, { roleId: { $exists: false } }],
  }).select("companyName email");

  if (orphans.length === 0) {
    console.log("• No branch-level CompanyMaster admins are missing a role.\n");
  } else {
    console.log(
      `⚠️  ${orphans.length} branch-level CompanyMaster admin(s) have NO roleId.\n` +
        "    Until they do, every permission-gated screen answers 403\n" +
        '    "No permissions found for this role":',
    );
    for (const o of orphans) console.log(`      ${o.email}`);
    console.log("");

    if (!adoptCompanyAdmins) {
      console.log(
        "    Pass --adopt-company-admins to give them a 'Branch Admin (Panel)' role\n" +
          "    with the operational baseline. Review the baseline in this file first —\n" +
          "    it deliberately excludes the CMS, the audit log and role editing.\n" +
          "    The alternative, if these logins are not wanted, is to deactivate them.\n",
      );
    } else {
      const ROLE_NAME = "Branch Admin (Panel)";
      let role = await RoleMaster.findOne({ roleName: ROLE_NAME });
      if (!role) {
        console.log(`    ${apply ? "Creating" : "Would create"} RoleMaster '${ROLE_NAME}'`);
        if (apply) {
          role = await new RoleMaster({
            roleName: ROLE_NAME,
            isActive: true,
            // createdBy null = an admin-created role, which is what
            // checkUpdatePermissions requires before it may be edited.
            createdBy: null,
          }).save();
        }
      } else {
        console.log(`    • RoleMaster '${ROLE_NAME}' already exists`);
      }

      if (apply && role) {
        let employeeRole = await EmployeeRoles.findOne({ roleId: role._id });
        if (!employeeRole) {
          employeeRole = new EmployeeRoles({ roleId: role._id, roles: [], isActive: true });
        }
        const { added, kept } = topUpRole(employeeRole, BRANCH_BASELINE, menus);
        if (kept.length) console.log(`    unchanged: ${kept.join(", ")}`);
        if (added.length) console.log(`    GRANTED: ${added.join(", ")}`);
        await employeeRole.save();

        for (const o of orphans) {
          await CompanyMaster.updateOne({ _id: o._id }, { $set: { roleId: role._id } });
          console.log(`    ✅ ${o.email} → '${ROLE_NAME}'`);
        }
        console.log(
          "\n    Those accounts must LOG OUT AND BACK IN: the permission snapshot\n" +
            "    is written onto the session at login.\n",
        );
      } else if (!apply) {
        console.log(
          `    Would grant the baseline (${Object.keys(BRANCH_BASELINE).join(", ")})\n` +
            `    and point ${orphans.length} account(s) at it.\n`,
        );
      }
    }
  }

  if (apply) {
    console.log(`✅ Done. ${rolesChanged} existing role(s) updated.`);
    console.log(
      "   Staff already signed in keep the permission snapshot taken at login\n" +
        "   until EmployeeRoles.updatedAt moves past it — saving the role above does\n" +
        "   move it, so checkPermission refreshes them on their next request.",
    );
  } else {
    console.log("✅ Dry run complete. Nothing was written. Re-run with --apply to commit.");
  }
};

// Direct execution owns its own connection.
if (
  process.argv[1] &&
  process.argv[1].endsWith("seedBranchRolePermissions.js")
) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedBranchRolePermissions({
      apply: process.argv.includes("--apply"),
      adoptCompanyAdmins: process.argv.includes("--adopt-company-admins"),
    });
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error("❌ Branch role permission seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedBranchRolePermissions;
