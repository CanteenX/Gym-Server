import FaqCategory from "../../models/FaqCategory.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createFaqCategory = async (req, res) => {
  try {
    const { categoryName, description, sequence, isActive } = req.body;

    if (!categoryName) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Category Name is required",
      });
    }

    const existing = await FaqCategory.findOne({
      categoryName: { $regex: new RegExp(`^${escapeRegex(categoryName.trim())}$`, "i") }
    });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A category with this name already exists",
      });
    }

    const faqCategory = new FaqCategory({
      categoryName: categoryName.trim(),
      description: description || "",
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    await faqCategory.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "FAQ Category created successfully",
      data: faqCategory,
    });
  } catch (error) {
    console.error("Error creating FAQ category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateFaqCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { categoryName, description, sequence, isActive } = req.body;

    const category = await FaqCategory.findById(id);
    if (!category) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "FAQ Category not found",
      });
    }

    if (categoryName && categoryName.trim().toLowerCase() !== category.categoryName.toLowerCase()) {
      const existing = await FaqCategory.findOne({
        categoryName: { $regex: new RegExp(`^${escapeRegex(categoryName.trim())}$`, "i") },
        _id: { $ne: id }
      });
      if (existing) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "Another category with this name already exists",
        });
      }
    }

    category.categoryName = categoryName !== undefined ? categoryName.trim() : category.categoryName;
    category.description = description !== undefined ? description : category.description;
    category.sequence = sequence !== undefined ? Number(sequence) : category.sequence;
    category.isActive = isActive !== undefined ? isActive : category.isActive;

    await category.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "FAQ Category updated successfully",
      data: category,
    });
  } catch (error) {
    console.error("Error updating FAQ category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteFaqCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await FaqCategory.findById(id);

    if (!category) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "FAQ Category not found",
      });
    }

    await FaqCategory.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "FAQ Category deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting FAQ category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listAllFaqCategories = async (req, res) => {
  try {
    const categories = await FaqCategory.find().sort({ sequence: 1, categoryName: 1 });
    return res.status(200).json({
      isOk: true,
      status: 200,
      data: categories,
    });
  } catch (error) {
    console.error("Error listing FAQ categories:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listFaqCategoriesByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 10;

    let matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { categoryName: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = ["categoryName", "sequence", "isActive", "createdAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await FaqCategory.countDocuments(matchCondition);
    const data = await FaqCategory.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [
        {
          count: totalCount,
          data: data,
        },
      ],
    });
  } catch (error) {
    console.error("Error listing FAQ categories by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
