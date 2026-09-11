import EmailForModels from "../../models/EmailFor.js";
import EmailTemplateModels from "../../models/EmailTemplate.js";
import mongoose from "mongoose";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createEmailFor = async (req, res) => {
  try {
    const { emailFor, isActive } = req.body;

    const safeEmailFor = typeof emailFor === "string" ? emailFor.trim() : "";

    const existingEmailFor = await EmailForModels.findOne({ emailFor: safeEmailFor });

    if (existingEmailFor) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email For already exists",
      });
    }

    const emailForData = new EmailForModels({
      emailFor: safeEmailFor,
      isActive,
      // === RBAC OWNERSHIP FILTER START ===
      createdBy: req.user?.id || null,
      // === RBAC OWNERSHIP FILTER END ===
    });

    await emailForData.save();

    return res.status(201).json({
      status: 201,
      isOk: true,
      message: "Email For created successfully",
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const updateEmailFor = async (req, res) => {
  try {
    const { emailForId } = req.params;

    const { emailFor, isActive } = req.body;

    const safeEmailForId = typeof emailForId === "string" ? emailForId : "";
    const safeEmailFor = typeof emailFor === "string" ? emailFor.trim() : "";

    const emailForData = await EmailForModels.findById(safeEmailForId);

    if (!emailForData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email For not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailForData.createdBy && emailForData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot modify this Email For",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const existingEmailFor = await EmailForModels.findOne({
      emailFor: safeEmailFor,
      _id: { $ne: safeEmailForId },
    });

    if (existingEmailFor) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email For already exists",
      });
    }

    emailForData.emailFor = safeEmailFor;
    emailForData.isActive = isActive;

    await emailForData.save();

    return res.status(200).json({
      status: 200,
      isOk: true,
      message: "Email For updated successfully",
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const getEmailForById = async (req, res) => {
  try {
    const { emailForId } = req.params;

    const emailForData = await EmailForModels.findById(emailForId);

    if (!emailForData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email For not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailForData.createdBy && emailForData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot view this Email For",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      status: 200,
      isOk: true,
      data: emailForData,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const listAllEmailFor = async (req, res) => {
  try {
    // === RBAC OWNERSHIP FILTER START ===
    const filterQuery = { isActive: true };
    if (req.user?.role !== "ADMIN") {
      filterQuery.createdBy = req.user?.id;
    }
    const emailForData = await EmailForModels.find(filterQuery);
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      status: 200,
      isOk: true,
      data: emailForData,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const deleteEmailFor = async (req, res) => {
  try {
    const { emailForId } = req.params;
    

    const emailForData = await EmailForModels.findById(emailForId);

    if (!emailForData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email For not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailForData.createdBy && emailForData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot delete this Email For",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const dependantTemplate = await EmailTemplateModels.find({
      emailFor: emailForData._id,
    });

    if (dependantTemplate.length > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "Email for is being used in Email Template. Either Delete or change the Email For Field in the Template.",
      });
    }

    await EmailForModels.findByIdAndDelete(emailForId);

    return res.status(200).json({
      status: 200,
      isOk: true,
      message: "Email For deleted successfully",
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const listEmailForByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    // Sanitize numeric inputs
    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    // Sanitize isActive input
    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    // Build the initial match condition
    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }
    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && req.user?.id) {
      matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
    }
    // === RBAC OWNERSHIP FILTER END ===

    // Add sorting stage
    const allowedFields = ["emailFor", "isActive", "createdAt", "updatedAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const pipeline = [
      { $sort: { [safeSortField]: sortOrder } },
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    emailFor: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),
      {
        $match: matchCondition,
      },
      {
        $facet: {
          stage1: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
              },
            },
          ],
          stage2: [{ $skip: safeSkip }, { $limit: safePerPage }],
        },
      },
      {
        $unwind: "$stage1",
      },
      {
        $project: {
          count: "$stage1.count",
          data: "$stage2",
        },
      },
    ];

    const list = await EmailForModels.aggregate(pipeline);

    return res.status(200).json({
      isOk: true,
      data: list,
      status: 200,
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};
