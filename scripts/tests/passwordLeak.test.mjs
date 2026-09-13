/**
 * OFFLINE tests for the "no password hash ever reaches a client" guarantee.
 *
 * Run:  node --test scripts/tests/passwordLeak.test.mjs
 *
 * NO DATABASE, following scripts/tests/superAdminGate.test.mjs: mongoose
 * schemas compile without a connection, so the REAL models are imported and
 * documents are hydrated in memory.
 *
 * ============================================================================
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE
 * ============================================================================
 *
 * A live audit found POST /auth/company/login, POST /auth/employee/login and
 * GET /companies/getCompanyDetails all returning the caller's bcrypt hash in
 * `data`. Every one of them got there the same way — the handler answered with
 * the whole Mongoose document, which is the obvious and natural thing to write
 * — and none of them failed, logged anything or looked wrong in the admin
 * panel. A leak that is invisible from the outside has to be pinned from the
 * inside.
 *
 * The three layers below are independent on purpose, and each test names the
 * layer it guards so that removing one is a test failure and not a surprise in
 * production six months from now:
 *
 *   1. `select: false` on the schema field  — the hash is not even loaded.
 *   2. a toJSON/toObject transform          — if something opts back in with
 *                                             `+password` (login must), the
 *                                             field still cannot serialise.
 *   3. middlewares/stripResponseSecrets.js  — catches .aggregate() and .lean()
 *                                             results, which are plain objects
 *                                             that layers 1 and 2 never see.
 *
 * Layer 2 is what currently carries Employee on its own: Employee.password is
 * still `select: false`-less because loginEmployee() reads it off a plain
 * findOne(). See the comment on that field in models/Employee.js.
 */
import test from "node:test";
import assert from "node:assert/strict";

import CompanyMaster from "../../models/CompanyMaster.js";
import Employee from "../../models/Employee.js";
import Member from "../../models/Member.js";
import Trainer from "../../models/Trainer.js";
import { __scrubForTests as scrub } from "../../middlewares/stripResponseSecrets.js";

const HASH = "$2b$10$notarealhashjustaplaceholdervalue00000000000000000000";

// ---------------------------------------------------------------------------
// Layer 1 — select: false
// ---------------------------------------------------------------------------

test("CompanyMaster.password is select:false, so a normal query never loads it", () => {
  assert.equal(
    CompanyMaster.schema.path("password").options.select,
    false,
    "Removing select:false puts the hash back on every findById() result",
  );
});

test("the member/trainer portal secrets keep their existing select:false", () => {
  // These were already correct. Pinned so the staff-side fix cannot be
  // 'tidied up' into a parallel convention that leaves these behind.
  assert.equal(Member.schema.path("passwordHash").options.select, false);
  assert.equal(Trainer.schema.path("passwordHash").options.select, false);
});

// ---------------------------------------------------------------------------
// Layer 2 — serialisation transforms
// ---------------------------------------------------------------------------

test("a CompanyMaster document drops password from toJSON AND toObject", () => {
  const doc = new CompanyMaster({
    companyName: "Mid City Gym",
    email: "owner@example.com",
    password: HASH,
    mobileNumber: "9000000000",
    gstNumber: "24ACQFS6351L2AI",
    address: "Vadodara",
    pincode: "390001",
    website: "example.com",
  });

  // The document itself still knows the hash — bcrypt.compare needs it.
  assert.equal(doc.password, HASH);

  assert.equal(doc.toJSON().password, undefined);
  // toObject matters just as much: loginCompany builds its response body with
  // user.toObject() and res.json() then never sees a Mongoose document.
  assert.equal(doc.toObject().password, undefined);
  assert.ok(!JSON.stringify(doc).includes(HASH));
});

test("an Employee document drops password from toJSON AND toObject", () => {
  const doc = new Employee({
    employeeName: "Branch Admin",
    roleId: "507f1f77bcf86cd799439011",
    emailOffice: "branch@example.com",
    password: HASH,
    branch: "Vasna",
  });

  assert.equal(doc.password, HASH);
  assert.equal(doc.toJSON().password, undefined);
  assert.equal(doc.toObject().password, undefined);
  // This is the exact shape POST /auth/employee/login answers with.
  assert.ok(!JSON.stringify({ isOk: true, data: doc }).includes(HASH));
});

test("the transform leaves every other field alone", () => {
  const doc = new Employee({
    employeeName: "Branch Admin",
    roleId: "507f1f77bcf86cd799439011",
    emailOffice: "branch@example.com",
    password: HASH,
    branch: "Gotri",
    isSuperAdmin: false,
  });

  const json = doc.toJSON();
  assert.equal(json.employeeName, "Branch Admin");
  assert.equal(json.emailOffice, "branch@example.com");
  assert.equal(json.branch, "Gotri");
  assert.equal(json.isSuperAdmin, false);
});

// ---------------------------------------------------------------------------
// Layer 3 — response scrubber, for .aggregate() and .lean()
// ---------------------------------------------------------------------------

test("scrub removes password from an aggregate-shaped list response", () => {
  // POST /employees-by-params returns exactly this: a $facet result whose rows
  // are plain objects straight out of the aggregation pipeline, with a second
  // copy of a staff row nested under a $lookup.
  const body = {
    data: [
      {
        count: 2,
        data: [
          { employeeName: "A", password: HASH, createdByEmployee: { employeeName: "B", password: HASH } },
          { employeeName: "C", password: HASH },
        ],
      },
    ],
    status: 200,
  };

  const out = scrub(body);

  assert.ok(!JSON.stringify(out).includes(HASH));
  assert.equal(out.data[0].count, 2);
  assert.equal(out.data[0].data[0].employeeName, "A");
  assert.equal(out.data[0].data[0].createdByEmployee.employeeName, "B");
});

test("scrub removes the portal spelling too", () => {
  const out = scrub({ data: { name: "M", passwordHash: HASH } });
  assert.equal(out.data.passwordHash, undefined);
  assert.equal(out.data.name, "M");
});

test("scrub returns the SAME reference when there is nothing to remove", () => {
  // Copy-on-write: the overwhelming majority of responses carry no credential
  // field, and they must not pay for a deep copy of themselves.
  const body = { isOk: true, data: [{ a: 1 }, { b: [2, 3] }] };
  assert.equal(scrub(body), body);
});

test("scrub does not mutate the body it was given", () => {
  // The handler may still be holding this object; deleting from it in place
  // would be a bug that only surfaces much later.
  const row = { employeeName: "A", password: HASH };
  const body = { data: [row] };

  scrub(body);

  assert.equal(row.password, HASH);
});

test("scrub leaves non-plain values (Date, ObjectId-like, Mongoose doc) intact", () => {
  const when = new Date("2026-01-01T00:00:00.000Z");
  const doc = new Employee({
    employeeName: "Branch Admin",
    roleId: "507f1f77bcf86cd799439011",
    emailOffice: "branch@example.com",
    password: HASH,
  });

  const body = { createdAt: when, data: doc, rows: [{ createdAt: when, password: HASH }] };
  const out = scrub(body);

  // Same Date instance, not a spread copy of its internals.
  assert.equal(out.createdAt, when);
  assert.equal(out.rows[0].createdAt, when);
  assert.equal(out.rows[0].password, undefined);
  // The document is passed through untouched — layer 2 handles it at
  // JSON.stringify time, and copying it here would strip its prototype.
  assert.equal(out.data, doc);
  assert.ok(!JSON.stringify(out).includes(HASH));
});
