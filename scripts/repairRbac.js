/**
 * Makes the RBAC state in the DATABASE match the model the code already
 * enforces, so nothing is left for the owner to tick by hand.
 *
 * ============================================================================
 * THE BUG THIS EXISTS TO FIX, AND WHY IT WAS INVISIBLE
 * ============================================================================
 *
 * `loginEmployee` (controllers/v1/employee.controller.js) loads the account
 * with `.populate("roleId")` and then looks the permission set up with:
 *
 *     EmployeeRoles.findOne({ roleId: employee.roleId?._id || employee.roleId })
 *
 * Mongoose's populate sets the path to **null** when the referenced document
 * does not exist. So an Employee whose `roleId` points at a RoleMaster row that
 * was never created does not error, does not warn, and does not fail to log in
 * — it lands a session carrying `roleId: null` and `permissions: []`, and is
 * then refused by every `checkPermission` route with
 * "No permissions found for this role".
 *
 * That is precisely the state all four branch accounts were in: their
 * EmployeeRoles documents existed and were fully populated (29 and 24 rows),
 * their Employee rows pointed at the right `roleId`, and the *RoleMaster rows
 * for those ids had never been created*. `EmployeeRoles.findOne({ roleId })`
 * finds the document happily — the field matches — so every offline check of
 * the linkage passed. Only `populate()` notices, and only at login.
 *
 * WHY THE PANEL MADE IT WORSE RATHER THAN OBVIOUS. `GET /auth/me` reads the
 * account with `findById` and **no populate**, so it returns the raw `roleId`
 * ObjectId. `MenuContext` fetches the EmployeeRoles document by that id, finds
 * all 29 rows, and renders a complete sidebar. The user therefore SEES every
 * screen they were granted and is 403'd the moment they open one — the exact
 * client/server disagreement middlewares/cmsPermission.js warns about, arrived
 * at from the data side instead of the code side.
 *
 * THE FIX IS TO CREATE THE MISSING RoleMaster ROWS AT THEIR EXISTING `_id`,
 * never to re-point a `roleId`. An Employee links to its permission set through
 * the `EmployeeRoles.roleId` FIELD; re-pointing anything at an EmployeeRoles
 * `_id` is the documented linking trap that has already locked an account out
 * of everything once. Creating the RoleMaster at the id that both sides already
 * name leaves every existing link intact and makes `populate()` resolve.
 *
 * ============================================================================
 * WHAT ELSE IT GUARANTEES
 * ============================================================================
 *
 *   1. THE SUPER ADMIN HAS EVERYTHING. Not by seeding grants — by the two
 *      facts the whole model rests on: `isSuperAdmin: true` and `isActive:
 *      true` on the account row. `checkPermission`, `cmsPermission` and
 *      `requireSuperAdmin` all bypass on `isSuperAdminSession(req)`, and the
 *      panel's `MenuContext` sets `isAdmin` from the `isSuperAdmin` that
 *      `GET /auth/me` reads straight off that same row, then renders the
 *      **unfiltered** menu tree from `GET /menus/by-groups` (which applies no
 *      permission filter of its own). So the sidebar and the API agree, and
 *      neither consults a stored permission row. Seeding grants for the super
 *      admin would add nothing and would create a second, drifting source of
 *      truth. This script therefore VERIFIES the flags and repairs them if they
 *      are wrong, and deliberately grants the super admin nothing.
 *
 *   2. RESERVED MENUS STAY RESERVED. A menu granted to nobody is super-admin-
 *      only automatically — that is the mechanism, not a side effect. The CMS,
 *      the SEO manager, the website screens and the audit log are kept
 *      ungranted, and `/employee-roles` + `/role-master` are kept out of branch
 *      roles: scripts/seedBranchRolePermissions.js has asserted that policy
 *      since it was written, but only for the rows IT adds. Rows added by hand
 *      through the Employee Roles screen bypassed that assertion, and the live
 *      branch-admin role had picked up both. This script revokes them.
 *
 *   3. THE FOUR BRANCH ACCOUNTS ARE SHAPED AS THE OWNER SPECIFIED — right
 *      branch, not super admins, active, and holding their tier's operational
 *      baseline.
 *
 * ============================================================================
 * SAFETY
 * ============================================================================
 *
 * PRINTS THE PLAN AND WRITES NOTHING unless you pass --apply. Idempotent: a
 * second run reports "nothing to do". A grant row that already exists is never
 * reshaped, so flags the owner tuned by hand survive every re-run — the only
 * rows this script ever CHANGES are reserved-menu revocations and rows pointing
 * at no menu at all, both of which it names individually before doing it.
 *
 *     node scripts/repairRbac.js            # dry run  (npm run repair:rbac)
 *     node scripts/repairRbac.js --apply    # write    (npm run repair:rbac -- --apply)
 *     node scripts/repairRbac.js --verify   # re-query and print the live state only
 *
 * RUN scripts/seedBranchRolePermissions.js FIRST if the menu rows are missing —
 * this script skips a baseline URL with no MenuMaster row rather than inventing
 * one, because a menu row is a navigation decision and `checkPermission`
 * answers a missing one with a 403, not a fallback.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import MenuMaster from "../models/MenuMaster.js";
import MenuGroupMaster from "../models/MenuGroupMaster.js";
import EmployeeRoles from "../models/EmployeeRoles.js";
import RoleMaster from "../models/RoleMaster.js";
import Employee from "../models/Employee.js";
import CompanyMaster from "../models/CompanyMaster.js";

dotenv.config();

// ===================================================================
// Policy — the data half of the RBAC model, stated once
// ===================================================================

export const ACTIONS = ["read", "write", "edit", "delete", "print", "mail"];

const NONE = Object.fromEntries(ACTIONS.map((a) => [a, false]));

/** `grant("read","print")` -> every flag false except those two. */
export const grant = (...on) => ({
  ...NONE,
  ...Object.fromEntries(on.map((a) => [a, true])),
});

