/**
 * OFFLINE tests for the audit log: does AsyncLocalStorage actually reach a
 * mongoose hook, and is the row it produces safe to show people?
 *
 * Run:  node --test scripts/tests/auditLog.test.mjs
 *
 * NO DATABASE. The plugin's hook functions are pulled off a throwaway schema
 * and invoked directly with a stand-in document, which is exactly how mongoose
 * calls them — and it means the ASSERTION IS ABOUT THE REAL HOOK BODY, not a
 * re-implementation of it. AuditLog.create is stubbed so the row can be read
 * without writing anything.
 *
 * The claim under test is the one the whole design rests on: a mongoose hook
 * has no request, so it should not be able to name an actor — and with
 * AsyncLocalStorage it can.
 */
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { auditPlugin } from "../../services/auditLog.js";
import AuditLog from "../../models/AuditLog.js";
import {
  runWithContext,
  getRequestActor,
  getRequestMeta,
} from "../../middlewares/requestContext.js";

/** A staff request, as express-session would leave it. */
const staffReq = (overrides = {}) => ({
  session: {
    user: {
      id: "emp-1",
      role: "EMPLOYEE",
      name: "Gotri Manager",
      email: "gotri@example.com",
      branch: "Gotri",
      isSuperAdmin: false,
      ...overrides,
    },
  },
  method: "PUT",
  originalUrl: "/api/v1/members/abc123?x=1",
  headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.9" },
  ip: "10.0.0.1",
});

/** The plugin's own hook functions, as mongoose will call them. */
const hooksFor = () => {
  const schema = new mongoose.Schema({ fullName: String, branch: String });
  auditPlugin(schema);
  return {
    preSave: schema.s.hooks._pres.get("save").at(-1).fn,
    postSave: schema.s.hooks._posts.get("save").at(-1).fn,
  };
};

/** Captures whatever the plugin tried to persist. */
const captureRows = () => {
  const original = AuditLog.create;
  const rows = [];
  AuditLog.create = async (entry) => {
    rows.push(entry);
    return entry;
  };
  return { rows, restore: () => (AuditLog.create = original) };
};

/**
 * A stand-in for a mongoose document mid-save. `constructor` carries the model
 * name and findById, which is what the pre-save hook reaches through.
 */
const fakeDoc = ({ isNew, before, after, modelName = "Member" }) => ({
  isNew,
  _id: "doc-1",
  $locals: {},
  constructor: {
    modelName,
    findById: () => ({ lean: () => ({ exec: async () => before }) }),
  },
  toObject: () => after,
});

// ===================================================================
// 1. The load-bearing claim: the context survives into the hook
// ===================================================================

test("AsyncLocalStorage: the store survives await, Promise.all and a timer", async () => {
  await runWithContext({ req: staffReq() }, async () => {
    assert.equal(getRequestActor().id, "emp-1");

    await Promise.resolve();
    assert.equal(getRequestActor().id, "emp-1", "lost across await");

    await Promise.all([
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(
          getRequestActor().branch,
          "Gotri",
          "lost across Promise.all + timer",
        );
      })(),
    ]);
  });

  // And it does NOT leak back out — a request's actor must not become the
  // ambient actor for whatever runs next in the process.
  assert.equal(getRequestActor(), null);
});

test("a mongoose hook with no request has no actor, and writes nothing", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    const doc = fakeDoc({ isNew: true, before: null, after: { fullName: "A" } });
    await preSave.call(doc);
    await postSave.call(doc, doc);
    assert.equal(cap.rows.length, 0, "a seed or CLI write must not be audited");
  } finally {
    cap.restore();
  }
});

test("the same hook, inside a request, records who did it", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      const doc = fakeDoc({
        isNew: true,
        before: null,
        after: { _id: "doc-1", fullName: "New Member", branch: "Gotri" },
      });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });

    assert.equal(cap.rows.length, 1);
    const row = cap.rows[0];
    assert.equal(row.action, "CREATE");
    assert.equal(row.collectionName, "Member");
    assert.equal(row.actor.id, "emp-1");
    assert.equal(row.actor.name, "Gotri Manager");
    assert.equal(row.actor.branch, "Gotri");
    assert.equal(row.documentLabel, "New Member");
    assert.equal(row.branch, "Gotri");
    // The IP is taken from x-forwarded-for, not req.ip — see utils/clientIp.js.
    assert.equal(row.ip, "203.0.113.9");
    assert.equal(row.method, "PUT");
    assert.equal(row.path, "/api/v1/members/abc123", "query string stripped");
  } finally {
    cap.restore();
  }
});

test("a member-portal write (JWT, no session user) is not audited", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    // requireMember sets req.member, never req.session.user.
    const memberReq = { session: {}, member: { id: "m-9" }, headers: {} };
    await runWithContext({ req: memberReq }, async () => {
      const doc = fakeDoc({ isNew: true, before: null, after: { fullName: "X" } });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });
    assert.equal(cap.rows.length, 0);
  } finally {
    cap.restore();
  }
});

// ===================================================================
// 2. The diff
// ===================================================================

