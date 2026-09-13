/**
 * The audit trail: a GLOBAL mongoose plugin that records every staff-driven
 * write, wired to the request through AsyncLocalStorage.
 *
 * ============================================================================
 * IMPORT THIS MODULE BEFORE ANY MODEL IS IMPORTED.
 * ============================================================================
 * `mongoose.plugin()` only reaches schemas compiled AFTER the call. server.js
 * therefore imports this file as its FIRST relative import — ESM evaluates
 * import declarations in textual order, so putting it first is what guarantees
 * every schema underneath it is covered. Move that import down the file and
 * the models above it silently stop being audited, with nothing logged.
 *
 * WHY A HOOK AND NOT A CALL IN EACH CONTROLLER
 * A controller-side `writeAuditLog(...)` is forgotten the first time somebody
 * adds an endpoint in a hurry, and the gap is invisible — the missing rows look
 * exactly like "nothing happened". A hook cannot be skipped. The price is that
 * a hook has no request, which is what middlewares/requestContext.js solves.
 *
 * WHAT IS AND IS NOT RECORDED
 *   - Reads are NEVER recorded. Only save/update/delete hooks are registered,
 *     so a list or a report writes nothing. (An audit log that grew on reads
 *     would be larger than the data and would bury the changes.)
 *   - Only writes with a STAFF actor are recorded. A member-portal check-in
 *     (JWT, no session) and an anonymous contact-form insert are the member's
 *     own activity, not staff changing records, and they have their own trails.
 *   - A write with no request behind it at all — a seed, a CLI script — is not
 *     recorded, because there is nobody to attribute it to. Seeds would
 *     otherwise write thousands of rows attributed to "system" on first run.
 *   - Secrets are redacted before anything is stored. See REDACT_KEY_PATTERN.
 *
 * FAILURE MODE, CHOSEN DELIBERATELY: an audit write that throws is swallowed
 * and logged to stderr. Losing an audit row is bad; failing a member's renewal
 * because the audit collection was briefly unavailable is worse.
 */
import mongoose from "mongoose";
import AuditLog from "../models/AuditLog.js";
import {
  getRequestActor,
  getRequestMeta,
} from "../middlewares/requestContext.js";

/**
 * Models that must never be audited.
 *
 *   AuditLog     — auditing the audit log is an infinite loop.
 *   LoginAttempt — one row per failed password, already its own security trail.
 *   Otp          — short-lived codes; storing them here would be storing the
 *                  credential itself in a more widely-read collection.
 *   Counter      — the receipt-number counter. Mechanical, one increment per
 *                  receipt, and the receipt itself is already audited.
 */
const NEVER_AUDIT = new Set(["AuditLog", "LoginAttempt", "Otp", "Counter"]);

/**
 * Any key whose NAME matches this never has its VALUE stored.
 *
 * Matched on the key, not the value, and applied at every depth, so a secret
 * cannot slip through by being nested. Deliberately broad: a false positive
 * costs one unreadable field in a diff, a false negative puts a bcrypt hash or
 * a Gmail app password into a screen half the staff can open.
 */
const REDACT_KEY_PATTERN =
  /(pass|password|secret|token|jwt|apikey|api_key|appkey|credential|salt|otp|sessionid|cookie|authorization|privatekey)/i;

const REDACTED = "[REDACTED]";

/** Bookkeeping fields nobody reads in a diff. */
const IGNORED_KEYS = new Set(["__v", "updatedAt", "createdAt"]);

/** Per-side cap. A 5 MB embedded array must not become a 5 MB audit row. */
const MAX_SIDE_BYTES = 16 * 1024;

/** Deep copy with secret keys blanked. Depth-capped so a cycle cannot hang. */
const redact = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[DEPTH LIMIT]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (Buffer.isBuffer(value)) return "[BUFFER]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = REDACT_KEY_PATTERN.test(key)
        ? REDACTED
        : redact(val, depth + 1);
    }
    return out;
  }

  return value;
};

/** Trims a side to the cap. Returns [value, wasTruncated]. */
const capSize = (value) => {
  if (value === null || value === undefined) return [value, false];
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return ["[UNSERIALISABLE]", true];
  }
  if (!json || Buffer.byteLength(json, "utf8") <= MAX_SIDE_BYTES) {
    return [value, false];
  }
  return [
    {
      note: "Value omitted — larger than the audit row size cap",
      bytes: json.length,
    },
    true,
  ];
};

