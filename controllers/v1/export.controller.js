import Transaction from "../../models/Transaction.js";
import Member from "../../models/Member.js";
import Attendance from "../../models/Attendance.js";
import {
  scopeFilter,
  resolveBranchFilter,
  financialScopeFilter,
} from "../../middlewares/branchScope.js";
import { streamCsv } from "../../utils/csv.js";

/**
 * Server-side CSV exports.
 *
 * ============================================================================
 * THE RISK THIS FILE IS BUILT AROUND: AN EXPORT THAT LEAKS ANOTHER BRANCH.
 * ============================================================================
 * A report screen that leaks is bad; a CSV that leaks is worse, because it
 * leaves the building. The scope for every dataset here therefore comes from
 * the session — `financialScopeFilter` for money, `scopeFilter` for everything
 * else — and is spread LAST into the filter so it beats any branch the client
 * put in the query string. A branch admin's `?branch=Gotri` narrows nothing and
 * widens nothing; it is ignored.
 *
 * `"Common"` follows from the same rule: `financialScopeFilter` pins a branch
 * admin to `{ branch: <their own> }`, and there is no code path in this file
 * that adds a second branch to a filter. Only a super admin, whose filter is
 * unrestricted, can export the shared-cost rows.
 *
 * ============================================================================
 * WHY THE ROWS ARE STREAMED AND CAPPED
 * ============================================================================
 * The API runs as a serverless function with 1024 MB and a 30 s ceiling
 * (vercel.json). Materialising an unbounded `find().lean()` into an array is
 * how that function gets OOM-killed with no error body. Every export below
 * reads through a cursor and writes as it goes (utils/csv.js), and stops at
 * MAX_CSV_ROWS with a truncation line inside the file itself.
 *
 * `?format=json` returns a plain array instead, capped much lower. That exists
 * for Gym-Admin's ExportCSVModal, which takes an in-memory `data` prop — the
 * JSON path must stay small precisely because it is the one that is NOT
 * streamed.
 */

/** Streamed. High enough for a full year of a two-branch gym's ledger. */
const MAX_CSV_ROWS = 50000;

/** Not streamed — held in memory, so kept deliberately modest. */
const MAX_JSON_ROWS = 5000;

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

const stamp = () => new Date().toISOString().slice(0, 10);

const minutesBetween = (a, b) =>
  a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : "";

/**
 * Runs one export in either shape.
 *
 * Errors are handled in two different ways on purpose: before the first byte
 * is written a JSON error envelope is still possible, but once streaming has
 * started the status line is long gone, so all that can be done is abort the
 * connection and log it. A half-file with a 200 would be read as complete.
 */
const respond = async (req, res, { filename, columns, query, label }) => {
  const wantsJson = String(req.query.format || "").toLowerCase() === "json";

  if (wantsJson) {
    const rows = await query.clone().limit(MAX_JSON_ROWS).lean();
    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `${label} export fetched successfully`,
      data: rows.map((doc) =>
        Object.fromEntries(
          columns.map((c) => [c.label, c.get ? c.get(doc) : doc?.[c.key]]),
        ),
      ),
      meta: {
        rowCount: rows.length,
        truncated: rows.length >= MAX_JSON_ROWS,
        maxRows: MAX_JSON_ROWS,
      },
    });
  }

  try {
    const written = await streamCsv(res, {
      filename,
      columns,
      cursor: query.lean().cursor(),
      maxRows: MAX_CSV_ROWS,
    });
    console.log(`✅ CSV export: ${label}, ${written} rows`);
    return undefined;
  } catch (error) {
    console.error(`❌ CSV export failed (${label}):`, error);
    if (res.headersSent) {
      // Destroy rather than end(): a truncated file that arrives cleanly looks
      // like a complete one, and somebody will reconcile against it.
      res.destroy(error);
      return undefined;
    }
    return fail(res, 500, "Export failed");
  }
};

/**
 * GET /api/v1/exports/transactions?fromDate&toDate&direction&branch&format=json
 *
 * The cash ledger. Scoped by financialScopeFilter, so "Common" is super-admin
 * only. Index relied on:
 * Transaction { branch: 1, transactionDate: -1, direction: 1 }.
 */
