import Transaction from "../../models/Transaction.js";
import { financialScopeFilter, isSuperAdmin } from "../../middlewares/branchScope.js";

/**
 * FINANCIAL reports. Read-only.
 *
 * ============================================================================
 * EVERY FIGURE HERE COMES FROM THE `Transaction` LEDGER. NEVER FROM
 * `Member.payments[]`.
 * ============================================================================
 * `Member.payments` is the CURRENT PERIOD balance and is deliberately CLEARED
 * ON RENEWAL (models/Member.js, models/Transaction.js). A total summed from it
 * is therefore not "slightly stale" — it silently drops every rupee collected
 * before each member's last renewal, and it does so without erroring, without
 * logging, and with a plausible-looking number at the end. `Transaction` is
 * append-only and is the only correct source for any report or chart.
 *
 * ============================================================================
 * "Common" IS NOT A BRANCH AND MUST NEVER LAND IN ONE BRANCH'S P&L.
 * ============================================================================
 * Transaction.branch carries a third value, "Common": shared rent, software,
 * the accountant, the owner's salary. Those belong to the business, not to
 * either floor. Folding them into a single branch's numbers would make that
 * branch look unprofitable for costs it does not carry, so:
 *   - a branch admin's scope is `{ branch: <their own> }`, which excludes
 *     Common by construction — there is no code path that adds it back;
 *   - a super admin sees Common, but as its OWN block plus a clearly-labelled
 *     consolidated total, never merged into Vasna's or Gotri's figures.
 * The split is enforced in splitCommon() below and asserted, not assumed.
 *
 * Scope always comes from `financialScopeFilter(req, requested)`, which reads
 * req.session.user. req.user has no branch and would read as unrestricted.
 */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** The bookkeeping bucket, spelled once. */
const COMMON_BRANCH = "Common";

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

/**
 * GET /api/v1/reports/collections?months=12&branch=
 *
 * Money IN, by month and branch. The renewals/joining/manual split comes from
 * Transaction.source, which is the only place that distinction survives.
 *
 * Index relied on: Transaction { branch: 1, transactionDate: -1, direction: 1 }
 * — a branch admin's query is then a single index range, and a super admin's
 * falls back to { transactionDate: -1, direction: 1 }.
 */
