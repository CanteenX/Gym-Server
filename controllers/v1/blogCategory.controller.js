import BlogCategory from "../../models/BlogCategory.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const createSlug = (text = "") => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
};

export const createBlogCategory = async (req, res) => {
  try {
    const { categoryName, description, sequence, isActive } = req.body;

    if (!categoryName) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Category Name is required",
      });
    }

    const slug = createSlug(categoryName);
    const existing = await BlogCategory.findOne({ slug });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A category with this name already exists",
      });
    }

    const blogCategory = new BlogCategory({
      categoryName,
      slug,
      description: description || "",
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    await blogCategory.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Blog Category created successfully",
      data: blogCategory,
    });
  } catch (error) {
    console.error("Error creating blog category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateBlogCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { categoryName, description, sequence, isActive } = req.body;

    const category = await BlogCategory.findById(id);
    if (!category) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog Category not found",
      });
    }

    let slug = category.slug;
    if (categoryName && categoryName !== category.categoryName) {
      slug = createSlug(categoryName);
      const existing = await BlogCategory.findOne({ slug, _id: { $ne: id } });
      if (existing) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: "Another category with this name already exists",
        });
      }
    }

    category.categoryName = categoryName !== undefined ? categoryName : category.categoryName;
    category.slug = slug;
    category.description = description !== undefined ? description : category.description;
    category.sequence = sequence !== undefined ? Number(sequence) : category.sequence;
    category.isActive = isActive !== undefined ? isActive : category.isActive;

    await category.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Blog Category updated successfully",
      data: category,
    });
  } catch (error) {
    console.error("Error updating blog category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getBlogCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await BlogCategory.findById(id);

    if (!category) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog Category not found",
      });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: category,
    });
  } catch (error) {
    console.error("Error fetching blog category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteBlogCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await BlogCategory.findById(id);

    if (!category) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog Category not found",
      });
    }

    await BlogCategory.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Blog Category deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting blog category:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listAllBlogCategories = async (req, res) => {
  try {
    const categories = await BlogCategory.find().sort({ sequence: 1, categoryName: 1 });
    return res.status(200).json({
      isOk: true,
      status: 200,
      data: categories,
    });
  } catch (error) {
    console.error("Error listing blog categories:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listBlogCategoriesByParams = async (req, res) => {
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

    const totalCount = await BlogCategory.countDocuments(matchCondition);
    const data = await BlogCategory.find(matchCondition)
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
    console.error("Error listing blog categories by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