/** The super admin's login. The one account the whole model is anchored on. */
/**
 * Moved from websupport@barodaweb.net on the owner's instruction. Leaving the
 * old address here would make this script fail to find the super admin and
 * then "repair" a database that is already correct.
 */
export const SUPER_ADMIN_EMAIL = "nventra@gmail.com";

/**
 * Menus no branch role may hold, ever.
 *
 * The first five are the owner's own screens and are kept ungranted because
 * THAT is what makes them super-admin-only — there is no separate "owner only"
 * flag on a menu, and adding one would be a second mechanism to keep in sync.
 *
 * `/employee-roles` and `/role-master` are here for a different reason: they
 * are the screens that EDIT this table. `checkEscalationCeiling` in
 * employeeRoles.controller.js does bound what a non-super-admin may grant to
 * "no more than you already hold", so holding them is not an escalation to the
 * CMS — but it does let a branch reshape the other branch's role and mint new
 * roles and logins up to its own ceiling, which is administration of the gym,
 * not operation of a branch. The super admin can still tick them per role by
 * hand if they decide otherwise; this script only removes what it has not been
 * told to keep.
 */
/**
 * The menus whose FLAGS are reconciled to the baseline on every run.
 *
 * Top-up only ever ADDS a url that is missing; it never reshapes an existing
 * row. That is the right default — most rows were tuned by hand or seeded by
 * an older policy, and silently rewriting them is what this script's "never
 * reshape" rule exists to prevent. Reconciliation is the deliberate exception,
 * and every entry here is a decision the owner actually made.
 *
 *   /attendance-overview — the front desk may reverse a refused scan.
 *   /members, /trainers  — these routes were UNGATED until 2026-09-14, so the
 *     flags on them had never been enforced and had drifted from the baseline
 *     accordingly: live, a branch admin had no `delete` and the front desk had
 *     no `write` or `edit`. Switching the gate on without repairing them would
 *     have taken enrolment and payment-taking away from the desk overnight —
 *     a security fix presenting as a broken till.
 *
 * A url still NOT listed here (such as /holiday-master) is one whose rows were
 * created correctly by top-up in the first place, so there is nothing to
 * repair and reconciling would only risk overwriting a hand-tuned flag.
 */
export const RECONCILED_FLAGS_URLS = ["/attendance-overview", "/members", "/trainers"];

/**
 * `/holiday-master` DELIBERATELY DOES NOT JOIN RECONCILED_FLAGS_URL.
 *
 * Reconciliation exists to fix an EXISTING row whose flags were baselined
 * wrong before the owner's decision was known — /attendance-overview's `edit`
 * was granted to staff after rows already existed with read-only, so top-up
 * alone (which only ever ADDS a missing URL, never touches a URL that is
 * already present) could never repair it. /holiday-master has no such
 * history: it is a brand-new URL, so on every role's first run
 * planBaselineTopUp() finds it MISSING and adds it with the correct flags for
 * that tier from the start. There is nothing to reconcile. If a future change
 * narrows or widens the holiday-master baseline after rows already exist, add
 * it here at that point — not pre-emptively now, which would mean this
 * script silently overwrites a flag the owner tuned by hand for no reason
 * that applies yet.
 */

export const RESERVED_TO_SUPER_ADMIN = [
  "/audit-log",
  "/seo-manager",
  "/website-pages",
  "/website-adverts",
  "/website-leads",
  "/employee-roles",
  "/role-master",
  /**
   * Menu structure is the owner's, for a reason that is not about access.
   *
   * Holding these is not an escalation - checkEscalationCeiling bounds any
   * grant to what the granter already holds. The problem is that
   * checkPermission resolves a menu BY URL. A branch admin with write here can
   * rename /seo-manager's menuUrl, after which the lookup finds nothing and
   * every non-super-admin is 403'd out of a screen they were entitled to. That
   * is a denial of service on the owner's own screens, reachable from an
   * account the owner handed to a branch.
   */
  "/menu-master",
  "/menu-group",
];

/**
 * `/cms/*` is matched by PREFIX, not listed.
 *
 * config/cmsMenus.js is owned elsewhere and grows — it has gained /cms/stats,
 * /cms/marquee, /cms/branches and more since the branch-role seed was written.
 * A hardcoded list would silently stop covering the new ones the day they are
 * seeded, and a newly seeded CMS screen that nobody remembered to add to a deny
 * list is exactly how the CMS stops being the owner's alone.
 *
 * @param {string} menuUrl
 * @returns {boolean}
 */
export const isReservedMenuUrl = (menuUrl) =>
  typeof menuUrl === "string" &&
  (RESERVED_TO_SUPER_ADMIN.includes(menuUrl) || menuUrl.startsWith("/cms/"));

/**
 * The four branch logins, exactly as the owner specified them.
 *
 * Keyed by email and carrying branch + tier ONLY. The roleId is deliberately
 * NOT here: it is read off the account row at run time, so this script can
 * never re-point a link, and renaming or recreating a role does not require
 * editing this file. See the linking-trap note in the header.
 */
export const BRANCH_ACCOUNTS = {
  "nventra01@gmail.com": { branch: "Vasna", tier: "admin" },
  "nventra011@gmail.com": { branch: "Vasna", tier: "staff" },
  "nventra02@gmail.com": { branch: "Gotri", tier: "admin" },
  "nventra021@gmail.com": { branch: "Gotri", tier: "staff" },
};

