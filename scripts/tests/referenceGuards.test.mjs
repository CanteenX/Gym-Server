/**
 * A hard delete must not silently orphan the rows that point at it.
 *
 * ============================================================================
 * THE INCONSISTENCY THIS CLOSES
 * ============================================================================
 * `utils/referenceHelper.js` already exists and already does the right thing:
 * it walks every registered model, finds the paths declared `ref: "<Target>"`,
 * and counts the documents pointing at one id. Four controllers call it —
 * currency, department, roleMaster and `deleteCountry`.
 *
 * `deleteState` and `deleteCity` sit in the SAME FILE as `deleteCountry` and
 * do not. So deleting a country with states under it is refused, while
 * deleting one of those states — orphaning every city beneath it and every
 * Employee and CompanyMaster address pointing at it — goes straight through.
 * There is no reason for the two to differ; the guard was simply never
 * copied down the file.
 *
 * `deleteMember` is the one that costs real money. Member is referenced by
 * Attendance, BodyMetric, Booking, ReminderLog, WorkoutLog and — the serious
 * one — Transaction. CLAUDE.md records that Transaction is the durable
 * append-only cash ledger and "the only correct source for any report or
 * chart". Hard-deleting a member detaches their rows from a member that no
 * longer exists, and every financial total silently stops reconciling with
 * no error anywhere.
 *
 * ============================================================================
 * WHY deleteEmployee IS DELIBERATELY NOT IN THIS LIST
 * ============================================================================
 * Employee is referenced by about ten models, but most of those paths are
 * `createdBy`/`updatedBy` audit stamps — BlogMaster, EmailFor, EmailSetup,
 * EmailTemplate, EmailTo, Department. getReferencingCounts cannot tell an
 * audit stamp from an operational link, so wiring it in here would refuse to
 * delete any employee who had ever created an email template.
 *
 * The owner asked, in as many words, for super admins to be able to DELETE
 * staff rather than only deactivate them. Adding this guard to deleteEmployee
 * would take that away while looking like a safety improvement. Separating
 * "this row records that you once did something" from "this row depends on
 * you existing" is a real design decision and is not made here.
 *
 * deleteEmployee is not unguarded: middlewares/superAdminFloor.js already
 * stops it removing the last way into the system, and employeeAccessError
 * stops a branch admin reaching across branches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** A handler's own code, comments removed, to the next top-level declaration. */
const handler = (file, name) => {
  const src = read(file);
  const i = src.indexOf(`export const ${name}`);
  assert.ok(i !== -1, `${name} not found in ${file}`);
  const rest = src.slice(i + 10);
  const next = rest.match(/\n(?:export )?const \w+/);
  return stripComments(rest.slice(0, next ? next.index : rest.length));
};

const GUARDED = [
  ["controllers/v1/location.controller.js", "deleteState", "State"],
  ["controllers/v1/location.controller.js", "deleteCity", "City"],
  ["controllers/v1/member.controller.js", "deleteMember", "Member"],
];

for (const [file, name, model] of GUARDED) {
  test(`${name} counts referencing rows before deleting`, () => {
    const body = handler(file, name);
    assert.match(
      body,
      /getReferencingCounts/,
      `deleting a ${model} that other rows point at orphans them silently`,
    );
    assert.match(
      body,
      new RegExp(`getReferencingCounts\\(\\s*"${model}"`),
      `the guard must be asked about ${model}, not some other model`,
    );
  });

  test(`${name} refuses BEFORE the row is removed`, () => {
    const body = handler(file, name);
    const guardAt = body.search(/getReferencingCounts/);
    const deleteAt = body.search(/findByIdAndDelete|findOneAndDelete|deleteOne/);
    assert.ok(deleteAt !== -1, `${name} does not appear to delete anything`);
    assert.ok(
      guardAt !== -1 && guardAt < deleteAt,
      "a check that runs after the delete is not a check",
    );
  });
}

test("deleteCountry keeps the guard it already had", () => {
  assert.match(
    handler("controllers/v1/location.controller.js", "deleteCountry"),
    /getReferencingCounts\(\s*"Country"/,
    "this is the pattern the other two were copied from",
  );
});

test("deleteMember still refuses across branches", () => {
  const body = handler("controllers/v1/member.controller.js", "deleteMember");
  assert.match(
    body,
    /scopeFilter\(req\)/,
    "the reference guard must not have displaced the branch scoping — a hard " +
      "delete of another branch's member has no soft-delete to undo it",
  );
});

test("deleteEmployee is deliberately NOT reference-guarded", () => {
  const body = handler("controllers/v1/employee.controller.js", "deleteEmployee");
  assert.doesNotMatch(
    body,
    /getReferencingCounts/,
    "Employee is referenced mostly by createdBy audit stamps, so this would " +
      "refuse to delete anyone who had ever created an email template — and " +
      "the owner explicitly asked for staff to be deletable, not just " +
      "deactivatable. See this file's header.",
  );
  assert.match(
    body,
    /lastSuperAdminError/,
    "it is guarded, just not this way: the super admin floor still applies",
  );
});