/**
 * A plain object for any document-ish input. NOT redacted — see record().
 *
 * Redaction happens at the very end, after the diff has been taken, and the
 * ordering is load-bearing: redacting first turns "passwordHash changed from A
 * to B" into "[REDACTED] -> [REDACTED]", which compares EQUAL, which makes the
 * diff empty, which means a password change writes NO AUDIT ROW AT ALL. The
 * one event most worth recording would be the one event silently missing.
 *
 * So the raw values are compared, and only the surviving slices are redacted.
 * Nothing raw is ever persisted or returned.
 */
const snapshot = (doc) => {
  if (!doc) return null;
  return typeof doc.toObject === "function"
    ? doc.toObject({ depopulate: true, virtuals: false, getters: false })
    : doc;
};

/** Stable comparison that does not care about key order or Date identity. */
const sameValue = (a, b) => {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
};

/**
 * Top-level fields that differ, plus the two sides narrowed to just those.
 *
 * Narrowing matters: an update that changes a phone number should produce a row
 * that says "mobileNumber: A -> B", not two copies of the whole member.
 */
const diffSides = (before, after) => {
  if (!before || !after) {
    return { changedFields: [], beforeSlice: before, afterSlice: after };
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedFields = [];
  const beforeSlice = {};
  const afterSlice = {};

  for (const key of keys) {
    if (key === "_id" || IGNORED_KEYS.has(key)) continue;
    if (sameValue(before[key], after[key])) continue;
    changedFields.push(key);
    beforeSlice[key] = before[key] ?? null;
    afterSlice[key] = after[key] ?? null;
  }

  return { changedFields, beforeSlice, afterSlice };
};

/** The most human name available on a row, so a list reads without joins. */
const labelOf = (plain) => {
  if (!plain || typeof plain !== "object") return "";
  const candidate =
    plain.fullName ||
    plain.employeeName ||
    plain.name ||
    plain.menuName ||
    plain.menuGroupName ||
    plain.title ||
    plain.receiptNo ||
    plain.trainerName ||
    plain.label ||
    plain.email ||
    plain.mobileNumber ||
    "";
  return String(candidate).slice(0, 120);
};

/**
 * Which branch the change belongs to.
 *
 * The document's own branch wins, because that is whose data changed. Falling
 * back to the actor's branch keeps a branch admin's edits to branch-less
 * masters visible to that branch admin. A super admin editing a branch-less
 * master lands on null, which only a super admin can read back.
 */
const branchOf = (before, after, actor) =>
  after?.branch || before?.branch || actor?.branch || null;

/** Writes the row. Never throws — see the file header. */
const writeLog = async (entry) => {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    console.error("⚠️ Audit log write failed:", err?.message || err);
  }
};

/**
 * Shared assembly for every action.
 *
 * `before` and `after` arrive RAW. The order of operations here matters:
 * diff first, redact second, cap third. Redacting before the diff would
 * collapse every secret to the same placeholder on both sides and silently
 * drop password and app-password changes from the trail entirely.
 */
const record = async ({
  action,
  modelName,
  documentId,
  before,
  after,
  actor,
}) => {
  const meta = getRequestMeta();

  let changedFields = [];
  let beforeOut = before;
  let afterOut = after;

  if (action === "UPDATE") {
    const d = diffSides(before, after);
    // Nothing actually changed — a no-op save is not an audit event.
    if (d.changedFields.length === 0) return;
    changedFields = d.changedFields;
    beforeOut = d.beforeSlice;
    afterOut = d.afterSlice;
  } else if (action === "CREATE") {
    changedFields = Object.keys(after || {}).filter(
      (k) => k !== "_id" && !IGNORED_KEYS.has(k),
    );
  }

  // Nothing raw goes past this line.
  const [beforeCapped, beforeTruncated] = capSize(redact(beforeOut));
  const [afterCapped, afterTruncated] = capSize(redact(afterOut));

  await writeLog({
    actor,
    action,
    collectionName: modelName || "Unknown",
    documentId: documentId ? String(documentId) : null,
    documentLabel: labelOf(after) || labelOf(before),
    before: beforeCapped,
    after: afterCapped,
    changedFields: changedFields.slice(0, 60),
    branch: branchOf(before, after, actor),
    ...meta,
    truncated: beforeTruncated || afterTruncated,
  });
};

