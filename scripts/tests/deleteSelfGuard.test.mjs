/**
 * Deleting yourself, or the last super admin, must be refused.
 *
 * deleteEmployee hard-deletes — verified against production with a disposable
 * account: created, deleted, gone from the listing entirely. That is correct
 * and is what the owner asked for. What was missing is the floor under it.
 *
 * employeeAccessError() refuses a BRANCH admin who reaches for a super admin,
 * but it returns null immediately for a super admin, who therefore had no
 * guard at all. Two consequences, both unrecoverable from the panel:
 *
 *   - a super admin could delete their own account mid-session;
 *   - with one super admin in the system, that also removes the last one, and
 *     every CMS screen, the SEO manager, the audit log and the roles screens
 *     are reachable ONLY through the isSuperAdmin bypass. Nobody could grant
 *     it back, because granting it needs a screen nobody can open.
 *
 * Deactivation has the same reach and the same consequence, so both paths are
 * pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("controllers/v1/employee.controller.js", "utf8");
/**
 * The handler body ONLY.
 *
 * Slicing to the next `export const` produced a FALSE PASS. The shared guard
 * is declared with a plain `const` between two handlers, so the slice ran
 * straight past it and swallowed the guard's own definition — every handler
 * above it appeared to call something it never calls. Stopping at the next
 * top-level declaration of any kind keeps each block to its own code.
 */
const block = (name) => {
  const i = src.indexOf(`export const ${name}`);
  assert.ok(i !== -1, `${name} not found`);
  const rest = src.slice(i + 10);
  const next = rest.match(/\n(?:export )?const \w+/);
  return rest.slice(0, next ? next.index : rest.length);
};

/**
 * The guard's DEFINITION moved out of this controller into
 * middlewares/superAdminFloor.js, so these two tests follow it there.
 *
 * Not a weakening. The local copy counted `Employee` rows only, and the single
 * super admin in this system is a `CompanyMaster` row — the count it consulted
 * was live-zero, so the guard could never fire for the account it existed to
 * protect. Shared, it counts both tables and company.controller.js calls the
 * very same function, which is what stops the two sides drifting apart.
 */
const floor = fs.readFileSync("middlewares/superAdminFloor.js", "utf8");

test("a guard exists and is shared, not copy-pasted per handler", () => {
  assert.match(floor, /export const lastSuperAdminError\b/,
    "expected one named guard both delete and deactivate can call");
  assert.match(src, /middlewares\/superAdminFloor\.js/,
    "and this controller must import it rather than keep its own copy");
});

test("deleteEmployee refuses self-deletion and the last super admin", () => {
  const b = block("deleteEmployee");
  assert.match(b, /lastSuperAdminError/, "deleteEmployee must call the guard");
  // Before the destructive call, not after it.
  assert.ok(
    b.indexOf("lastSuperAdminError") < b.indexOf("findByIdAndDelete"),
    "the guard must run BEFORE the row is deleted",
  );
});

test("the guard counts OTHER active super admins, not all rows", () => {
  assert.match(floor, /isSuperAdmin:\s*true/, "must count super admins");
  assert.match(floor, /isActive:\s*(true|\{)/, "an inactive super admin is not a way back in");
  assert.match(floor, /\$ne/, "must exclude the row being removed, or it counts itself");
  assert.match(floor, /CompanyMaster/,
    "counting Employee alone is a live-zero count — the real super admin is a company row");
});

test("updateEmployee cannot deactivate the last super admin either", () => {
  const b = block("updateEmployee");
  assert.match(b, /lastSuperAdminError/,
    "deactivating the last super admin locks everyone out exactly as deleting does");
});
