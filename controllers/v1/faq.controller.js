import Faq from "../../models/Faq.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createFaq = async (req, res) => {
  try {
    const { category, question, answer, sequence, isActive } = req.body;

    if (!category) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Category is required",
      });
    }
    if (!question) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Question is required",
      });
    }
    if (!answer) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Answer is required",
      });
    }

    const faq = new Faq({
      category,
      question: question.trim(),
      answer: answer.trim(),
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    await faq.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "FAQ created successfully",
      data: faq,
    });
  } catch (error) {
    console.error("Error creating FAQ:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateFaq = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, answer, sequence, isActive } = req.body;

    const faq = await Faq.findById(id);
    if (!faq) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "FAQ not found",
      });
    }

    faq.category = category !== undefined ? category : faq.category;
    faq.question = question !== undefined ? question.trim() : faq.question;
    faq.answer = answer !== undefined ? answer.trim() : faq.answer;
    faq.sequence = sequence !== undefined ? Number(sequence) : faq.sequence;
    faq.isActive = isActive !== undefined ? isActive : faq.isActive;

    await faq.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "FAQ updated successfully",
      data: faq,
    });
  } catch (error) {
    console.error("Error updating FAQ:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteFaq = async (req, res) => {
  try {
    const { id } = req.params;
    const faq = await Faq.findById(id);

    if (!faq) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "FAQ not found",
      });
    }

    await Faq.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "FAQ deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting FAQ:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listFaqsByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive, categoryId } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 10;

    let matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    if (categoryId) {
      matchCondition.category = categoryId;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { question: { $regex: escaped, $options: "i" } },
        { answer: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = ["question", "sequence", "isActive", "createdAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await Faq.countDocuments(matchCondition);
    const data = await Faq.find(matchCondition)
      .populate("category", "categoryName")
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
    console.error("Error listing FAQs by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