test("an update records only the fields that changed, both sides", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      const doc = fakeDoc({
        isNew: false,
        before: {
          _id: "doc-1",
          fullName: "Asha",
          mobileNumber: "9990001111",
          branch: "Gotri",
          totalFee: 1200,
        },
        after: {
          _id: "doc-1",
          fullName: "Asha",
          mobileNumber: "9998887777",
          branch: "Gotri",
          totalFee: 3000,
        },
      });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });

    const row = cap.rows[0];
    assert.equal(row.action, "UPDATE");
    assert.deepEqual(row.changedFields.sort(), ["mobileNumber", "totalFee"]);
    assert.deepEqual(row.before, {
      mobileNumber: "9990001111",
      totalFee: 1200,
    });
    assert.deepEqual(row.after, { mobileNumber: "9998887777", totalFee: 3000 });
    assert.ok(!("fullName" in row.after), "unchanged fields must not be stored");
  } finally {
    cap.restore();
  }
});

test("a save that changes nothing writes no row", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      const same = { _id: "doc-1", fullName: "Asha", branch: "Gotri" };
      const doc = fakeDoc({ isNew: false, before: same, after: { ...same } });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });
    assert.equal(cap.rows.length, 0);
  } finally {
    cap.restore();
  }
});

// ===================================================================
// 3. Redaction — an audit log must not be the softest place to find a secret
// ===================================================================

test("secrets are redacted at every depth, on both sides of the diff", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      const doc = fakeDoc({
        isNew: false,
        modelName: "EmailSetup",
        before: {
          _id: "doc-1",
          host: "smtp.gmail.com",
          passwordHash: "$2b$10$OLDHASHOLDHASHOLDHASH",
          auth: { appPassword: "abcd efgh ijkl mnop" },
        },
        after: {
          _id: "doc-1",
          host: "smtp.gmail.com",
          passwordHash: "$2b$10$NEWHASHNEWHASHNEWHASH",
          auth: { appPassword: "zzzz yyyy xxxx wwww" },
        },
      });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });

    /**
     * The row MUST exist. This assertion is here because its absence was a real
     * bug: redaction used to run before the diff, so both sides of a password
     * change collapsed to "[REDACTED]", compared equal, and the change was
     * dropped as a no-op. A changed secret has to be recorded as an event even
     * though its value must not be.
     */
    assert.equal(cap.rows.length, 1, "a secret change must still be recorded");
    const row = cap.rows[0];
    assert.deepEqual(row.changedFields.sort(), ["auth", "passwordHash"]);

    const serialised = JSON.stringify(row);
    assert.doesNotMatch(serialised, /\$2b\$10\$/, "a bcrypt hash was stored");
    assert.doesNotMatch(serialised, /abcd efgh/, "an app password was stored");
    assert.doesNotMatch(serialised, /zzzz yyyy/, "an app password was stored");
    assert.match(serialised, /REDACTED/);
  } finally {
    cap.restore();
  }
});

test("an oversized document is replaced by a note rather than stored whole", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      const doc = fakeDoc({
        isNew: true,
        before: null,
        after: { _id: "doc-1", blob: "x".repeat(40_000) },
      });
      await preSave.call(doc);
      await postSave.call(doc, doc);
    });

    const row = cap.rows[0];
    assert.equal(row.truncated, true);
    assert.ok(row.after.note, "the oversized side should carry an explanation");
  } finally {
    cap.restore();
  }
});

// ===================================================================
// 4. Models that must never be audited
// ===================================================================

test("the denylisted models write no rows (AuditLog itself would recurse)", async () => {
  const cap = captureRows();
  try {
    for (const modelName of ["AuditLog", "LoginAttempt", "Otp", "Counter"]) {
      const { preSave, postSave } = hooksFor();
      await runWithContext({ req: staffReq() }, async () => {
        const doc = fakeDoc({
          isNew: true,
          modelName,
          before: null,
          after: { _id: "d", value: 1 },
        });
        await preSave.call(doc);
        await postSave.call(doc, doc);
      });
    }
    assert.equal(cap.rows.length, 0);
  } finally {
    cap.restore();
  }
});

test("a subdocument save is the parent's event, not its own", async () => {
  const { preSave, postSave } = hooksFor();
  const cap = captureRows();
  try {
    await runWithContext({ req: staffReq() }, async () => {
      // What mongoose hands the hook for an embedded doc: $isSubdocument true
      // and no modelName on the constructor.
      const sub = {
        $isSubdocument: true,
        _id: "pay-1",
        $locals: {},
        constructor: {},
        toObject: () => ({ amount: 1200 }),
        isNew: true,
      };
      await preSave.call(sub);
      await postSave.call(sub, sub);
    });
    assert.equal(
      cap.rows.length,
      0,
      "Member.payments[] must not emit rows of its own",
    );
  } finally {
    cap.restore();
  }
});

// ===================================================================
// 5. Request metadata
// ===================================================================

test("getRequestMeta is safe outside a request", () => {
  assert.deepEqual(getRequestMeta(), {
    ip: "",
    userAgent: "",
    method: "",
    path: "",
  });
});
