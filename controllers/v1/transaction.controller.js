import Transaction from "../../models/Transaction.js";
import Member from "../../models/Member.js";
import { nextReceiptNumber } from "../../utils/receiptNumber.js";
import { financialScopeFilter } from "../../middlewares/branchScope.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Builds the Mongo filter shared by the list and summary endpoints, so the
 * table and the charts can never disagree about what is in scope.
 */
const buildFilter = (body = {}, req = null) => {
  const { direction, branch, category, mode, fromDate, toDate, match } = body;
  const filter = { isActive: true };

  if (direction === "IN" || direction === "OUT") filter.direction = direction;
  // Branch comes from the session when the caller is a branch admin, and only
  // then falls back to what the request asked for. Assigning after the spread
  // is deliberate: the scope must win over the body, never the other way round.
  if (req) {
    Object.assign(filter, financialScopeFilter(req, branch));
  } else if (branch) {
    filter.branch = branch;
  }
  if (category) filter.category = category;
  if (mode) filter.mode = mode;

  if (fromDate || toDate) {
    filter.transactionDate = {};
    if (fromDate) filter.transactionDate.$gte = startOfDay(fromDate);
    if (toDate) filter.transactionDate.$lte = endOfDay(toDate);
  }

  const safeMatch = typeof match === "string" ? match.trim() : "";
  if (safeMatch) {
    const escaped = escapeRegex(safeMatch);
    filter.$or = [
      { memberName: { $regex: escaped, $options: "i" } },
      { memberMobile: { $regex: escaped, $options: "i" } },
      { receiptNo: { $regex: escaped, $options: "i" } },
      { paidTo: { $regex: escaped, $options: "i" } },
      { billNo: { $regex: escaped, $options: "i" } },
      { note: { $regex: escaped, $options: "i" } },
    ];
  }

  return filter;
};

/**
 * Record money coming in.
 *
 * When a memberId is supplied the payment is ALSO pushed onto that member's
 * current-period `payments` array, so the member's outstanding balance stays
 * correct. The ledger row is the permanent record; the member subdocument is
 * the working balance.
 */
