import Branch from "../../models/Branch.js";
import Member from "../../models/Member.js";
import Trainer from "../../models/Trainer.js";
import Transaction from "../../models/Transaction.js";
import Attendance from "../../models/Attendance.js";
import Employee from "../../models/Employee.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * How many records still carry this branch NAME, per collection.
 *
 * Branch is stored as a plain string on all five of these models (see
 * models/Branch.js for why), so "is this branch in use?" is answered by
 * counting string matches, not by counting references. Used both to refuse a
 * rename and to explain why a delete is refused.
 */
const countBranchUsage = async (name) => {
  const [members, trainers, transactions, attendance, employees] =
    await Promise.all([
      Member.countDocuments({ branch: name }),
      Trainer.countDocuments({ branch: name }),
      Transaction.countDocuments({ branch: name }),
      Attendance.countDocuments({ branch: name }),
      Employee.countDocuments({ branch: name }),
    ]);

  return {
    members,
    trainers,
    transactions,
    attendance,
    employees,
    total: members + trainers + transactions + attendance + employees,
  };
};

/** Human-readable "12 member(s), 3 transaction(s)" for error messages. */
const describeUsage = (usage) =>
  [
    [usage.members, "member"],
    [usage.trainers, "trainer"],
    [usage.transactions, "transaction"],
    [usage.attendance, "attendance record"],
    [usage.employees, "staff account"],
  ]
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(", ");

/**
 * Branches for dropdowns, in display order.
 *
 * `?physicalOnly=true` excludes non-physical rows ("Common"). Member, trainer
 * and staff pickers MUST pass it — nobody trains at or is employed by a cost
 * bucket. Expense and transaction pickers call this without the flag so
 * "Common" remains selectable.
 *
 * `?includeInactive=true` returns deactivated branches too (for the admin
 * table); by default only active branches are returned.
 */