export const getCollectionsReport = async (req, res) => {
  try {
    const requestedMonths = Number(req.query.months);
    const months =
      Number.isFinite(requestedMonths) && requestedMonths > 0
        ? Math.min(Math.trunc(requestedMonths), 36)
        : 12;

    const now = new Date();
    const windowStart = new Date(
      now.getFullYear(),
      now.getMonth() - (months - 1),
      1,
    );

    const scope = {
      ...financialScopeFilter(req, req.query.branch),
      direction: "IN",
      isActive: true,
      transactionDate: { $gte: windowStart },
    };

    const rows = await Transaction.aggregate([
      { $match: scope },
      {
        $group: {
          _id: {
            year: { $year: "$transactionDate" },
            month: { $month: "$transactionDate" },
            branch: "$branch",
          },
          total: { $sum: "$amount" },
          receipts: { $sum: 1 },
          renewals: {
            $sum: { $cond: [{ $eq: ["$source", "MEMBER_RENEWAL"] }, 1, 0] },
          },
          joinings: {
            $sum: { $cond: [{ $eq: ["$source", "MEMBER_JOINING"] }, 1, 0] },
          },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.branch": 1 } },
    ]);

    const branches = [...new Set(rows.map((r) => r._id.branch))].sort();

    // A dense series, so a month with no collections is a zero on the chart
    // rather than a missing point that the line quietly skips over.
    const series = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const monthRows = rows.filter(
        (r) => r._id.year === year && r._id.month === month,
      );

      const byBranch = {};
      for (const b of branches) {
        const hit = monthRows.find((r) => r._id.branch === b);
        byBranch[b] = hit?.total || 0;
      }

      series.push({
        key: `${year}-${String(month).padStart(2, "0")}`,
        label: `${MONTH_NAMES[month - 1]} ${String(year).slice(2)}`,
        total: monthRows.reduce((s, r) => s + r.total, 0),
        receipts: monthRows.reduce((s, r) => s + r.receipts, 0),
        renewals: monthRows.reduce((s, r) => s + r.renewals, 0),
        joinings: monthRows.reduce((s, r) => s + r.joinings, 0),
        byBranch,
      });
    }

    const byBranchTotals = branches.map((b) => ({
      branch: b,
      total: rows
        .filter((r) => r._id.branch === b)
        .reduce((s, r) => s + r.total, 0),
      receipts: rows
        .filter((r) => r._id.branch === b)
        .reduce((s, r) => s + r.receipts, 0),
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Collections report fetched successfully",
      data: {
        months,
        from: windowStart,
        branches,
        series,
        byBranch: byBranchTotals,
        total: series.reduce((s, m) => s + m.total, 0),
        source: "Transaction ledger (direction: IN)",
      },
    });
  } catch (error) {
    console.error("Error building collections report:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * Separates the shared-cost bucket from the branch rows.
 *
 * Returns `common: null` for anyone who is not a super admin. That is belt and
 * braces — `financialScopeFilter` already pins a branch admin to their own
 * branch, so no Common row can reach this function for them — but the cost of
 * being wrong here is a branch manager reading the owner's salary, so it is
 * checked rather than reasoned about. The unit test in
 * scripts/tests/scoping.test.mjs asserts both halves.
 */
const splitCommon = (rows, req) => {
  const superAdmin = isSuperAdmin(req);
  const branchRows = rows.filter((r) => r.branch !== COMMON_BRANCH);
  const commonRows = rows.filter((r) => r.branch === COMMON_BRANCH);

  if (!superAdmin && commonRows.length > 0) {
    // Should be unreachable. If it ever fires, the scope helper was bypassed.
    console.error(
      "⚠️ 'Common' rows reached a non-super-admin P&L and were dropped. " +
        "Check that financialScopeFilter is applied to every money query.",
    );
  }

  return { branchRows, commonRows: superAdmin ? commonRows : [] };
};

/**
 * GET /api/v1/reports/profit-loss?fromDate&toDate&branch
 *
 * Income, expenses and net — per branch, with the shared-cost bucket kept
 * separate. The response shape is deliberately three-part:
 *
 *   branches[]   one row per physical branch. NEVER includes Common.
 *   common       the shared-cost block, or null for a branch admin.
 *   consolidated branches + common, and therefore super-admin only. This is
 *                the only figure that represents the business as a whole; a
 *                branch's `net` is its own trading result and is not supposed
 *                to add up to it.
 */
export const getProfitAndLoss = async (req, res) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const from = startOfDay(req.query.fromDate || defaultFrom);
    const to = endOfDay(req.query.toDate || now);
    if (!from || !to) return fail(res, 400, "fromDate or toDate is not a date");
    if (from > to) return fail(res, 400, "fromDate must be before toDate");

    const scope = {
      ...financialScopeFilter(req, req.query.branch),
      isActive: true,
      transactionDate: { $gte: from, $lte: to },
    };

    const grouped = await Transaction.aggregate([
      { $match: scope },
      {
        $group: {
          _id: { branch: "$branch", direction: "$direction" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    const expenseByCategory = await Transaction.aggregate([
      { $match: { ...scope, direction: "OUT" } },
      {
        $group: {
          _id: { branch: "$branch", category: "$category" },
          total: { $sum: "$amount" },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const branchNames = [...new Set(grouped.map((g) => g._id.branch))];
    const rows = branchNames.map((branch) => {
      const income =
        grouped.find(
          (g) => g._id.branch === branch && g._id.direction === "IN",
        )?.total || 0;
      const expense =
        grouped.find(
          (g) => g._id.branch === branch && g._id.direction === "OUT",
        )?.total || 0;

      return {
        branch,
        income,
        expense,
        net: income - expense,
        expenseByCategory: expenseByCategory
          .filter((c) => c._id.branch === branch)
          .map((c) => ({ category: c._id.category || "Uncategorised", total: c.total }))
          .slice(0, 20),
      };
    });

    const { branchRows, commonRows } = splitCommon(rows, req);
    const common = commonRows[0] || null;

    const branchIncome = branchRows.reduce((s, r) => s + r.income, 0);
    const branchExpense = branchRows.reduce((s, r) => s + r.expense, 0);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Profit and loss fetched successfully",
      data: {
        from,
        to,
        branches: branchRows.sort((a, b) => a.branch.localeCompare(b.branch)),
        /**
         * Present and non-null ONLY for a super admin. A branch admin gets
         * null, not an empty object, so a UI cannot render an all-zero "Common"
         * card and imply those costs are nil.
         */
        common: common
          ? {
              branch: COMMON_BRANCH,
              income: common.income,
              expense: common.expense,
              net: common.net,
              expenseByCategory: common.expenseByCategory,
              note:
                "Business-level shared costs. Excluded from every branch's P&L " +
                "on purpose — see models/Transaction.js.",
            }
          : null,
        /**
         * Only meaningful when the whole business is in view. Omitted for a
         * branch admin, because "branch income minus branch expenses" is not
         * the business's profit and must not be labelled as if it were.
         */
        consolidated: isSuperAdmin(req)
          ? {
              income: branchIncome + (common?.income || 0),
              expense: branchExpense + (common?.expense || 0),
              net:
                branchIncome +
                (common?.income || 0) -
                (branchExpense + (common?.expense || 0)),
            }
          : null,
        source: "Transaction ledger (direction: IN / OUT)",
      },
    });
  } catch (error) {
    console.error("Error building profit and loss report:", error);
    return fail(res, 500, "Internal server error");
  }
};