export const recordIncome = async (req, res) => {
  try {
    const {
      amount,
      transactionDate,
      mode,
      branch,
      memberId,
      note,
      applyToMemberBalance = true,
    } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "An amount greater than zero is required",
      });
    }

    const when = transactionDate ? new Date(transactionDate) : new Date();
    let member = null;

    if (memberId) {
      member = await Member.findById(memberId);
      if (!member) {
        return res
          .status(404)
          .json({ isOk: false, status: 404, message: "Member not found" });
      }
    }

    const receiptNo = await nextReceiptNumber(when);

    const txn = new Transaction({
      direction: "IN",
      amount: Number(amount),
      transactionDate: when,
      mode: mode || "Cash",
      branch: branch || member?.branch || "Vasna",
      receiptNo,
      memberId: member?._id || null,
      memberName: member?.fullName || req.body.memberName || "",
      memberMobile: member?.mobileNumber || req.body.memberMobile || "",
      planCode: member?.planCode || "",
      periodStart: member?.startDate || null,
      periodEnd: member?.endDate || null,
      note: note?.trim() || "",
      source: memberId ? "MEMBER_PAYMENT" : "MANUAL",
    });

    await txn.save();

    // Keep the member's working balance in step with the ledger.
    if (member && applyToMemberBalance) {
      member.payments.push({
        amount: Number(amount),
        paidOn: when,
        mode: mode || "Cash",
        receiptNo,
        note: note?.trim() || "",
      });
      await member.save();
    }

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: `Payment recorded — receipt ${receiptNo}`,
      data: txn,
    });
  } catch (error) {
    console.error("Error recording income:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Record money going out. No receipt number — expenses aren't issued receipts. */
export const recordExpense = async (req, res) => {
  try {
    const {
      amount,
      transactionDate,
      mode,
      branch,
      category,
      paidTo,
      billNo,
      note,
    } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "An amount greater than zero is required",
      });
    }
    if (!category?.trim()) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "An expense category is required",
      });
    }

    // receiptNo is deliberately omitted — expenses are not issued receipts, and
    // writing "" here would collide with every other expense under the unique
    // receipt index.
    const txn = new Transaction({
      direction: "OUT",
      amount: Number(amount),
      transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
      mode: mode || "Cash",
      branch: branch || "Vasna",
      category: category.trim(),
      paidTo: paidTo?.trim() || "",
      billNo: billNo?.trim() || "",
      note: note?.trim() || "",
      source: "MANUAL",
    });

    await txn.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Expense recorded successfully",
      data: txn,
    });
  } catch (error) {
    console.error("Error recording expense:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const txn = await Transaction.findById(id);
    if (!txn) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Entry not found" });
    }

    // The receipt number and direction are deliberately immutable: a financial
    // record that can be renumbered after the fact is not a record.
    [
      "mode",
      "branch",
      "category",
      "paidTo",
      "billNo",
      "note",
      "memberName",
      "memberMobile",
    ].forEach((f) => {
      if (req.body[f] !== undefined) txn[f] = req.body[f];
    });

    if (req.body.amount !== undefined && Number(req.body.amount) > 0) {
      txn.amount = Number(req.body.amount);
    }
    if (req.body.transactionDate !== undefined) {
      txn.transactionDate = new Date(req.body.transactionDate);
    }

    await txn.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Entry updated successfully",
      data: txn,
    });
  } catch (error) {
    console.error("Error updating transaction:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Soft-delete: the row is flagged inactive rather than removed, so receipt
 * numbers are never reused and the audit trail stays intact.
 */
export const deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const txn = await Transaction.findById(id);
    if (!txn) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Entry not found" });
    }

    txn.isActive = false;
    await txn.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Entry cancelled",
    });
  } catch (error) {
    console.error("Error deleting transaction:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listTransactionsByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir } = req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const filter = buildFilter(req.body, req);

    const allowed = ["transactionDate", "amount", "receiptNo", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "transactionDate";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await Transaction.countDocuments(filter);
    const data = await Transaction.find(filter)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    // Totals for the CURRENT FILTER, not just the visible page — staff need the
    // period total, not the total of ten rows.
    const totals = await Transaction.aggregate([
      { $match: filter },
      { $group: { _id: "$direction", total: { $sum: "$amount" } } },
    ]);
    const totalIn = totals.find((t) => t._id === "IN")?.total || 0;
    const totalOut = totals.find((t) => t._id === "OUT")?.total || 0;

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [
        { count: totalCount, data, totalIn, totalOut, net: totalIn - totalOut },
      ],
    });
  } catch (error) {
    console.error("Error listing transactions:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Chart + headline data: monthwise in/out, expense split by category, and
 * this-month/today figures for the summary tiles.
 */
export const getCashFlowSummary = async (req, res) => {
  try {
    const months = Number(req.query.months) > 0 ? Number(req.query.months) : 6;

    const now = new Date();
    const windowStart = new Date(
      now.getFullYear(),
      now.getMonth() - (months - 1),
      1,
    );

    // One scope object drives all four aggregations below, so the chart, the
    // category split and the summary tiles can never disagree about what a
    // given user is allowed to see.
    //
    // For a branch admin this resolves to their own branch, which also EXCLUDES
    // the "Common" bucket — shared rent, software and the owner's salary are
    // business-level costs, and folding them into one branch's P&L would make
    // that branch look unprofitable for money it does not carry. A super admin
    // gets no branch restriction at all and therefore sees Common too.
    const branchScope = financialScopeFilter(req, req.query.branch);

    const scope = {
      ...branchScope,
      isActive: true,
      transactionDate: { $gte: windowStart },
    };

    const monthly = await Transaction.aggregate([
      { $match: scope },
      {
        $group: {
          _id: {
            year: { $year: "$transactionDate" },
            month: { $month: "$transactionDate" },
            direction: "$direction",
          },
          total: { $sum: "$amount" },
        },
      },
    ]);

    // Build a dense series so months with no activity still appear on the chart.
    const MONTH_NAMES = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const series = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const incoming =
        monthly.find(
          (m) =>
            m._id.year === year &&
            m._id.month === month &&
            m._id.direction === "IN",
        )?.total || 0;
      const outgoing =
        monthly.find(
          (m) =>
            m._id.year === year &&
            m._id.month === month &&
            m._id.direction === "OUT",
        )?.total || 0;

      series.push({
        key: `${year}-${String(month).padStart(2, "0")}`,
        label: `${MONTH_NAMES[month - 1]} ${String(year).slice(2)}`,
        incoming,
        outgoing,
        net: incoming - outgoing,
      });
    }

    const byCategory = await Transaction.aggregate([
      { $match: { ...scope, direction: "OUT" } },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
      { $sort: { total: -1 } },
      { $limit: 12 },
    ]);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart = startOfDay(now);
    const tileScope = branchScope;

    const [thisMonth, today, allTime] = await Promise.all([
      Transaction.aggregate([
        {
          $match: {
            ...tileScope,
            isActive: true,
            transactionDate: { $gte: monthStart },
          },
        },
        { $group: { _id: "$direction", total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            ...tileScope,
            isActive: true,
            transactionDate: { $gte: todayStart, $lte: endOfDay(now) },
          },
        },
        { $group: { _id: "$direction", total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        { $match: { ...tileScope, isActive: true } },
        { $group: { _id: "$direction", total: { $sum: "$amount" } } },
      ]),
    ]);

    const pick = (rows, dir) => rows.find((r) => r._id === dir)?.total || 0;

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        series,
        byCategory: byCategory.map((c) => ({
          category: c._id || "Uncategorised",
          total: c.total,
        })),
        tiles: {
          todayIn: pick(today, "IN"),
          todayOut: pick(today, "OUT"),
          monthIn: pick(thisMonth, "IN"),
          monthOut: pick(thisMonth, "OUT"),
          monthNet: pick(thisMonth, "IN") - pick(thisMonth, "OUT"),
          allTimeIn: pick(allTime, "IN"),
          allTimeOut: pick(allTime, "OUT"),
        },
      },
    });
  } catch (error) {
    console.error("Error building cash flow summary:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Everything a printable receipt needs, in one call. */
export const getReceipt = async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Entry not found" });
    }
    if (txn.direction !== "IN") {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Receipts are only issued for incoming payments",
      });
    }

    return res.status(200).json({ isOk: true, status: 200, data: txn });
  } catch (error) {
    console.error("Error fetching receipt:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