export const listBranches = async (req, res) => {
  try {
    const { physicalOnly, includeInactive } = req.query;

    const condition = {};
    if (includeInactive !== "true") condition.isActive = true;
    if (physicalOnly === "true") condition.isPhysical = true;

    const branches = await Branch.find(condition).sort({
      sequence: 1,
      name: 1,
    });

    return res.status(200).json({ isOk: true, status: 200, data: branches });
  } catch (error) {
    console.error("Error listing branches:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Paginated list for the admin Branch Master table. */
export const listBranchesByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, isActive, isPhysical } =
      req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const condition = {};
    if (isActive !== undefined && isActive !== "") {
      condition.isActive = isActive === true || isActive === "true";
    }
    if (isPhysical !== undefined && isPhysical !== "") {
      condition.isPhysical = isPhysical === true || isPhysical === "true";
    }
    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      condition.$or = [
        { name: { $regex: escapeRegex(safeMatch), $options: "i" } },
        { displayName: { $regex: escapeRegex(safeMatch), $options: "i" } },
      ];
    }

    const allowed = ["name", "sequence", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "sequence";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await Branch.countDocuments(condition);
    const branches = await Branch.find(condition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    // Show how many records each branch carries, so staff understand why a
    // rename or delete is refused.
    const data = [];
    for (const branch of branches) {
      const usage = await countBranchUsage(branch.name);
      data.push({ ...branch, usage, usedCount: usage.total });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing branches by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getBranchById = async (req, res) => {
  try {
    const { id } = req.params;
    const branch = await Branch.findById(id).lean();
    if (!branch) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Branch not found" });
    }

    const usage = await countBranchUsage(branch.name);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: { ...branch, usage, usedCount: usage.total },
    });
  } catch (error) {
    console.error("Error fetching branch:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createBranch = async (req, res) => {
  try {
    const { name, displayName, address, phone, sequence, isActive, isPhysical } =
      req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Branch name is required",
      });
    }

    // Case-insensitive clash check: "vasna" and "Vasna" would be two rows but
    // one branch in everyone's head, and the strings stored on members would
    // not match between them.
    const existing = await Branch.findOne({
      name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
    });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `A branch named "${existing.name}" already exists`,
      });
    }

    const branch = new Branch({
      name: name.trim(),
      displayName: displayName?.trim() || "",
      address: address?.trim() || "",
      phone: phone?.trim() || "",
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
      isPhysical: isPhysical !== undefined ? isPhysical : true,
    });
    await branch.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Branch added successfully",
      data: branch,
    });
  } catch (error) {
    console.error("Error creating branch:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const branch = await Branch.findById(id);
    if (!branch) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Branch not found" });
    }

    /**
     * Renaming is only allowed while the branch is unused.
     *
     * Branch is stored as a STRING on Member, Trainer, Transaction, Attendance
     * and Employee — not as an ObjectId reference. Changing the name here
     * therefore changes nothing on those records: they would keep the old
     * spelling and be orphaned, invisible to every dropdown and to
     * branchScope.js, which matches the session's branch string literally.
     * Unlike expense categories (a single field on one collection, which the
     * category controller can safely relabel in bulk), a branch rename would
     * have to rewrite five collections plus every printed receipt's meaning,
     * so it is refused rather than half-done.
     */
    if (req.body.name !== undefined && req.body.name.trim()) {
      const newName = req.body.name.trim();
      if (newName !== branch.name) {
        const usage = await countBranchUsage(branch.name);
        if (usage.total > 0) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message:
              `"${branch.name}" cannot be renamed — ${usage.total} record(s) ` +
              `still reference it (${describeUsage(usage)}). Branch is stored ` +
              `as a name on those records, so renaming would orphan them. ` +
              `Create a new branch and deactivate this one instead.`,
            usage,
            usedCount: usage.total,
          });
        }

        const clash = await Branch.findOne({
          _id: { $ne: id },
          name: new RegExp(`^${escapeRegex(newName)}$`, "i"),
        });
        if (clash) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: `Another branch already uses the name "${clash.name}"`,
          });
        }

        branch.name = newName;
      }
    }

    ["displayName", "address", "phone"].forEach((f) => {
      if (req.body[f] !== undefined) branch[f] = String(req.body[f]).trim();
    });
    ["isActive", "isPhysical"].forEach((f) => {
      if (req.body[f] !== undefined) branch[f] = req.body[f];
    });
    if (req.body.sequence !== undefined) {
      branch.sequence = Number(req.body.sequence);
    }

    await branch.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Branch updated successfully",
      data: branch,
    });
  } catch (error) {
    console.error("Error updating branch:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Deactivate a branch — the supported way to retire one.
 *
 * A closed gym disappears from every picker while every member, receipt and
 * past visit that names it keeps its meaning.
 */
export const deactivateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const branch = await Branch.findById(id);
    if (!branch) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Branch not found" });
    }

    branch.isActive = false;
    await branch.save();

    const usage = await countBranchUsage(branch.name);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: usage.total
        ? `${branch.name} deactivated — ${usage.total} existing record(s) keep their branch`
        : `${branch.name} deactivated`,
      data: branch,
      usage,
    });
  } catch (error) {
    console.error("Error deactivating branch:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * DELETE exists only to say no, clearly.
 *
 * The admin table follows the same shape as every other master screen, so a
 * DELETE route is expected by convention — but branches are deactivated, never
 * deleted. Removing the row would not remove the "Vasna" string sitting on
 * thousands of members, transactions and receipts; it would just make that
 * string unexplainable. This returns 400 with the dependency counts so the UI
 * can tell the user exactly what is standing in the way, and offer Deactivate.
 */
export const deleteBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const branch = await Branch.findById(id);
    if (!branch) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Branch not found" });
    }

    const usage = await countBranchUsage(branch.name);
    const detail = usage.total
      ? ` ${usage.total} record(s) depend on it (${describeUsage(usage)}).`
      : "";

    return res.status(400).json({
      isOk: false,
      status: 400,
      message:
        `Branches are deactivated, never deleted.${detail} Members, receipts ` +
        `and attendance store the branch name, so deleting "${branch.name}" ` +
        `would leave them pointing at a branch that no longer exists. ` +
        `Set it inactive instead to hide it from new entries.`,
      usage,
      usedCount: usage.total,
    });
  } catch (error) {
    console.error("Error deleting branch:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
