import MembershipPlan from "../../models/MembershipPlan.js";
import Member from "../../models/Member.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Lightweight list for dropdowns — active plans only, in display order. */
export const listAllPlans = async (_req, res) => {
  try {
    const plans = await MembershipPlan.find({ isActive: true }).sort({
      sequence: 1,
      label: 1,
    });

    return res.status(200).json({ isOk: true, status: 200, data: plans });
  } catch (error) {
    console.error("Error listing membership plans:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createPlan = async (req, res) => {
  try {
    const {
      code,
      label,
      months,
      defaultFee,
      requiresTrainer,
      sequence,
      isActive,
    } = req.body;

    if (!code?.trim()) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Plan code is required" });
    }
    if (!label?.trim()) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Plan name is required" });
    }
    if (months === undefined || Number(months) < 1) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Duration must be at least 1 month",
      });
    }
    if (defaultFee === undefined || Number(defaultFee) < 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Default fee cannot be negative",
      });
    }

    const normalisedCode = code.trim().toUpperCase();
    const existing = await MembershipPlan.findOne({ code: normalisedCode });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A plan with this code already exists",
      });
    }

    const plan = new MembershipPlan({
      code: normalisedCode,
      label: label.trim(),
      months: Number(months),
      defaultFee: Number(defaultFee),
      requiresTrainer:
        requiresTrainer !== undefined ? Boolean(requiresTrainer) : false,
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    await plan.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Membership plan added successfully",
      data: plan,
    });
  } catch (error) {
    console.error("Error creating membership plan:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await MembershipPlan.findById(id);
    if (!plan) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Membership plan not found" });
    }

    const { code, label, months, defaultFee, requiresTrainer, sequence, isActive } =
      req.body;

    // Renaming a code would orphan every member carrying the old one, so the
    // new code is checked for collisions and members are migrated with it.
    let previousCode = null;
    if (code !== undefined && code.trim()) {
      const normalisedCode = code.trim().toUpperCase();
      if (normalisedCode !== plan.code) {
        const clash = await MembershipPlan.findOne({
          code: normalisedCode,
          _id: { $ne: plan._id },
        });
        if (clash) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: "A plan with this code already exists",
          });
        }
        previousCode = plan.code;
        plan.code = normalisedCode;
      }
    }

    if (label !== undefined) plan.label = label.trim();
    if (months !== undefined) plan.months = Number(months);
    if (defaultFee !== undefined) plan.defaultFee = Number(defaultFee);
    if (requiresTrainer !== undefined) {
      plan.requiresTrainer = Boolean(requiresTrainer);
    }
    if (sequence !== undefined) plan.sequence = Number(sequence);
    if (isActive !== undefined) plan.isActive = isActive;

    await plan.save();

    if (previousCode) {
      await Member.updateMany(
        { planCode: previousCode },
        { $set: { planCode: plan.code } },
      );
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Membership plan updated successfully",
      data: plan,
    });
  } catch (error) {
    console.error("Error updating membership plan:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Deleting a plan that members are still on would leave their planCode pointing
 * at nothing, so this refuses and reports how many need moving first.
 */
export const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await MembershipPlan.findById(id);
    if (!plan) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Membership plan not found" });
    }

    const memberCount = await Member.countDocuments({ planCode: plan.code });
    if (memberCount > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `${plan.label} is used by ${memberCount} member(s). Move them to another plan before deleting it.`,
        memberCount,
      });
    }

    await MembershipPlan.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Membership plan deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting membership plan:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listPlansByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { code: { $regex: escaped, $options: "i" } },
        { label: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = [
      "code",
      "label",
      "months",
      "defaultFee",
      "sequence",
      "createdAt",
    ];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "sequence";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await MembershipPlan.countDocuments(matchCondition);
    const plans = await MembershipPlan.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    // Attach the member count so the list can warn before a blocked delete.
    const codes = plans.map((p) => p.code);
    const counts = await Member.aggregate([
      { $match: { planCode: { $in: codes } } },
      { $group: { _id: "$planCode", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    const data = plans.map((p) => ({
      ...p,
      memberCount: countMap.get(p.code) || 0,
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing membership plans by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
