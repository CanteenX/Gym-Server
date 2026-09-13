import Member from "../../models/Member.js";
import {
  scopeFilter,
  resolveBranchFilter,
} from "../../middlewares/branchScope.js";

/**
 * MEMBER-BASE reports: the expiry pipeline and member ageing. Read-only.
 *
 * Split from report.controller.js because the scoping rule is different, and
 * that difference is load-bearing. Money uses `financialScopeFilter`, which has
 * to reason about the "Common" bucket. Members never belong to Common — nobody
 * trains at a bookkeeping bucket (models/Branch.js, isPhysical: false) — so
 * these use plain `scopeFilter`/`resolveBranchFilter`, spread LAST so a branch
 * admin's own branch overrides anything the client asked for.
 *
 * Both read `req.session.user` by way of those helpers. `req.user` carries no
 * branch and would read as "unrestricted" for every branch admin.
 *
 * ============================================================================
 * WHY "MEMBER AGEING" HERE MEANS TENURE AND DUES, AND HOW THE DUES ARE DERIVED
 * ============================================================================
 * Two different things get called ageing. This endpoint returns both, because
 * the interesting question ("who is about to churn, and who owes us money")
 * needs them together:
 *
 *   tenure[]      how long each active member has been with the gym, bucketed.
 *   receivables[] outstanding balance for the CURRENT membership period,
 *                 bucketed by how old that period is.
 *
 * The outstanding balance is NOT summed from `Member.payments[]`. That array is
 * cleared on renewal, so summing it looks right and is wrong the moment anybody
 * renews. It is computed instead as
 *
 *     totalFee  −  Σ Transaction(direction: IN) since the member's startDate
 *
 * `totalFee` is a PRICE and lives on the member; every rupee actually received
 * comes from the append-only ledger. The $lookup below is what makes that a
 * single round trip, and it needs the Transaction index
 * { memberId: 1, direction: 1, transactionDate: -1 }.
 */

/** Bucket edges in days. Kept here so the labels and the maths cannot drift. */
const EXPIRY_BUCKETS = [
  { key: "expired", label: "Already expired", from: -Infinity, to: -1 },
  { key: "d0_7", label: "Expires in 0–7 days", from: 0, to: 7 },
  { key: "d8_15", label: "Expires in 8–15 days", from: 8, to: 15 },
  { key: "d16_30", label: "Expires in 16–30 days", from: 16, to: 30 },
  { key: "d31_60", label: "Expires in 31–60 days", from: 31, to: 60 },
  { key: "d60_plus", label: "Expires in 60+ days", from: 61, to: Infinity },
];

const TENURE_BUCKETS = [
  { key: "m0_1", label: "Under 1 month", from: 0, to: 30 },
  { key: "m1_3", label: "1–3 months", from: 31, to: 90 },
  { key: "m3_6", label: "3–6 months", from: 91, to: 180 },
  { key: "m6_12", label: "6–12 months", from: 181, to: 365 },
  { key: "y1_plus", label: "Over a year", from: 366, to: Infinity },
];

const DUES_BUCKETS = [
  { key: "d0_30", label: "0–30 days", from: 0, to: 30 },
  { key: "d31_60", label: "31–60 days", from: 31, to: 60 },
  { key: "d61_90", label: "61–90 days", from: 61, to: 90 },
  { key: "d90_plus", label: "Over 90 days", from: 91, to: Infinity },
];

/** Members read into memory for the ageing maths. Two branches, hundreds of rows. */
const AGEING_CAP = 5000;

const DAY_MS = 86400000;

const bucketFor = (buckets, days) =>
  buckets.find((b) => days >= b.from && days <= b.to) || buckets[buckets.length - 1];

const emptyBuckets = (buckets) =>
  buckets.map((b) => ({ key: b.key, label: b.label, count: 0, amount: 0 }));

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/** The branch match every query in this file starts from. */
const memberScope = (req) => {
  const requested = resolveBranchFilter(req, req.query.branch);
  return {
    isActive: true,
    ...(requested ? { branch: requested } : {}),
    // LAST, and therefore authoritative over the line above it.
    ...scopeFilter(req),
  };
};

/**
 * GET /api/v1/reports/expiry-pipeline?branch&perBucket=10
 *
 * Active memberships grouped by how near their end date is, per branch, plus a
 * short sample list per bucket so the screen can show who to call without a
 * second round trip.
 *
 * Index relied on: Member { branch: 1, endDate: 1 } (added for this report).
 * Without it a branch admin's query falls back to { endDate: 1, isActive: 1 }
 * and filters branch in memory, which is still correct, just slower.
 */