export const exportTransactions = async (req, res) => {
  try {
    const { direction } = req.query;

    const filter = { isActive: true };
    if (direction === "IN" || direction === "OUT") filter.direction = direction;

    if (req.query.fromDate || req.query.toDate) {
      const from = req.query.fromDate ? startOfDay(req.query.fromDate) : null;
      const to = req.query.toDate ? endOfDay(req.query.toDate) : null;
      if ((req.query.fromDate && !from) || (req.query.toDate && !to)) {
        return fail(res, 400, "fromDate or toDate is not a date");
      }
      filter.transactionDate = {};
      if (from) filter.transactionDate.$gte = from;
      if (to) filter.transactionDate.$lte = to;
    }

    // LAST. The session decides the branch, not the query string.
    Object.assign(filter, financialScopeFilter(req, req.query.branch));

    return await respond(req, res, {
      label: "transactions",
      filename: `transactions-${stamp()}.csv`,
      query: Transaction.find(filter).sort({ transactionDate: -1 }),
      columns: [
        { key: "transactionDate", label: "Date" },
        { key: "direction", label: "Direction" },
        { key: "amount", label: "Amount" },
        { key: "mode", label: "Mode" },
        { key: "branch", label: "Branch" },
        { key: "receiptNo", label: "Receipt No" },
        { key: "memberName", label: "Member" },
        { key: "memberMobile", label: "Mobile" },
        { key: "planCode", label: "Plan" },
        { key: "category", label: "Category" },
        { key: "paidTo", label: "Paid To" },
        { key: "billNo", label: "Bill No" },
        { key: "source", label: "Source" },
        { key: "note", label: "Note" },
      ],
    });
  } catch (error) {
    console.error("Error exporting transactions:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/exports/members?branch&isActive&format=json
 *
 * DELIBERATELY OMITS: passwordHash (select:false and redacted everywhere else),
 * loginId, payments[] and idProof. An export is the widest-travelling copy of
 * this data, and a member's portal credentials and ID document have no business
 * in a spreadsheet. Money is not in here either — the ledger export above is
 * the source for that, and a per-member "paid" column summed from
 * Member.payments[] would be wrong for everyone who has ever renewed.
 */
export const exportMembers = async (req, res) => {
  try {
    const filter = {};
    if (req.query.isActive !== undefined && req.query.isActive !== "") {
      filter.isActive =
        req.query.isActive === true || req.query.isActive === "true";
    }

    const requested = resolveBranchFilter(req, req.query.branch);
    if (requested) filter.branch = requested;
    // LAST.
    Object.assign(filter, scopeFilter(req));

    return await respond(req, res, {
      label: "members",
      filename: `members-${stamp()}.csv`,
      query: Member.find(filter)
        .select(
          "fullName mobileNumber email gender branch planCode startDate endDate totalFee isActive createdAt",
        )
        .sort({ fullName: 1 }),
      columns: [
        { key: "fullName", label: "Name" },
        { key: "mobileNumber", label: "Mobile" },
        { key: "email", label: "Email" },
        { key: "gender", label: "Gender" },
        { key: "branch", label: "Branch" },
        { key: "planCode", label: "Plan" },
        { key: "startDate", label: "Start Date" },
        { key: "endDate", label: "End Date" },
        { key: "totalFee", label: "Fee For Period" },
        {
          key: "isActive",
          label: "Active",
          get: (d) => (d.isActive ? "Yes" : "No"),
        },
        { key: "createdAt", label: "Joined" },
      ],
    });
  } catch (error) {
    console.error("Error exporting members:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/exports/attendance?fromDate&toDate&branch&format=json
 *
 * Logged sessions. The header wording matches the rest of the attendance
 * feature: these are CHECK-INS members recorded, not verified visits.
 *
 * Index relied on: Attendance { branch: 1, date: 1 }.
 */
export const exportAttendance = async (req, res) => {
  try {
    const to = endOfDay(req.query.toDate || new Date());
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 29);
    const from = startOfDay(req.query.fromDate || defaultFrom);
    if (!from || !to) return fail(res, 400, "fromDate or toDate is not a date");
    if (from > to) return fail(res, 400, "fromDate must be before toDate");

    const filter = { date: { $gte: from, $lte: to } };
    const requested = resolveBranchFilter(req, req.query.branch);
    if (requested) filter.branch = requested;
    // LAST.
    Object.assign(filter, scopeFilter(req));

    return await respond(req, res, {
      label: "attendance",
      filename: `attendance-checkins-${stamp()}.csv`,
      query: Attendance.find(filter)
        .select("memberId branch date checkInAt checkOutAt autoClosed")
        .populate("memberId", "fullName mobileNumber")
        .sort({ date: -1, checkInAt: -1 }),
      columns: [
        { key: "date", label: "Date" },
        { key: "branch", label: "Branch" },
        {
          key: "member",
          label: "Member",
          get: (d) => d.memberId?.fullName || "",
        },
        {
          key: "mobile",
          label: "Mobile",
          get: (d) => d.memberId?.mobileNumber || "",
        },
        { key: "checkInAt", label: "Checked In At" },
        { key: "checkOutAt", label: "Checked Out At" },
        {
          key: "minutes",
          label: "Minutes",
          get: (d) => minutesBetween(d.checkInAt, d.checkOutAt),
        },
        {
          key: "autoClosed",
          label: "Auto Closed",
          get: (d) => (d.autoClosed ? "Yes" : "No"),
        },
      ],
    });
  } catch (error) {
    console.error("Error exporting attendance:", error);
    return fail(res, 500, "Internal server error");
  }
};
