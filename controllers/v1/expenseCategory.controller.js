import ExpenseCategory from "../../models/ExpenseCategory.js";
import Transaction from "../../models/Transaction.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Active categories for dropdowns, in display order. */
export const listAllExpenseCategories = async (_req, res) => {
  try {
    const categories = await ExpenseCategory.find({ isActive: true }).sort({
      sequence: 1,
      name: 1,
    });
    return res.status(200).json({ isOk: true, status: 200, data: categories });
  } catch (error) {
    console.error("Error listing expense categories:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createExpenseCategory = async (req, res) => {
  try {
    const { name, description, sequence, isActive } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Category name is required",
      });
    }

    const existing = await ExpenseCategory.findOne({
      name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
    });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A category with this name already exists",
      });
    }

    const category = new ExpenseCategory({
      name: name.trim(),
      description: description?.trim() || "",
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });
    await category.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Expense category added successfully",
      data: category,
    });
  } catch (error) {
    console.error("Error creating expense category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateExpenseCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await ExpenseCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Category not found" });
    }

    const previousName = category.name;

    if (req.body.name !== undefined && req.body.name.trim()) {
      const clash = await ExpenseCategory.findOne({
        _id: { $ne: id },
        name: new RegExp(`^${escapeRegex(req.body.name.trim())}$`, "i"),
      });
      if (clash) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "Another category already uses this name",
        });
      }
      category.name = req.body.name.trim();
    }

    ["description", "isActive"].forEach((f) => {
      if (req.body[f] !== undefined) category[f] = req.body[f];
    });
    if (req.body.sequence !== undefined) {
      category.sequence = Number(req.body.sequence);
    }

    await category.save();

    // Ledger rows store the category NAME. Keep historical rows pointing at the
    // renamed category so reports don't split one cost across two labels.
    let migrated = 0;
    if (category.name !== previousName) {
      const result = await Transaction.updateMany(
        { direction: "OUT", category: previousName },
        { $set: { category: category.name } },
      );
      migrated = result.modifiedCount || 0;
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: migrated
        ? `Category updated — ${migrated} past expense(s) relabelled`
        : "Category updated successfully",
      data: category,
    });
  } catch (error) {
    console.error("Error updating expense category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Refuses if the category is in use, so historical expenses keep their label. */
export const deleteExpenseCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await ExpenseCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Category not found" });
    }

    const used = await Transaction.countDocuments({
      direction: "OUT",
      category: category.name,
    });
    if (used > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `${category.name} is used by ${used} expense entr${
          used === 1 ? "y" : "ies"
        }. Deactivate it instead so past records keep their label.`,
        usedCount: used,
      });
    }

    await ExpenseCategory.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting expense category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listExpenseCategoriesByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const condition = {};
    if (isActive !== undefined && isActive !== "") {
      condition.isActive = isActive === true || isActive === "true";
    }
    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      condition.name = { $regex: escapeRegex(safeMatch), $options: "i" };
    }

    const allowed = ["name", "sequence", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "sequence";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await ExpenseCategory.countDocuments(condition);
    const categories = await ExpenseCategory.find(condition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    // Show how many expenses each category carries, so staff understand why a
    // delete may be refused.
    const names = categories.map((c) => c.name);
    const counts = await Transaction.aggregate([
      { $match: { direction: "OUT", category: { $in: names } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    const data = categories.map((c) => ({
      ...c,
      usedCount: countMap.get(c.name) || 0,
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing expense categories:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