/**
 * Should this write be audited at all?
 *
 * Returns the staff actor, or null to skip — and skipping early is what keeps
 * the plugin cheap: with no actor, the "fetch the previous state" read below
 * never happens, so member-portal traffic and seeds pay nothing for this.
 */
const auditableActor = (modelName) => {
  if (!modelName || NEVER_AUDIT.has(modelName)) return null;
  return getRequestActor();
};

/**
 * The plugin. Registered globally at the bottom of this file; exported so a
 * test can apply it to a throwaway schema in isolation.
 */
export function auditPlugin(schema) {
  // ===== Document middleware: doc.save() =====
  schema.pre("save", async function auditPreSave() {
    try {
      /**
       * Subdocuments are the parent's business, not their own event.
       *
       * A global plugin IS applied to child schemas — the per-plugin option
       * does not gate that; only `mongoose.set("applyPluginsToChildSchemas",
       * false)` does, and flipping a global switch for one plugin's benefit is
       * the wrong lever. So Member.payments[] carries these hooks too, and
       * without this guard every member save would emit a second, contentless
       * row for each payment subdocument.
       *
       * (`this.constructor.modelName` is undefined on an embedded document, so
       * auditableActor() below would bail anyway — but relying on a coincidence
       * for correctness is how it stops being true after an upgrade.)
       */
      if (this.$isSubdocument) return;

      const modelName = this.constructor?.modelName;
      const actor = auditableActor(modelName);
      if (!actor) return;

      if (this.isNew) {
        this.$locals.audit = { actor, isNew: true, before: null };
        return;
      }

      /**
       * One extra read per audited update, and it is the price of an honest
       * "before". Mongoose keeps no clean public copy of the pre-modification
       * document, and reconstructing one from modifiedPaths() would record what
       * the caller INTENDED rather than what was actually replaced.
       *
       * It only runs for staff-session writes on an existing row, which at this
       * gym's volume is a handful per minute.
       */
      const previous = await this.constructor.findById(this._id).lean().exec();
      this.$locals.audit = { actor, isNew: false, before: previous };
    } catch (err) {
      console.error("⚠️ Audit pre-save capture failed:", err?.message || err);
    }
  });

  schema.post("save", async function auditPostSave(doc) {
    try {
      const pending = this.$locals?.audit;
      if (!pending) return;
      this.$locals.audit = null;

      await record({
        action: pending.isNew ? "CREATE" : "UPDATE",
        modelName: this.constructor?.modelName,
        documentId: doc?._id,
        before: pending.before,
        after: snapshot(doc),
        actor: pending.actor,
      });
    } catch (err) {
      console.error("⚠️ Audit post-save failed:", err?.message || err);
    }
  });

  // ===== Query middleware: findOneAndUpdate / updateOne =====
  //
  // `{ query: true, document: false }` is spelled out because updateOne and
  // deleteOne exist as BOTH query and document middleware in Mongoose 8, and
  // which one a bare pre("updateOne") registers has changed between major
  // versions. Being explicit means an upgrade cannot quietly switch it.
  schema.pre(
    ["findOneAndUpdate", "updateOne"],
    { query: true, document: false },
    async function auditPreUpdate() {
      try {
        const actor = auditableActor(this.model?.modelName);
        if (!actor) return;
        const previous = await this.model
          .findOne(this.getFilter())
          .lean()
          .exec();
        this.__audit = {
          actor,
          // RAW on purpose — record() diffs before it redacts.
          before: previous,
          id: previous?._id || null,
        };
      } catch (err) {
        console.error(
          "⚠️ Audit pre-update capture failed:",
          err?.message || err,
        );
      }
    },
  );

  schema.post(
    ["findOneAndUpdate", "updateOne"],
    { query: true, document: false },
    async function auditPostUpdate() {
      try {
        const pending = this.__audit;
        if (!pending) return;
        this.__audit = null;

        // Refetch by _id rather than trusting the hook's result argument: with
        // the default `new: false` the result IS the pre-update document, and
        // updateOne hands back a write summary with no document at all.
        const updated = pending.id
          ? await this.model.findById(pending.id).lean().exec()
          : null;

        await record({
          // A findOneAndUpdate with upsert:true and no match is a create.
          action: pending.before ? "UPDATE" : "CREATE",
          modelName: this.model?.modelName,
          documentId: pending.id,
          before: pending.before,
          after: updated,
          actor: pending.actor,
        });
      } catch (err) {
        console.error("⚠️ Audit post-update failed:", err?.message || err);
      }
    },
  );

  // ===== Query middleware: findOneAndDelete / deleteOne =====
  schema.pre(
    ["findOneAndDelete", "deleteOne"],
    { query: true, document: false },
    async function auditPreDelete() {
      try {
        const actor = auditableActor(this.model?.modelName);
        if (!actor) return;
        const previous = await this.model
          .findOne(this.getFilter())
          .lean()
          .exec();
        if (!previous) return;
        this.__audit = { actor, before: previous, id: previous._id };
      } catch (err) {
        console.error(
          "⚠️ Audit pre-delete capture failed:",
          err?.message || err,
        );
      }
    },
  );

  schema.post(
    ["findOneAndDelete", "deleteOne"],
    { query: true, document: false },
    async function auditPostDelete() {
      try {
        const pending = this.__audit;
        if (!pending) return;
        this.__audit = null;

        await record({
          action: "DELETE",
          modelName: this.model?.modelName,
          documentId: pending.id,
          before: pending.before,
          after: null,
          actor: pending.actor,
        });
      } catch (err) {
        console.error("⚠️ Audit post-delete failed:", err?.message || err);
      }
    },
  );

  // ===== Bulk operations =====
  //
  // A bulk write is summarised as ONE row carrying the filter and the counts,
  // not one row per document. A deleteMany that removes 4000 members must be
  // visible in the audit log; it must not BE the audit log.
  schema.pre(
    ["updateMany", "deleteMany"],
    { query: true, document: false },
    async function auditPreBulk() {
      try {
        const actor = auditableActor(this.model?.modelName);
        if (!actor) return;
        this.__auditBulk = {
          actor,
          filter: this.getFilter(),
          matched: await this.model.countDocuments(this.getFilter()),
        };
      } catch (err) {
        console.error("⚠️ Audit pre-bulk capture failed:", err?.message || err);
      }
    },
  );

  schema.post(
    ["updateMany", "deleteMany"],
    { query: true, document: false },
    async function auditPostBulk(result) {
      try {
        const pending = this.__auditBulk;
        if (!pending) return;
        this.__auditBulk = null;

        await record({
          action: this.op === "deleteMany" ? "DELETE_MANY" : "UPDATE_MANY",
          modelName: this.model?.modelName,
          documentId: null,
          before: { filter: pending.filter, matched: pending.matched },
          after: {
            modified: result?.modifiedCount ?? null,
            deleted: result?.deletedCount ?? null,
          },
          actor: pending.actor,
        });
      } catch (err) {
        console.error("⚠️ Audit post-bulk failed:", err?.message || err);
      }
    },
  );

  schema.post("insertMany", async function auditPostInsertMany(docs) {
    try {
      const actor = auditableActor(this.modelName);
      if (!actor) return;
      const rows = Array.isArray(docs) ? docs : [docs];

      await record({
        action: "CREATE_MANY",
        modelName: this.modelName,
        documentId: null,
        before: null,
        after: {
          inserted: rows.length,
          ids: rows.slice(0, 50).map((d) => String(d?._id || "")),
        },
        actor,
      });
    } catch (err) {
      console.error("⚠️ Audit post-insertMany failed:", err?.message || err);
    }
  });
}

/**
 * Register globally, for every schema compiled from here on.
 *
 * Note what this does NOT do: it does not exempt child schemas. Mongoose
 * applies global plugins to subdocument schemas as well, and the only switch
 * for that is the process-wide `mongoose.set("applyPluginsToChildSchemas",
 * false)`, which would change behaviour for every plugin rather than this one.
 * The hooks guard themselves with `$isSubdocument` instead — verified, not
 * assumed: scripts/tests/auditLog.test.mjs covers it.
 */
mongoose.plugin(auditPlugin);

export default auditPlugin;