export const getExpiryPipeline = async (req, res) => {
  try {
    const perBucket = Math.min(
      Math.max(1, Number(req.query.perBucket) || 10),
      50,
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const scope = memberScope(req);

    const members = await Member.find(scope)
      .select("fullName mobileNumber branch planCode startDate endDate")
      .sort({ endDate: 1 })
      .limit(AGEING_CAP)
      .lean();

    const buckets = EXPIRY_BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      count: 0,
      members: [],
    }));
    const byBranch = {};

    for (const m of members) {
      if (!m.endDate) continue;
      const days = Math.floor(
        (new Date(m.endDate).setHours(0, 0, 0, 0) - today.getTime()) / DAY_MS,
      );
      const def = bucketFor(EXPIRY_BUCKETS, days);
      const bucket = buckets.find((b) => b.key === def.key);
      bucket.count += 1;
      if (bucket.members.length < perBucket) {
        bucket.members.push({
          _id: m._id,
          fullName: m.fullName,
          mobileNumber: m.mobileNumber,
          branch: m.branch,
          planCode: m.planCode,
          endDate: m.endDate,
          daysToExpiry: days,
        });
      }

      byBranch[m.branch] ??= Object.fromEntries(
        EXPIRY_BUCKETS.map((b) => [b.key, 0]),
      );
      byBranch[m.branch][def.key] += 1;
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Expiry pipeline fetched successfully",
      data: {
        asOf: today,
        total: members.length,
        truncated: members.length >= AGEING_CAP,
        buckets,
        byBranch: Object.entries(byBranch).map(([branch, counts]) => ({
          branch,
          ...counts,
        })),
      },
    });
  } catch (error) {
    console.error("Error building expiry pipeline:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * GET /api/v1/reports/member-ageing?branch
 *
 * Tenure cohorts plus outstanding-dues ageing. See the file header for why the
 * dues figure is derived from the Transaction ledger and not from
 * Member.payments[].
 */
export const getMemberAgeing = async (req, res) => {
  try {
    const scope = memberScope(req);
    const now = Date.now();

    const rows = await Member.aggregate([
      { $match: scope },
      { $limit: AGEING_CAP },
      {
        /**
         * Every rupee ACTUALLY RECEIVED for the current period, straight from
         * the ledger — not from Member.payments, which is wiped on renewal.
         *
         * The correlated pipeline matches on memberId + direction and a
         * transactionDate at or after this member's own startDate, which is
         * what makes it "this period" rather than "ever". isActive guards the
         * soft-deleted ledger rows.
         */
        $lookup: {
          from: "transactions",
          let: { mid: "$_id", periodStart: "$startDate" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$memberId", "$$mid"] },
                    { $eq: ["$direction", "IN"] },
                    { $ne: ["$isActive", false] },
                    { $gte: ["$transactionDate", "$$periodStart"] },
                  ],
                },
              },
            },
            { $group: { _id: null, paid: { $sum: "$amount" } } },
          ],
          as: "ledger",
        },
      },
      {
        $project: {
          fullName: 1,
          mobileNumber: 1,
          branch: 1,
          planCode: 1,
          startDate: 1,
          endDate: 1,
          createdAt: 1,
          totalFee: 1,
          paid: { $ifNull: [{ $arrayElemAt: ["$ledger.paid", 0] }, 0] },
        },
      },
    ]);

    const tenure = emptyBuckets(TENURE_BUCKETS);
    const receivables = emptyBuckets(DUES_BUCKETS);
    const byBranch = {};
    const debtors = [];

    let totalOutstanding = 0;

    for (const m of rows) {
      // Tenure runs from when the record was created, not from the current
      // period's startDate — a member on their fifth renewal has been here five
      // periods, and startDate only knows about the latest one.
      const joinedAt = new Date(m.createdAt || m.startDate).getTime();
      const tenureDays = Math.max(0, Math.floor((now - joinedAt) / DAY_MS));
      const tBucket = bucketFor(TENURE_BUCKETS, tenureDays);
      const tRow = tenure.find((b) => b.key === tBucket.key);
      tRow.count += 1;

      const balance = Math.max(0, (m.totalFee || 0) - (m.paid || 0));
      totalOutstanding += balance;

      byBranch[m.branch] ??= { branch: m.branch, members: 0, outstanding: 0 };
      byBranch[m.branch].members += 1;
      byBranch[m.branch].outstanding += balance;

      if (balance > 0) {
        const periodStart = new Date(m.startDate || m.createdAt).getTime();
        const ageDays = Math.max(0, Math.floor((now - periodStart) / DAY_MS));
        const dBucket = bucketFor(DUES_BUCKETS, ageDays);
        const dRow = receivables.find((b) => b.key === dBucket.key);
        dRow.count += 1;
        dRow.amount += balance;

        debtors.push({
          _id: m._id,
          fullName: m.fullName,
          mobileNumber: m.mobileNumber,
          branch: m.branch,
          planCode: m.planCode,
          startDate: m.startDate,
          endDate: m.endDate,
          totalFee: m.totalFee || 0,
          paid: m.paid || 0,
          balance,
          ageDays,
        });
      }
    }

    // Oldest debt first — that is the call list.
    debtors.sort((a, b) => b.ageDays - a.ageDays);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Member ageing fetched successfully",
      data: {
        asOf: new Date(),
        totalMembers: rows.length,
        truncated: rows.length >= AGEING_CAP,
        tenure,
        receivables,
        totalOutstanding,
        byBranch: Object.values(byBranch),
        topDebtors: debtors.slice(0, 100),
        source:
          "Tenure from Member.createdAt; dues = Member.totalFee minus Transaction " +
          "ledger receipts since startDate. Member.payments[] is never summed — " +
          "it is cleared on renewal.",
      },
    });
  } catch (error) {
    console.error("Error building member ageing report:", error);
    return fail(res, 500, "Internal server error");
  }
};