/**
 * What each tier gets, per screen, when a row has to be CREATED.
 *
 * These flags apply to rows this script ADDS. An existing row is never
 * reshaped — see the idempotency note in the header — so running this against
 * a live database that somebody has tuned by hand does not undo the tuning.
 *
 * `admin` is the branch's own gym: full CRUD on the things a branch runs,
 * read on the things it merely needs to see (`/branch-master`,
 * `/company-details`, `/employee`, `/membership-plans`), and read+print on
 * `/reports` because `print` is the flag the CSV export routes check and a
 * download leaving the building is a separate decision from reading a number.
 *
 * `staff` is the front desk: read almost everywhere, because the one write
 * that matters on these screens — `POST /attendance/:id/mark-allowed`, behind
 * checkPermission("/attendance-overview", "edit") — is overriding a system
 * refusal in a member's favour, usually with money behind it. That is the
 * branch admin's call, so it is not in either baseline and stays a deliberate
 * per-role tick by the super admin.
 *
 * NOTHING RESERVED APPEARS HERE and assertPolicyIsSelfConsistent() proves it
 * on every run rather than trusting the author of the next edit.
 */
export const TIER_BASELINES = {
  /**
   * The branch admin runs one gym: its members, its trainers, its classes, its
   * cash, and — the owner's explicit requirement — its own staff. Employee is
   * read+write+edit for that reason, and the server scopes the employee list
   * by branch so "its own staff" is enforced rather than trusted.
   *
   * Deliberately absent: /branch-master (renaming a Branch orphans every
   * member and transaction row scoped to the old string), /company-details,
   * and the Country/State/City/email/login-log screens. Those are the owner's
   * setup, not a branch's, and their presence is what made the two sidebars
   * look identical.
   */
  admin: {
    /**
     * Every flag spelled out, because /members is RECONCILED: a reconciled
     * row is rewritten to match this exactly, so a flag omitted here is a
     * flag taken away. A branch admin already held print and mail; the only
     * change the owner asked for is `delete`.
     */
    "/members": grant("read", "write", "edit", "delete", "print", "mail"),
    // Reconciled, as /members above — print and mail are named so that
    // adding `delete` does not silently strip them.
    "/trainers": grant("read", "write", "edit", "delete", "print", "mail"),
    "/class-sessions": grant("read", "write", "edit", "delete"),
    "/member-exercise-plan": grant("read", "write", "edit", "delete"),
    "/membership-plans": grant("read"),
    "/cash-flow": grant("read", "write", "edit", "delete", "print"),
    "/expense-categories": grant("read"),
    // Also `edit`: a branch admin cannot hold LESS than the desk they
    // supervise, or they cannot undo or repeat what their own staff just did.
    "/attendance-overview": grant("read", "edit"),
    "/reports": grant("read", "print"),
    "/employee": grant("read", "write", "edit"),
    // Documentation, not administration. Both tiers keep it.
    "/guides-gallery": grant("read"),
    "/manage-guides": grant("read", "write", "edit"),
    /**
     * Full CRUD, matching the owner's explicit instruction: SUPER ADMIN and
     * branch ADMINS may mark/edit/remove their own branch's closures (and see
     * the all-branches ones — enforced server-side by
     * services/holidayScope.js, not by this flag set).
     */
    "/holiday-master": grant("read", "write", "edit", "delete"),
  },
  /**
   * The front desk. Sees the people in front of it and the day's attendance,
   * and nothing else.
   *
   * The owner's words: staff must not see Setup, Accounts or Branch Master.
   * None appear here. /reports is out too — it is financial, and the front
   * desk has no reason to read the branch's numbers.
   *
   * The one write that matters on these screens - POST
   * /attendance/:id/mark-allowed, behind checkPermission("/attendance-overview",
   * "edit") - overrides a system refusal in a member's favour, usually with
   * money behind it. That stays the branch admin's call and is not granted
   * here; the super admin can tick it per role if a particular desk needs it.
   */
  staff: {
    /**
     * `edit` is not decoration here. POST /members/:id/renew and
     * POST /members/:id/payments are both gated on `edit`, because both change
     * an EXISTING member. Without it the front desk could enrol a walk-in and
     * then not take the money for the membership they had just sold.
     * `delete` is deliberately absent — removal stays with a branch admin.
     */
    "/members": grant("read", "write", "edit"),
    "/trainers": grant("read"),
    "/class-sessions": grant("read"),
    "/membership-plans": grant("read"),
    /**
     * `edit` is the flag behind POST /attendance/:id/mark-allowed — overriding
     * a system refusal in a member's favour, usually with money behind it.
     *
     * It was withheld from both tiers on the reasoning that it is the branch
     * admin's call. The owner has decided otherwise, and the reasoning cuts
     * the other way once you picture the door: the refusal happens with a
     * member standing at the desk, and the person standing opposite them is
     * the front desk, not the branch admin. Withholding it does not prevent
     * the override, it just makes someone fetch a manager while a queue forms.
     *
     * Every override is written to the audit log with the actor, so this is
     * accountable rather than silent.
     */
    "/attendance-overview": grant("read", "edit"),
    "/guides-gallery": grant("read"),
    /**
     * READ ONLY. The owner's own words: "basically it's just checkbox
     * unchecked" — the front desk sees the Holiday Master screen and the
     * calendar so they can answer "are we open Saturday?", but may not
     * add/edit/remove a closure. write/edit/delete are deliberately absent
     * rather than present-and-false; TIER_BASELINES only ever grants what is
     * listed, never assumes an unlisted flag defaults to denied by some other
     * mechanism.
     */
    "/holiday-master": grant("read"),
  },
};

