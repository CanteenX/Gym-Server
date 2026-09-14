/**
 * The department list must not be filtered by who created each row.
 *
 * ============================================================================
 * THE SAME BUG, THE THIRD TIME
 * ============================================================================
 * This shape is already documented at length in employee.controller.js, where
 * it was found and removed: a per-creator filter
 *
 *     if (req.user.role === "EMPLOYEE") {
 *       matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
 *     }
 *
 * inherited from the SaaS template this codebase started from. `role` here is
 * which TABLE you logged in from, not your privilege level — so EVERY staff
 * login is "EMPLOYEE", branch admin and front desk alike. The super admin is a
 * CompanyMaster row and is the only login that escapes it.
 *
 * Because the super admin created these two departments, every branch admin
 * asking for the list got `[]`. Measured live: 2 departments in the database,
 * 0 returned to the Vasna admin.
 *
 * And an empty list is the worst possible way for this to fail. It reads as
 * "no departments exist yet", not as "you were filtered out of your own
 * lookup", so nothing anywhere reports an error. Gym-Admin's Employee form
 * loads this into its Department dropdown and then refuses to submit without a
 * selection, so the visible symptom was a branch admin unable to save any
 * employee — with no message naming the cause.
 *
 * ============================================================================
 * WHY OWNERSHIP IS THE WRONG MODEL HERE SPECIFICALLY
 * ============================================================================
 * A department is a two-row global master ("SuperAdmin", "Gym Admin"). It has
 * no branch dimension and no tenant dimension — there is nothing for it to be
 * scoped BY. models/Branch.js's listBranches, the closest comparable master,
 * has no createdBy filter for exactly this reason.
 *
 * This is NOT a general licence to drop scoping. Where a collection genuinely
 * belongs to a branch, scope it with middlewares/branchScope.js — the point is
 * that "whoever typed it in" was never the right axis for a shared lookup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");
const src = read("controllers/v1/department.controller.js");

/**
 * Comments stripped, because the FIX is a comment that quotes the bug.
 *
 * The removed filter is explained in place — deliberately, so nobody pastes it
 * back from one of the sibling controllers that still carries it — and the
 * explanation necessarily contains the word `createdBy`. A raw text search
 * therefore matches the cure as readily as the disease. This asserts about
 * code only; test 3 below separately asserts the explanation still exists.
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** A handler body, stopping at the next top-level declaration of any kind. */
const block = (name) => {
  const i = src.indexOf(`export const ${name}`);
  assert.ok(i !== -1, `${name} not found`);
  const rest = src.slice(i + 10);
  const next = rest.match(/\n(?:export )?const \w+/);
  return stripComments(rest.slice(0, next ? next.index : rest.length));
};

for (const handler of ["listDepartments", "listDepartmentByParams"]) {
  test(`${handler} does not filter by createdBy`, () => {
    assert.doesNotMatch(
      block(handler),
      /createdBy/,
      "every staff login has role EMPLOYEE, so this returns [] to every branch " +
        "admin and empties the Employee form's Department dropdown",
    );
  });
}

test("the reason is recorded in the controller, not only here", () => {
  assert.match(
    src,
    /createdBy/,
    "the removed filter must be explained in place, or it gets pasted back in " +
      "from one of the sibling controllers that still carries it",
  );
});
