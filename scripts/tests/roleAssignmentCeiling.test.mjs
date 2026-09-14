/**
 * You may not hand someone a role you could not grant yourself.
 *
 * ============================================================================
 * THE HOLE THIS CLOSES, CONFIRMED AGAINST PRODUCTION
 * ============================================================================
 * `/role-master` is reserved to the super admin, so a branch admin cannot LIST
 * roles — and that was mistaken for a control. It is not. The permission gate
 * is on the roles SCREEN; `createEmployee` and `updateEmployee` wrote
 * `req.body.roleId` onto the row with nothing checking it at all. Not seeing a
 * menu is not the same as not being able to name an id.
 *
 * Measured live on 2026-09-14, as the Vasna branch admin, against production:
 * a disposable employee was created carrying the `SUPPORT` role, which exceeds
 * a branch admin's own ceiling by 111 flag-grants — including `/employee-roles`
 * read+write+edit+delete and `/menu-master` the same. The chain is:
 *
 *     create an employee (branch admins legitimately hold `write` on /employee)
 *       -> assign it the SUPPORT roleId
 *       -> sign in as it
 *       -> it holds /employee-roles, so it can now grant itself anything.
 *
 * The probe row was created with `isActive: false` so it could never be signed
 * into, and deleted immediately.
 *
 * This is the SAME rule employeeRoles.controller.js already enforces when a
 * role's permissions are edited — "you cannot give more permissions than you
 * have yourself". It simply was not applied on the other road to the same
 * destination. Editing a role and assigning a role are two ways to give
 * somebody a capability, and only one of them was guarded.
 *
 * ============================================================================
 * WHY THE COMPARISON IS SHARED, NOT COPIED
 * ============================================================================
 * Earlier in this same codebase a guard was written twice and one copy counted
 * the wrong collection — it read as correct in review while being incapable of
 * firing (see middlewares/superAdminFloor.js). Two implementations of "is this
 * above your ceiling" would drift the same way, and the drift is invisible
 * because the wrong answer is silence. There is one comparison, in
 * middlewares/roleCeiling.js, and both callers use it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const handler = (file, name) => {
  const src = read(file);
  const i = src.indexOf(`export const ${name}`);
  assert.ok(i !== -1, `${name} not found in ${file}`);
  const rest = src.slice(i + 10);
  const next = rest.match(/\n(?:export )?const \w+/);
  return stripComments(rest.slice(0, next ? next.index : rest.length));
};

const EMPLOYEE = "controllers/v1/employee.controller.js";

test("the ceiling lives in one shared module", () => {
  assert.ok(
    fs.existsSync("middlewares/roleCeiling.js"),
    "one comparison, so the two callers cannot drift apart",
  );
});

test("the shared module compares every permission flag, not just read", () => {
  const src = read("middlewares/roleCeiling.js");
  for (const key of ["read", "write", "edit", "delete", "print", "mail"]) {
    assert.match(
      src,
      new RegExp(`"${key}"`),
      `a role granting ${key} above the caller's ceiling is still an escalation`,
    );
  }
});

test("employeeRoles.controller uses the shared comparison, not its own copy", () => {
  assert.match(
    read("controllers/v1/employeeRoles.controller.js"),
    /middlewares\/roleCeiling\.js/,
    "the rule it already enforced and the rule added here must be one rule",
  );
});

for (const name of ["createEmployee", "updateEmployee"]) {
  test(`${name} refuses a roleId above the caller's ceiling`, () => {
    const body = handler(EMPLOYEE, name);
    assert.match(
      body,
      /roleAssignmentError/,
      "req.body.roleId reached the row unchecked — a branch admin could assign " +
        "SUPPORT, which carries /employee-roles and /menu-master in full",
    );
  });

  test(`${name} checks the role BEFORE writing it`, () => {
    const body = handler(EMPLOYEE, name);
    const guardAt = body.search(/roleAssignmentError/);
    const writeAt = body.search(/new EmployeeModels|\.save\(\)/);
    assert.ok(writeAt !== -1, `${name} does not appear to persist anything`);
    assert.ok(
      guardAt !== -1 && guardAt < writeAt,
      "a check that runs after the write is not a check",
    );
  });
}

test("there is an assignable-roles lookup that is NOT gated on /role-master", () => {
  const routes = read("routes/v1/roles.routes.js");
  const i = routes.indexOf('"/roles/assignable"');
  assert.ok(i !== -1, "the Employee form needs somewhere to read roles from");
  const end = routes.indexOf("\n);", i);
  const block = routes.slice(routes.lastIndexOf("router.", i), end === -1 ? undefined : end);
  assert.doesNotMatch(
    block,
    /checkPermission/,
    "gating it on /role-master is precisely what a branch admin cannot pass — " +
      "that gate is why the Role dropdown was empty and no employee could be saved",
  );
  assert.match(
    block,
    /authMiddleware/,
    "a lookup is still staff-only; ungated is not unauthenticated",
  );
});

test("the full /roles list stays reserved to the super admin", () => {
  const routes = read("routes/v1/roles.routes.js");
  const i = routes.indexOf('router.get("/roles"');
  assert.ok(i !== -1, "GET /roles not found");
  assert.match(
    routes.slice(i, i + 300),
    /checkPermission\(\s*"\/role-master",\s*"read"\s*\)/,
    "opening the narrow lookup must not open the roles screen itself",
  );
});
