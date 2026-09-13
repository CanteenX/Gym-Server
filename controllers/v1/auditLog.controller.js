import AuditLog from "../../models/AuditLog.js";
import { scopeFilter, isSuperAdmin } from "../../middlewares/branchScope.js";

/**
 * READ-ONLY viewer for the audit trail.
 *
 * There is no create, update or delete endpoint here, and that is the point: a
 * trail an operator can edit is not a trail. Rows are written only by the
 * mongoose plugin in services/auditLog.js.
 *
 * BRANCH SCOPING, AND THE ONE CONSEQUENCE WORTH KNOWING
 * `AuditLog.branch` is the branch the CHANGED DOCUMENT belongs to, falling back
 * to the actor's branch. `scopeFilter(req)` is spread LAST, so a Gotri admin
 * reads Gotri's history and nothing else.
 *
 * Rows with `branch: null` — changes to business-wide masters (menus, plans,
 * branches, website copy) and anything a super admin did to a record with no
 * branch of its own — are therefore visible to a SUPER ADMIN ONLY. That is
 * deliberate: those changes affect both branches and are the owner's business.
 * The alternative, showing null rows to everyone, would put "who changed the
 * membership pricing" in front of every branch manager.
 */

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const startOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/** Allowlist — `sorton` reaches a Mongo sort key directly. */
const SORTABLE = new Set([
  "createdAt",
  "action",
  "collectionName",
  "branch",
  "actor.name",
]);

/**
 * POST /api/v1/audit-logs-by-params
 *
 * House `…-by-params` list convention: { skip, per_page, sorton, sortdir,
 * match } plus the filters below.
 */
export const listAuditLogsByParams = async (req, res) => {
  try {
    const {
      skip,
      per_page,
      sorton,
      sortdir,
      match,
      action,
      collectionName,
      documentId,
      actorId,
      fromDate,
      toDate,
      branch,
    } = req.body || {};

    const safeSkip = Math.max(0, Number(skip) || 0);
    // Capped: audit rows carry before/after payloads, so a per_page of 5000
    // is a multi-megabyte response, not just a slow one.
    const safePerPage = Math.min(Math.max(1, Number(per_page) || 50), 200);

    const filter = {};

    if (typeof action === "string" && action.trim()) {
      filter.action = action.trim().toUpperCase();
    }
    if (typeof collectionName === "string" && collectionName.trim()) {
      filter.collectionName = collectionName.trim();
    }
    if (typeof documentId === "string" && documentId.trim()) {
      filter.documentId = documentId.trim();
    }
    if (typeof actorId === "string" && actorId.trim()) {
      filter["actor.id"] = actorId.trim();
    }

    if (fromDate || toDate) {
      const from = fromDate ? startOfDay(fromDate) : null;
      const to = toDate ? endOfDay(toDate) : null;
      if ((fromDate && !from) || (toDate && !to)) {
        return fail(res, 400, "fromDate or toDate is not a date");
      }
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }

    // A super admin may narrow to one branch. A branch admin's request for a
    // branch is overwritten by scopeFilter below and can never widen anything.
    if (isSuperAdmin(req) && typeof branch === "string" && branch.trim()) {
      filter.branch = branch.trim();
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      filter.$or = [
        { "actor.name": { $regex: escaped, $options: "i" } },
        { "actor.email": { $regex: escaped, $options: "i" } },
        { collectionName: { $regex: escaped, $options: "i" } },
        { documentLabel: { $regex: escaped, $options: "i" } },
        { path: { $regex: escaped, $options: "i" } },
      ];
    }

    // LAST. Authoritative over everything a client sent.
    Object.assign(filter, scopeFilter(req));

    const sortKey = SORTABLE.has(sorton) ? sorton : "createdAt";
    const sortDirection = sortdir === "asc" || sortdir === 1 ? 1 : -1;

    const [data, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ [sortKey]: sortDirection })
        .skip(safeSkip)
        .limit(safePerPage)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Audit log fetched successfully",
      data,
      // Matches what the other list screens read, so the shared table paginates
      // without a special case.
      total,
      count: total,
    });
  } catch (error) {
    console.error("Error fetching audit log:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/audit-logs/:id
 *
 * The drill-down: one row with its full before/after. Scoped the same way as
 * the list, so guessing an id from another branch returns 404 rather than the
 * row — an id is not an authorisation.
 */
export const getAuditLogById = async (req, res) => {
  try {
    const filter = { _id: req.params.id, ...scopeFilter(req) };
    const row = await AuditLog.findOne(filter).lean();

    if (!row) return fail(res, 404, "Audit log entry not found");

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Audit log entry fetched successfully",
      data: row,
    });
  } catch (error) {
    console.error("Error fetching audit log entry:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/audit-logs-filters
 *
 * The distinct values the viewer's dropdowns need, scoped the same way, so a
 * branch admin's filter list cannot advertise collections they cannot read.
 */
export const getAuditLogFilters = async (req, res) => {
  try {
    const scope = scopeFilter(req);
    const [collections, actions, actors] = await Promise.all([
      AuditLog.distinct("collectionName", scope),
      AuditLog.distinct("action", scope),
      AuditLog.aggregate([
        { $match: scope },
        {
          $group: {
            _id: "$actor.id",
            name: { $first: "$actor.name" },
            email: { $first: "$actor.email" },
            changes: { $sum: 1 },
          },
        },
        { $sort: { changes: -1 } },
        { $limit: 100 },
      ]),
    ]);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Audit log filters fetched successfully",
      data: {
        collections: collections.sort(),
        actions: actions.sort(),
        actors: actors.map((a) => ({
          id: a._id,
          name: a.name,
          email: a.email,
          changes: a.changes,
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching audit log filters:", error);
    return fail(res, 500, "Internal server error");
  }
};
