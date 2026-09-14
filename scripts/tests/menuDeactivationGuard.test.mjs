/**
 * Deactivating a menu row is not a cosmetic act — it revokes an API.
 *
 * ============================================================================
 * THE CONFLATION AT THE ROOT OF THIS
 * ============================================================================
 * models/MenuMaster.js has exactly one switch, `isActive`, and it means two
 * unrelated things at once:
 *
 *   1. "show this in the sidebar"  — what an admin thinks they are toggling;
 *   2. "this menu backs an API"    — hasMenuPermission() looks the url up with
 *      `{ menuUrl, isActive: true }`, so an inactive row returns menuFound
 *      false and 403s every non-super-admin.
 *
 * There is no third flag. So hiding a screen silently switches off every route
 * gated on its url, for everyone except the super admin — who bypasses the
 * check entirely and therefore cannot see that anything broke.
 *
 * ============================================================================
 * THE LIVE CASE THIS WAS WRITTEN FOR
 * ============================================================================
 * The `/department` row is inactive — somebody hid the Department screen,
 * reasonably: this is a gym, not an HR system. Six department routes are gated
 * on that url, and `Gym-Admin/src/pages/Setup/Employee.jsx` calls the list one
 * to fill its Department dropdown, then refuses to submit without a selection
 * ("Department is required"). For a branch admin the chain ran:
 *
 *     open Employee form -> GET /departments -> 403 -> empty dropdown ->
 *     "Department is required" -> cannot create or edit ANY employee.
 *
 * The super admin never saw it. CLAUDE.md already records that
 * `Employee.departmentId` is OPTIONAL by design ("a branch admin is a login,
 * not an HR record"), so the form's requirement contradicted the data model
 * as well.
 *
 * ============================================================================
 * THE RULE PINNED HERE
 * ============================================================================
 * A LOOKUP — a list read only to populate a picker on somebody else's screen —
 * must not be gated on the menu of the screen it belongs to, because that
 * couples an unrelated form to a sidebar toggle. It stays behind
 * authMiddleware; it is not public. Writes stay gated: creating and deleting
 * departments is genuinely the Department screen's business.
 *
 * This is the same reasoning CLAUDE.md records for why checkPermission is
 * deliberately absent from the gym routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");
const src = read("routes/v1/departments.routes.js");

/** One route registration, from `router.<method>(` to its closing `);`. */
const routeBlock = (method, path) => {
  const head = `router.${method}(\n  "${path}"`;
  const i = src.indexOf(head);
  assert.ok(i !== -1, `${method.toUpperCase()} ${path} not found`);
  const end = src.indexOf("\n);", i);
  assert.ok(end !== -1, `${method.toUpperCase()} ${path} has no closing paren`);
  return src.slice(i, end);
};

const LOOKUP_READS = [
  ["get", "/departments"],
  ["get", "/departments/:departmentId"],
  ["post", "/departments/search"],
];

for (const [method, path] of LOOKUP_READS) {
  test(`${method.toUpperCase()} ${path} is a lookup, not gated on a sidebar toggle`, () => {
    const block = routeBlock(method, path);
    assert.doesNotMatch(
      block,
      /checkPermission/,
      "the /department menu row is inactive, so this 403s every non-super-admin " +
        "and empties the Employee form's Department dropdown",
    );
    assert.match(
      block,
      /authMiddleware/,
      "a lookup is still staff-only — ungated is not the same as unauthenticated",
    );
  });
}

const GATED_WRITES = [
  ["post", "/departments", "write"],
  ["put", "/departments/:departmentId", "edit"],
  ["delete", "/departments/:departmentId", "delete"],
];

for (const [method, path, action] of GATED_WRITES) {
  test(`${method.toUpperCase()} ${path} still requires ${action}`, () => {
    assert.match(
      routeBlock(method, path),
      new RegExp(`checkPermission\\(\\s*"/department",\\s*"${action}"`),
      "opening up the reads must not open up the writes",
    );
  });
}

test("the reason is written down where the next person will look", () => {
  assert.match(
    src,
    /isActive/,
    "the file must explain that the /department menu row is inactive and what that does",
  );
});