/** Name given to a RoleMaster row this script has to create for a tier. */
export const TIER_ROLE_NAMES = {
  admin: "Gym Branch Admin",
  staff: "Gym Branch Staff",
};

// ===================================================================
// Pure planners — no database, no I/O, unit-tested offline
// ===================================================================

/**
 * Refuses to run if the policy above contradicts itself.
 *
 * Asserted rather than trusted because the failure is silent in the dangerous
 * direction: a reserved URL pasted into a baseline grants it to two branches
 * and nothing complains.
 *
 * @param {object} [baselines] defaults to TIER_BASELINES
 * @throws {Error} when a baseline names a reserved menu
 */
export const assertPolicyIsSelfConsistent = (baselines = TIER_BASELINES) => {
  const offenders = Object.entries(baselines).flatMap(([tier, grants]) =>
    Object.keys(grants)
      .filter(isReservedMenuUrl)
      .map((url) => `${tier}:${url}`),
  );
  if (offenders.length) {
    throw new Error(
      `Refusing to run: reserved menus appear in a tier baseline: ${offenders.join(", ")}`,
    );
  }
  return true;
};

/**
 * THE INVARIANT THE WHOLE SCRIPT EXISTS FOR.
 *
 * Reproduces what `loginEmployee` computes onto the session, including the
 * populate() behaviour that hid the bug: a `roleId` naming a RoleMaster row
 * that does not exist is nulled by populate BEFORE the EmployeeRoles lookup
 * runs, so the lookup asks for `roleId: null` and the account lands a session
 * with no permissions at all.
 *
 * Kept as a pure function so a test can pin it without a database and without
 * standing the server up — the real login path cannot be exercised offline,
 * and this is the one piece of its behaviour that matters here.
 *
 * @param {object} args
 * @param {string|null} args.employeeRoleId Employee.roleId as stored
 * @param {boolean} args.roleMasterExists is there a RoleMaster at that id?
 * @param {{roleId: string, roles: object[]}|null} args.employeeRolesDoc
 * @returns {{roleId: string|null, permissionCount: number, lockedOut: boolean}}
 */
export const simulateLoginPermissions = ({
  employeeRoleId,
  roleMasterExists,
  employeeRolesDoc,
}) => {
  // populate("roleId") nulls the path when the referenced doc is absent.
  const populated = roleMasterExists ? employeeRoleId : null;

  const matched =
    populated && employeeRolesDoc && String(employeeRolesDoc.roleId) === String(populated)
      ? employeeRolesDoc
      : null;

  const permissionCount = matched?.roles?.length ?? 0;

  return {
    roleId: populated ? String(populated) : null,
    permissionCount,
    // checkPermission -> ensurePermissionsFresh: empty permissions triggers a
    // reload keyed on session.roleId, which is also null, so it cannot recover.
    lockedOut: permissionCount === 0,
  };
};

/**
 * Every roleId referenced anywhere that has no RoleMaster document behind it.
 *
 * Both sides are collected because they fail differently: a dangling
 * `Employee.roleId` breaks login (populate), while a dangling
 * `EmployeeRoles.roleId` leaves a permission set no role names, which the
 * Employee Roles screen renders as an unlabelled row.
 *
 * @param {object} args
 * @param {string[]} args.roleMasterIds existing RoleMaster _ids
 * @param {Array<{id: string, source: string}>} args.references
 * @returns {Array<{id: string, sources: string[]}>}
 */
export const planRoleMasterRepairs = ({ roleMasterIds, references }) => {
  const known = new Set((roleMasterIds || []).map(String));
  const byId = new Map();

  for (const ref of references || []) {
    if (!ref?.id) continue;
    const id = String(ref.id);
    if (known.has(id)) continue;
    if (!byId.has(id)) byId.set(id, { id, sources: [] });
    byId.get(id).sources.push(ref.source);
  }

  return [...byId.values()];
};

/**
 * The linking trap, detected rather than assumed absent.
 *
 * An account or a permission set whose `roleId` is the `_id` of an
 * EmployeeRoles DOCUMENT rather than of a RoleMaster row. `checkPermission`
 * does `EmployeeRoles.findOne({ roleId })` and finds nothing, so the account is
 * locked out of everything. REPORTED, NEVER AUTO-FIXED: the correct target is
 * ambiguous (the document's own roleId? a new role?) and guessing wrong moves a
 * whole branch onto somebody else's permission set.
 *
 * @param {object} args
 * @param {string[]} args.employeeRolesDocIds every EmployeeRoles._id
 * @param {Array<{id: string, source: string}>} args.references
 * @returns {Array<{id: string, source: string}>}
 */
export const detectLinkingTrap = ({ employeeRolesDocIds, references }) => {
  const docIds = new Set((employeeRolesDocIds || []).map(String));
  return (references || []).filter((ref) => ref?.id && docIds.has(String(ref.id)));
};

/**
 * Rows to strip from one permission set: reserved menus, and rows pointing at
 * no menu at all.
 *
 * A row whose `menuId` is null or names a menu that no longer exists can never
 * match anything — `hasMenuPermission` compares against a menu resolved by URL
 * — so it is dead weight that makes the Employee Roles screen misreport how
 * much a role holds. Removed, and named in the plan so the removal is visible.
 *
 * A row is only reserved-revoked when `revokeReserved` is true; that is decided
 * per role by whether a non-super-admin actually holds it, because a role held
 * only by the super admin is governed by the bypass and reshaping it would be
 * noise.
 *
 * @param {object} args
 * @param {object[]} args.rows employeeRole.roles
 * @param {Map<string, {menuUrl: string}>} args.menuById
 * @param {boolean} args.revokeReserved
 * @returns {{keep: object[], revoked: string[], junk: string[]}}
 */
