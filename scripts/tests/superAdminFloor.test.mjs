/**
 * The last super admin must survive every path that could remove it — and the
 * guard has to look in the right table.
 *
 * TWO REAL GAPS, both found by audit after the first fix shipped:
 *
 * C1 — the guard added to employee.controller.js counts `Employee` rows with
 * isSuperAdmin. Live, that count is ZERO: the only super admin in this system
 * is a CompanyMaster row. So the guard was correct code pointed at the wrong
 * collection and would never have fired for the account it exists to protect.
 * DELETE /companies/:id had no floor at all, and the only account that passes
 * requireSuperAdmin is that very row.
 *
 * C2 — PUT /companies/:id is the ONLY company route without requireSuperAdmin
 * (POST, DELETE and GET all have it) and without allowOnlyFields. The handler
 * re-hashes req.body.password onto the row and accepts isActive. So any
 * CompanyMaster login could POST a new password onto the super admin's row and
 * take the system over, or set isActive:false and lock everyone out for good —
 * findUserByEmail filters on isActive:true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Sources are read with carriage returns stripped.
 *
 * These files are CRLF on disk, so any pattern written with a bare newline
 * matches nothing at all and the test reports a guarded route as unguarded.
 * That cost a full debugging cycle once; normalising at the door is cheaper
 * than remembering it at every call site.
 */
const read = (f) => fs.readFileSync(f, "utf8").split("\r").join("");

const routes = read("routes/v1/companies.routes.js");
const company = read("controllers/v1/company.controller.js");

/**
 * One route registration, from `router.<method>(` to its closing `);`.
 *
 * The first version of this helper built a RegExp out of an ordinary string
 * literal, so every escape was consumed before RegExp ever saw it and the
 * pattern matched some unrelated stretch of the file. Index arithmetic has no
 * escaping layer to get wrong, and slicing to the closing paren means a long
 * explanatory comment can never push a middleware out of a fixed-size window.
 */
const routeBlock = (method, path) => {
  const head = `router.${method}(\n  "${path}"`;
  const i = routes.indexOf(head);
  assert.ok(i !== -1, `${method.toUpperCase()} ${path} not found`);
  const end = routes.indexOf("\n);", i);
  assert.ok(end !== -1, `${method.toUpperCase()} ${path} has no closing paren`);
  return routes.slice(i, end);
};

test("C2: PUT /companies/:id requires a super admin", () => {
  assert.match(
    routeBlock("put", "/companies/:id"),
    /requireSuperAdmin/,
    "the only company route without it, and it can rewrite the super admin's password",
  );
});

test("C2: PUT /companies/:id restricts which fields a body may set", () => {
  assert.match(
    routeBlock("put", "/companies/:id"),
    /allowOnlyFields/,
    "password and isActive reach the row straight from req.body",
  );
});

test("C1: the floor is shared, not per-controller", () => {
  assert.ok(
    fs.existsSync("middlewares/superAdminFloor.js"),
    "one module both controllers call, so the count cannot drift between them",
  );
});

test("C1: the floor counts BOTH tables", () => {
  const floor = read("middlewares/superAdminFloor.js");
  assert.match(floor, /CompanyMaster/, "the live super admin is a CompanyMaster row");
  assert.match(floor, /Employee/, "and an Employee may hold the flag too");
  assert.match(floor, /isActive/, "a deactivated super admin is not a way back in");
});

test("C1: employee.controller uses the shared floor, not a private copy", () => {
  const employee = read("controllers/v1/employee.controller.js");
  assert.match(
    employee,
    /middlewares\/superAdminFloor\.js/,
    "its own copy counted Employee rows only — live, that count is zero",
  );
});

test("C1: deleting a company checks the floor before deleting", () => {
  const i = company.indexOf("export const deleteCompanyMaster");
  assert.ok(i !== -1, "deleteCompanyMaster not found");
  const body = company.slice(i, i + 2600);
  assert.match(body, /lastSuperAdminError/, "must consult the floor");
  const guardAt = body.search(/lastSuperAdminError/);
  const deleteAt = body.search(/findByIdAndDelete|deleteOne|findOneAndDelete/);
  assert.ok(
    guardAt !== -1 && deleteAt !== -1 && guardAt < deleteAt,
    "the check must run BEFORE the row is removed",
  );
});

test("C1: deactivating a company checks the floor too", () => {
  const i = company.indexOf("export const updateCompanyMaster");
  assert.ok(i !== -1, "updateCompanyMaster not found");
  const body = company.slice(i, i + 4000);
  assert.match(
    body,
    /lastSuperAdminError/,
    "isActive:false on the last super admin locks everyone out exactly as a delete does",
  );
});
