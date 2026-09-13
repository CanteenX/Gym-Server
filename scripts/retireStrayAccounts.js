/**
 * Retires the three accounts that sat outside the SA -> Admin -> Employee
 * chain, on the owner's instruction.
 *
 *   midcitygym@gmail.com    isSuperAdmin: true, branch: null, SUPPORT role (27
 *                           menus). A second super admin that appeared in no
 *                           handover document, and whose bcrypt hash was being
 *                           served to branch admins until GET /employees was
 *                           branch-scoped.
 *   midcityvasna@gmail.com  Vasna, on the old "Branch Admin" role — 26 menus,
 *                           twice what the current branch admins hold,
 *                           including /branch-master, /company-details and
 *                           /login-attempt-logs.
 *   test@gmail.com          Already inactive, but carries `branch: undefined`,
 *                           the shape the shared scopeFilter() reads as "all
 *                           branches".
 *
 * DEACTIVATED, NOT DELETED, and that is a deliberate difference from the word
 * "remove".
 *
 * These ids are referenced by a departments row and three loginattempts rows.
 * Deleting the accounts would leave those pointing at documents that no longer
 * exist — the same dangling-reference shape that silently took all four branch
 * logins down earlier today, and it would quietly break the login history for
 * exactly the accounts someone might later want to audit.
 *
 * `isActive: false` is what the login path actually checks, so these accounts
 * can no longer sign in — which is the whole point — while the records they are
 * named in stay readable. It is also reversible in one field if one of them
 * turns out to be needed.
 *
 * Privileges are stripped as well as the flag, so reactivating an account by
 * hand cannot silently restore a super admin nobody remembered granting.
 *
 *   node scripts/retireStrayAccounts.js            # dry run
 *   node scripts/retireStrayAccounts.js --apply
 *
 * Idempotent.
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const EMAILS = [
  "midcitygym@gmail.com",
  "midcityvasna@gmail.com",
  "test@gmail.com",
];

await mongoose.connect(process.env.DATABASE);
const employees = mongoose.connection.db.collection("employees");

const found = await employees.find({ emailOffice: { $in: EMAILS } }).toArray();
const planned = [];

for (const email of EMAILS) {
  const acct = found.find((a) => a.emailOffice === email);
  if (!acct) {
    planned.push(`${email} — not found, nothing to do`);
    continue;
  }
  const changes = [];
  if (acct.isActive !== false) changes.push("isActive -> false");
  if (acct.isSuperAdmin === true) changes.push("isSuperAdmin -> false");
  // roleId is cleared so the account holds no permission set even if someone
  // flips isActive back on without reviewing what it used to be able to do.
  if (acct.roleId) changes.push("roleId -> null (drops its permission set)");

  if (!changes.length) {
    planned.push(`${email} — already retired`);
    continue;
  }
  planned.push(`${email} — ${changes.join(", ")}`);

  if (APPLY) {
    await employees.updateOne(
      { _id: acct._id },
      {
        $set: {
          isActive: false,
          isSuperAdmin: false,
          roleId: null,
          updatedAt: new Date(),
          retiredAt: new Date(),
          retiredReason: "Outside the SA -> Admin -> Employee chain; retired on owner instruction",
        },
      },
    );
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}:`);
for (const p of planned) console.log(`  ${p}`);
if (!APPLY) console.log("\nRe-run with --apply to write.");

// Prove the result rather than assume it.
if (APPLY) {
  const after = await employees
    .find({}, { projection: { emailOffice: 1, isActive: 1, isSuperAdmin: 1, branch: 1 } })
    .toArray();
  console.log("\nStaff who can still sign in:");
  for (const a of after.filter((x) => x.isActive !== false)) {
    console.log(`  ${(a.emailOffice || "?").padEnd(26)} branch=${String(a.branch).padEnd(8)} isSuperAdmin=${a.isSuperAdmin}`);
  }
}

await mongoose.disconnect();