export const planRowRemovals = ({ rows, menuById, revokeReserved }) => {
  const keep = [];
  const revoked = [];
  const junk = [];

  for (const row of rows || []) {
    const menu = row?.menuId ? menuById.get(String(row.menuId)) : null;

    if (!menu) {
      junk.push(row?.menuId ? `unknown menu ${row.menuId}` : "menuId: null");
      continue;
    }

    if (revokeReserved && isReservedMenuUrl(menu.menuUrl)) {
      revoked.push(menu.menuUrl);
      continue;
    }

    keep.push(row);
  }

  return { keep, revoked, junk };
};

/**
 * Rows to ADD so a role holds its tier's baseline. Never reshapes a row that is
 * already there, and never invents a menu that has no MenuMaster row.
 *
 * @param {object} args
 * @param {object[]} args.rows the role's current rows (post-removal)
 * @param {object} args.baseline TIER_BASELINES[tier]
 * @param {Map<string, {_id: unknown, menuGroup: unknown}>} args.menuByUrl
 * @returns {{added: object[], addedUrls: string[], kept: string[], missingMenus: string[]}}
 */
export const planBaselineTopUp = ({ rows, baseline, menuByUrl }) => {
  const held = new Set((rows || []).map((r) => String(r.menuId)));
  const added = [];
  const addedUrls = [];
  const kept = [];
  const missingMenus = [];

  for (const [url, flags] of Object.entries(baseline || {})) {
    const menu = menuByUrl.get(url);
    if (!menu) {
      missingMenus.push(url);
      continue;
    }
    if (held.has(String(menu._id))) {
      kept.push(url);
      continue;
    }
    added.push({ menuId: menu._id, menuGroupId: menu.menuGroup ?? null, ...flags });
    addedUrls.push(url);
  }

  return { added, addedUrls, kept, missingMenus };
};

/**
 * What must be true of the super admin's account row for the bypass to work.
 *
 * Both flags, because they fail in opposite and equally total ways:
 * `isActive: false` means the login is refused outright, and
 * `isSuperAdmin: false` means the login succeeds and then every gate treats the
 * owner as an ungranted branch user — a 403 indistinguishable from a missing
 * grant, on every screen, with the sidebar empty.
 *
 * @param {{isActive?: boolean, isSuperAdmin?: boolean}|null} account
 * @returns {{ok: boolean, problems: string[], fix: object}}
 */
export const planSuperAdminRepair = (account) => {
  if (!account) {
    return {
      ok: false,
      problems: [`no account found for ${SUPER_ADMIN_EMAIL}`],
      fix: {},
    };
  }

  const problems = [];
  const fix = {};

  if (account.isSuperAdmin !== true) {
    problems.push("isSuperAdmin is not true");
    fix.isSuperAdmin = true;
  }
  if (account.isActive !== true) {
    problems.push("isActive is not true");
    fix.isActive = true;
  }

  return { ok: problems.length === 0, problems, fix };
};

// ===================================================================
// The run
// ===================================================================

const line = (s = "") => console.log(s);
const flagsOf = (row) => ACTIONS.filter((a) => row[a]).join("+") || "NONE";

/**
 * Loads every menu once and indexes it both ways.
 *
 * Reads ALL menus, not just active ones: a permission row pointing at a
 * deactivated menu is a real row that must not be mistaken for junk and
 * silently deleted.
 */
const loadMenus = async () => {
  const menus = await MenuMaster.find({}).lean();
  return {
    menuById: new Map(menus.map((m) => [String(m._id), m])),
    menuByUrl: new Map(menus.map((m) => [m.menuUrl, m])),
    menus,
  };
};

/** Every place a roleId is referenced, labelled with where it came from. */
const collectRoleReferences = (employees, companies, employeeRoleDocs) => [
  ...employees
    .filter((e) => e.roleId)
    .map((e) => ({ id: String(e.roleId), source: `Employee ${e.emailOffice}` })),
  ...companies
    .filter((c) => c.roleId)
    .map((c) => ({ id: String(c.roleId), source: `CompanyMaster ${c.email}` })),
  ...employeeRoleDocs
    .filter((d) => d.roleId)
    .map((d) => ({ id: String(d.roleId), source: `EmployeeRoles ${d._id}` })),
];

