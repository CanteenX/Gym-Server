import mongoose from "mongoose";

/**
 * Who changed what, when, from where.
 *
 * Rows are written by the global mongoose plugin in services/auditLog.js, not
 * by controllers — see that file for why the hook is the only place this can
 * live without being forgotten.
 *
 * APPEND-ONLY BY CONVENTION, like Transaction: nothing in the app updates or
 * deletes a row here, and the read endpoint is the only one exposed. There is
 * deliberately no write endpoint — an audit trail an operator can edit is not
 * an audit trail.
 */
const AuditLogSchema = new mongoose.Schema(
  {
    /**
     * The staff member who made the change, denormalised.
     *
     * A COPY, not a reference: an audit row must still read correctly after the
     * employee is renamed, moved to another branch or deleted outright — those
     * are precisely the situations somebody reads an audit log in. `branch` is
     * the actor's session branch at the time (null = super admin / all
     * branches), which is also what makes "who from my branch changed this"
     * answerable.
     */
    actor: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      role: { type: String, default: "" },
      branch: { type: String, default: null },
      isSuperAdmin: { type: Boolean, default: false },
    },

    /** CREATE | UPDATE | DELETE | UPDATE_MANY | DELETE_MANY | CREATE_MANY. */
    action: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * The mongoose model name, e.g. "Member".
     *
     * Named collectionName rather than `collection` because `collection` is a
     * reserved-ish name on a mongoose document (Document.prototype.collection
     * is the driver handle) and shadowing it produces confusing failures.
     */
    collectionName: {
      type: String,
      required: true,
      index: true,
    },

    /** Null for the bulk actions, where no single document is the subject. */
    documentId: {
      type: String,
      default: null,
      index: true,
    },

    /** A human label for the row that changed, so a list reads without joins. */
    documentLabel: {
      type: String,
      default: "",
    },

    /**
     * The change itself, REDACTED AND TRIMMED.
     *
     * For an UPDATE these hold only the fields that actually changed, so a row
     * is small and a reader sees the edit rather than the whole document. For
     * CREATE and DELETE they hold the document (capped — see
     * services/auditLog.js), because "what was deleted" is the whole point.
     *
     * Secrets never reach here: password hashes, tokens and SMTP app passwords
     * are replaced with "[REDACTED]" before the row is built. An audit log is
     * read by more people than the records it describes, so it must not become
     * the softest place to find a credential.
     */
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Top-level field names that differ between before and after. */
    changedFields: {
      type: [String],
      default: [],
    },

    /**
     * The branch this change BELONGS to: the changed document's own branch
     * where it has one, otherwise the actor's branch, otherwise null.
     *
     * This is the field the list endpoint scopes on, so a Gotri admin reads
     * Gotri's history and nothing else. null rows (business-wide masters,
     * changes by a super admin to something with no branch) are visible to a
     * super admin only — least privilege, and consistent with how "Common"
     * is handled for money.
     */
    branch: {
      type: String,
      default: null,
      index: true,
    },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    method: { type: String, default: "" },
    path: { type: String, default: "" },

    /** True when the row was truncated to fit the size cap. */
    truncated: { type: Boolean, default: false },
  },
  { timestamps: true },
);

/** The viewer is always "newest first", optionally narrowed by branch. */
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ branch: 1, createdAt: -1 });

/** "What happened to THIS member/transaction" — the drill-down from a record. */
AuditLogSchema.index({ collectionName: 1, documentId: 1, createdAt: -1 });

/** "What did this employee do" — the drill-down from a person. */
AuditLogSchema.index({ "actor.id": 1, createdAt: -1 });

export default mongoose.model("AuditLog", AuditLogSchema);
