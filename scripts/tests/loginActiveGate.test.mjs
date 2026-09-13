/**
 * A deactivated staff account must not be able to sign in.
 *
 * loginEmployee had no isActive check at all. The admin screen set the flag,
 * every listing honoured it, and login ignored it — so "deactivating" someone
 * removed them from view while leaving their password working. It surfaced
 * when a second, undocumented super admin was retired and the login was tested
 * rather than assumed: it answered "Login successful".
 *
 * loginCompany already filters on `isActive: true` in its query, so the two
 * paths disagreed. These tests pin the rule for both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const employeeSrc = fs.readFileSync("controllers/v1/employee.controller.js", "utf8");
const companySrc = fs.readFileSync("controllers/v1/company.controller.js", "utf8");

test("employee login rejects a deactivated account", () => {
  const login = employeeSrc.slice(employeeSrc.indexOf("loginEmployee"));
  const guard = login.slice(0, login.indexOf("isAccountLocked"));
  assert.match(
    guard,
    /employee\.isActive === false/,
    "loginEmployee must refuse an account with isActive:false BEFORE it verifies the password",
  );
});

test("employee login does not reveal that a deactivated account exists", () => {
  const login = employeeSrc.slice(employeeSrc.indexOf("export const loginEmployee"));
  const guard = login.slice(0, login.indexOf("isAccountLocked"));
  // Strip comments first. The previous version of this test grepped the raw
  // source for the word "deactivated" and matched its OWN explanatory comment,
  // which is a test that fails on prose rather than on behaviour.
  const code = guard.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The inactive branch must share the unknown-address response; a distinct
  // "account disabled" message confirms the address is real.
  assert.match(code, /isActive === false[\s\S]{0,200}Invalid credentials/);
  assert.doesNotMatch(code, /disabled|deactivated/i);
});

test("company login filters on isActive in its query", () => {
  // loginCompany resolves the account through findUserByEmail, so that helper
  // is where the rule lives. Slicing from the first textual "loginCompany"
  // landed in a comment and missed it entirely.
  const helper = companySrc.slice(companySrc.indexOf("const findUserByEmail"));
  assert.match(
    helper.slice(0, 900),
    /isActive:\s*true/,
    "findUserByEmail must scope the company login lookup to active accounts",
  );
});