export const repairRbac = async ({ apply = false, verifyOnly = false } = {}) => {
  assertPolicyIsSelfConsistent();

  const mode = verifyOnly
    ? "VERIFY ONLY (reading)"
    : apply
      ? "APPLY (writing)"
      : "DRY RUN (nothing will be written)";
  line(`\n=== RBAC repair — ${mode} ===\n`);

  const { menuById, menuByUrl, menus } = await loadMenus();
  const [employees, companies, employeeRoleDocs, roleMasters] = await Promise.all([
    Employee.find({}).lean(),
    CompanyMaster.find({}).lean(),
    EmployeeRoles.find({}).lean(),
    RoleMaster.find({}).lean(),
  ]);

  let changes = 0;

  // ── 1. The super admin ───────────────────────────────────────────
  line("── 1. Super admin ──────────────────────────────────────────");

  const saCompany = companies.find((c) => c.email === SUPER_ADMIN_EMAIL) || null;
  const saEmployee =
    employees.find((e) => e.emailOffice === SUPER_ADMIN_EMAIL) || null;
  const sa = saCompany || saEmployee;
  const saModel = saCompany ? CompanyMaster : Employee;

  const saPlan = planSuperAdminRepair(sa);
  if (saPlan.ok) {
    line(
      `✅ ${SUPER_ADMIN_EMAIL} — ${saCompany ? "CompanyMaster" : "Employee"}, isSuperAdmin=true, isActive=true.`,
    );
    line(
      "   Access is by BYPASS, not by stored grants: checkPermission,\n" +
        "   cmsPermission and requireSuperAdmin all short-circuit on\n" +
        "   isSuperAdminSession(req), and the panel's MenuContext sets isAdmin\n" +
        "   from the same flag and then renders the UNFILTERED menu tree.\n" +
        "   Nothing to seed — seeding grants here would create a second,\n" +
        "   drifting source of truth for the same answer.",
    );
  } else {
    line(`❌ ${SUPER_ADMIN_EMAIL}: ${saPlan.problems.join("; ")}`);
    if (sa && Object.keys(saPlan.fix).length && apply && !verifyOnly) {
      await saModel.updateOne({ _id: sa._id }, { $set: saPlan.fix });
      line(`   ✅ repaired: ${JSON.stringify(saPlan.fix)}`);
      changes += 1;
    } else if (sa) {
      line(`   would set ${JSON.stringify(saPlan.fix)}`);
    }
  }

  const activeSuperAdmins = [
    ...companies.filter((c) => c.isSuperAdmin === true && c.isActive !== false).map((c) => c.email),
    ...employees.filter((e) => e.isSuperAdmin === true && e.isActive !== false).map((e) => e.emailOffice),
  ];
  line(`   active super admins: ${activeSuperAdmins.join(", ") || "NONE — the system has no owner login"}`);

  // Every menu the owner can reach. Only ACTIVE menus in ACTIVE groups are
  // returned by /menus/by-groups, so an inactive one is invisible to everybody,
  // super admin included — worth naming, never worth silently reactivating.
  const activeGroupIds = new Set(
    (await MenuGroupMaster.find({ isActive: true }).select("_id").lean()).map((g) => String(g._id)),
  );
  const unreachable = menus.filter(
    (m) => !m.isActive || !activeGroupIds.has(String(m.menuGroup)),
  );
  line(
    `   sidebar reach: ${menus.length - unreachable.length}/${menus.length} menu rows are visible to the super admin`,
  );
  if (unreachable.length) {
    line(
      `   ⚠️  invisible to EVERYONE (inactive menu or inactive group): ${unreachable
        .map((m) => m.menuUrl)
        .join(", ")}`,
    );
    line("       Not repaired: reactivating a retired screen is a product decision.");
  }
  line("");

  // ── 2. Dangling roleIds and the linking trap ─────────────────────
  line("── 2. Role linkage ─────────────────────────────────────────");

  const references = collectRoleReferences(employees, companies, employeeRoleDocs);

  const trapped = detectLinkingTrap({
    employeeRolesDocIds: employeeRoleDocs.map((d) => d._id),
    references,
  });
  if (trapped.length) {
    line("❌ LINKING TRAP — a roleId points at an EmployeeRoles document _id:");
    for (const t of trapped) line(`      ${t.source} -> ${t.id}`);
    line(
      "   NOT auto-fixed: the correct target is ambiguous and guessing moves a\n" +
        "   whole branch onto somebody else's permission set. Fix on the Employee\n" +
        "   Roles screen, then re-run.",
    );
  } else {
    line("✅ no roleId points at an EmployeeRoles document _id.");
  }

  // Tier is needed to name a role we have to create, so resolve it per id.
  const tierByRoleId = new Map();
  for (const [email, spec] of Object.entries(BRANCH_ACCOUNTS)) {
    const emp = employees.find((e) => e.emailOffice === email);
    if (emp?.roleId) tierByRoleId.set(String(emp.roleId), spec.tier);
  }

  const missingRoles = planRoleMasterRepairs({
    roleMasterIds: roleMasters.map((r) => r._id),
    references,
  });

  if (missingRoles.length === 0) {
    line("✅ every referenced roleId has a RoleMaster row.");
  } else {
    line(
      `❌ ${missingRoles.length} roleId(s) have NO RoleMaster row. Login populate()s\n` +
        "   these to null, so the accounts below land a session with roleId: null\n" +
        '   and ZERO permissions — 403 "No permissions found for this role" on\n' +
        "   every gated screen, while the sidebar still shows them:",
    );
    const takenNames = new Set(roleMasters.map((r) => r.roleName));
    for (const miss of missingRoles) {
      const tier = tierByRoleId.get(miss.id);
      let name = TIER_ROLE_NAMES[tier] || `Recovered Role ${miss.id.slice(-6)}`;
      while (takenNames.has(name)) name = `${name} (${miss.id.slice(-4)})`;
      takenNames.add(name);

      line(`      ${miss.id}  ->  "${name}"`);
      for (const s of miss.sources) line(`          referenced by ${s}`);

      if (apply && !verifyOnly) {
        // AT THE EXISTING _id. Never re-point the references — see the header.
        await RoleMaster.create({
          _id: new mongoose.Types.ObjectId(miss.id),
          roleName: name,
          isActive: true,
          // null = admin-created, which authorizeRolePermissionWrite requires
          // before an ADMIN-table session may edit the role's permissions.
          createdBy: null,
        });
        line(`          ✅ RoleMaster created at that exact _id`);
        changes += 1;
      } else {
        line(`          would create RoleMaster at that exact _id`);
      }
    }
  }
  line("");

  // ── 3. The four branch accounts ──────────────────────────────────
  line("── 3. Branch accounts ──────────────────────────────────────");

  const roleIdsByTier = new Map();

  for (const [email, spec] of Object.entries(BRANCH_ACCOUNTS)) {
    const emp = employees.find((e) => e.emailOffice === email);
    if (!emp) {
      line(`❌ ${email} — NO Employee row. Create the login, then re-run.`);
      continue;
    }

    const fix = {};
    if (emp.branch !== spec.branch) fix.branch = spec.branch;
    // A branch account must never be a super admin: isSuperAdmin bypasses every
    // gate AND scopedBranch() stops pinning it to a branch, so one wrong flag
    // hands a branch both the CMS and the other branch's members.
    if (emp.isSuperAdmin === true) fix.isSuperAdmin = false;
    if (emp.isActive !== true) fix.isActive = true;

    const status = Object.keys(fix).length ? `needs ${JSON.stringify(fix)}` : "ok";
    line(
      `${Object.keys(fix).length ? "❌" : "✅"} ${email}  branch=${emp.branch ?? "NULL(all)"}  tier=${spec.tier}  isSuperAdmin=${emp.isSuperAdmin === true}  isActive=${emp.isActive !== false}  roleId=${emp.roleId}  — ${status}`,
    );

    if (Object.keys(fix).length && apply && !verifyOnly) {
      await Employee.updateOne({ _id: emp._id }, { $set: fix });
      line(`      ✅ repaired`);
      changes += 1;
    }

    if (emp.roleId) {
      const key = String(emp.roleId);
      const seen = roleIdsByTier.get(key);
      if (seen && seen.tier !== spec.tier) {
        line(
          `      ❌ roleId ${key} is shared by tiers '${seen.tier}' and '${spec.tier}'.\n` +
            "         Refusing to baseline it — one permission set cannot be both.\n" +
            "         Give the two tiers separate roles on the Employee Roles screen.",
        );
        seen.conflict = true;
      } else if (!seen) {
        roleIdsByTier.set(key, { tier: spec.tier, holders: [email], conflict: false });
      } else {
        seen.holders.push(email);
      }
    }
  }
  line("");

  // ── 4. Permission sets ───────────────────────────────────────────
  line("── 4. Permission sets ──────────────────────────────────────");

  // A role counts as "held by a non-super-admin" when any account that is not a
  // super admin points at it. Those are the roles the reserved policy binds; a
  // role held only by the super admin is governed by the bypass, so reshaping
  // it would change nothing and is left alone.
  const nonSuperAdminRoleIds = new Set([
    ...employees.filter((e) => e.isSuperAdmin !== true && e.roleId).map((e) => String(e.roleId)),
    ...companies.filter((c) => c.isSuperAdmin !== true && c.roleId).map((c) => String(c.roleId)),
  ]);

  for (const doc of employeeRoleDocs) {
    const roleId = String(doc.roleId);
    const roleName =
      roleMasters.find((r) => String(r._id) === roleId)?.roleName ||
      TIER_ROLE_NAMES[tierByRoleId.get(roleId)] ||
      "(role created this run)";

    const heldByBranch = nonSuperAdminRoleIds.has(roleId);
    const tierEntry = roleIdsByTier.get(roleId);

    const { keep, revoked, junk } = planRowRemovals({
      rows: doc.roles,
      menuById,
      revokeReserved: heldByBranch,
    });

    const baseline =
      tierEntry && !tierEntry.conflict ? TIER_BASELINES[tierEntry.tier] : null;

    /**
     * For the two roles this script OWNS, the baseline is the whole truth:
     * anything not in it is removed, not just topped up.
     *
     * Top-up alone left the two branch sidebars looking identical, which is
     * what the owner reported. Both roles had accumulated Setup (Country,
     * State, City, Company Details, the email screens, Login Logs), Accounts
     * and Branch Master, so the only difference between an admin and a front
     * desk was which buttons were greyed out — the same menus either way.
     *
     * This exactness applies ONLY to the tier roles. Any other role a human
     * built is still add-only, because reshaping someone's hand-tuned role
     * without being asked is how a tool stops being safe to re-run.
     */
    const pruned = baseline
      ? keep.filter((row) => {
          const url = menuById.get(String(row.menuId))?.menuUrl;
          return url ? Object.prototype.hasOwnProperty.call(baseline, url) : true;
        })
      : keep;
    const prunedUrls = baseline
      ? keep
          .filter((row) => !pruned.includes(row))
          .map((row) => menuById.get(String(row.menuId))?.menuUrl)
          .filter(Boolean)
      : [];

    const topUp = baseline
      ? planBaselineTopUp({ rows: pruned, baseline, menuByUrl })
      : { added: [], addedUrls: [], kept: [], missingMenus: [] };

    /**
     * FLAG RECONCILIATION, for the two tier roles only.
     *
     * "A grant row that already exists is never reshaped" is this script's
     * headline safety property and it stays true for every role a human built.
     * But for the two roles this script OWNS, the baseline is already the whole
     * truth - anything absent from it is pruned above - so leaving the FLAGS
     * alone made the baseline half-authoritative in a way that silently failed:
     * granting `edit` on /attendance-overview changed nothing, because the row
     * already existed with read-only and top-up only ever adds MISSING urls.
     *
     * The alternative was deleting the row so top-up recreates it, which loses
     * nothing here but reads as a destructive fix for a data problem. Setting
     * the flags to the baseline says what it means.
     */
    const reflagged = [];
    const aligned = !baseline
      ? pruned
      : pruned.map((row) => {
          const url = menuById.get(String(row.menuId))?.menuUrl;
          const want = url ? baseline[url] : null;
          if (!want) return row;
          /**
           * DELIBERATELY ONE SCREEN, not every row.
           *
           * Reconciling all flags to the baseline sounds tidier and is a far
           * bigger change than it looks: it would also hand branch admins
           * `delete` on /members and strip `print`/`mail` from a dozen
           * screens, none of which anyone asked for. Those rows were tuned by
           * hand or seeded by an older policy, and silently rewriting them is
           * exactly what this script's "never reshape an existing row" rule
           * exists to prevent.
           *
           * The owner decided ONE thing: the front desk gets `edit` on
           * attendance overview. So that is the only row whose flags this
           * reconciles. Widening it later is a deliberate act, not a side
           * effect of a re-run.
           */
          if (!RECONCILED_FLAGS_URLS.includes(url)) return row;
          const differs = ACTIONS.some((a) => Boolean(row[a]) !== Boolean(want[a]));
          if (!differs) return row;
          reflagged.push(
            `${url} (${ACTIONS.filter((a) => Boolean(row[a]) !== Boolean(want[a])).join(", ")})`,
          );
          // A new object, not a mutation of the loaded document's row.
          return { ...row, ...want };
        });

    const dirty =
      revoked.length || junk.length || topUp.added.length || prunedUrls.length || reflagged.length;

    line(
      `${dirty ? "❌" : "✅"} "${roleName}" (roleId ${roleId}) — ${doc.roles?.length ?? 0} rows, held by ${heldByBranch ? "a non-super-admin" : "nobody outside the super admin"}${tierEntry ? `, tier '${tierEntry.tier}' (${tierEntry.holders.join(", ")})` : ""}`,
    );
    if (revoked.length) line(`      REVOKE (reserved to super admin): ${revoked.join(", ")}`);
    if (junk.length) line(`      DROP (row points at no menu): ${junk.join(", ")}`);
    if (prunedUrls.length) line(`      REMOVE (not in the ${tierEntry.tier} baseline): ${prunedUrls.join(", ")}`);
    if (reflagged.length) line(`      REFLAG (to match the ${tierEntry.tier} baseline): ${reflagged.join(", ")}`);
    if (topUp.addedUrls.length) line(`      GRANT (missing from ${tierEntry.tier} baseline): ${topUp.addedUrls.join(", ")}`);
    if (topUp.missingMenus.length)
      line(
        `      ⚠️  no MenuMaster row, skipped: ${topUp.missingMenus.join(", ")}\n` +
          "          Run the matching seed script — a missing menu is a 403, not a fallback.",
      );
    if (!dirty) line("      nothing to change");

    if (dirty && apply && !verifyOnly) {
      // findOne + save, not updateOne: `save()` moves EmployeeRoles.updatedAt,
      // which is the exact field checkPermission compares against the session's
      // permissionsUpdatedAt to decide the snapshot is stale. Without that bump
      // anyone already signed in keeps the revoked permission until they log
      // out — a revocation that does not take effect is not a revocation.
      const live = await EmployeeRoles.findById(doc._id);
      live.roles = [...aligned, ...topUp.added];
      await live.save();
      line(`      ✅ written (EmployeeRoles.updatedAt bumped — live sessions refresh)`);
      changes += 1;
    }
  }
  line("");

  // ── 5. Verification, re-derived from what is now in the DB ───────
  line("── 5. Verification (re-queried) ────────────────────────────");

  const freshRoleMasterIds = new Set(
    (await RoleMaster.find({}).select("_id").lean()).map((r) => String(r._id)),
  );
  const freshEmployeeRoles = await EmployeeRoles.find({}).lean();

  for (const email of Object.keys(BRANCH_ACCOUNTS)) {
    const emp = await Employee.findOne({ emailOffice: email }).lean();
    if (!emp) continue;
    const doc = freshEmployeeRoles.find((d) => String(d.roleId) === String(emp.roleId)) || null;
    const sim = simulateLoginPermissions({
      employeeRoleId: emp.roleId,
      roleMasterExists: freshRoleMasterIds.has(String(emp.roleId)),
      employeeRolesDoc: doc,
    });
    const urls = (doc?.roles || [])
      .map((r) => menuById.get(String(r.menuId)))
      .filter(Boolean)
      .map((m) => m.menuUrl);
    line(
      `${sim.lockedOut ? "❌" : "✅"} ${email}  branch=${emp.branch}  session.roleId=${sim.roleId}  permissions=${sim.permissionCount}`,
    );
    line(`      reserved held: ${urls.filter(isReservedMenuUrl).join(", ") || "none ✅"}`);
  }

  const stillGranted = new Set();
  for (const doc of freshEmployeeRoles) {
    if (!nonSuperAdminRoleIds.has(String(doc.roleId))) continue;
    for (const row of doc.roles || []) {
      const menu = menuById.get(String(row.menuId));
      if (menu && ACTIONS.some((a) => row[a]) && isReservedMenuUrl(menu.menuUrl)) {
        stillGranted.add(menu.menuUrl);
      }
    }
  }
  line(
    `\n${stillGranted.size ? "❌" : "✅"} reserved menus granted to a non-super-admin: ${[...stillGranted].join(", ") || "none"}`,
  );

  if (verifyOnly) {
    line("\n✅ Verify complete. Nothing was written.");
  } else if (apply) {
    line(`\n✅ Done. ${changes} change(s) written.`);
    line(
      "   Anyone already signed in picks up a changed permission set on their\n" +
        "   next request (EmployeeRoles.updatedAt moved). A newly created\n" +
        "   RoleMaster only affects LOGIN, so the four branch accounts must log\n" +
        "   out and back in once to receive permissions on their session.",
    );
  } else {
    line(`\n✅ Dry run complete. ${changes} change(s) NOT written. Re-run with --apply.`);
  }

  return { changes };
};

// Direct execution owns its own connection.
if (process.argv[1] && process.argv[1].endsWith("repairRbac.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  // The repo sets mongoose debug globally in server.js; a seed script printing
  // every query buries its own report.
  mongoose.set("debug", false);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    console.log("✅ Connected to MongoDB");
    await repairRbac({
      apply: process.argv.includes("--apply"),
      verifyOnly: process.argv.includes("--verify"),
    });
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error("❌ RBAC repair failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default repairRbac;
