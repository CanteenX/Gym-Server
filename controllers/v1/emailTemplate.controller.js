import EmailTemplateModels from "../../models/EmailTemplate.js";
import mongoose from "mongoose";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createEmailTemplate = async (req, res) => {
  try {
    const {
      templateName,
      emailFrom,
      emailFor,
      mailerName,
      emailCC,
      emailBCC,
      emailSubject,
      emailSignature,
      isActive,
      isAdmin,
      emailTo,
    } = req.body;

    const emailTemplate = new EmailTemplateModels({
      templateName,
      emailFrom,
      emailFor,
      mailerName,
      emailCC,
      emailBCC,
      emailSubject,
      emailSignature,
      isActive,
      isAdmin,
      emailTo: emailTo || null,
      // === RBAC OWNERSHIP FILTER START ===
      createdBy: req.user?.id || null,
      // === RBAC OWNERSHIP FILTER END ===
    });

    await emailTemplate.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Email Template created successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const updateEmailTemplate = async (req, res) => {
  try {
    const { emailTemplateId } = req.params;

    const {
      templateName,
      emailFrom,
      emailFor,
      mailerName,
      emailCC,
      emailBCC,
      emailSubject,
      emailSignature,
      isActive,
      isAdmin,
      emailTo,
    } = req.body;

    const safeEmailTemplateId = typeof emailTemplateId === "string" ? emailTemplateId.trim() : "";

    const emailTemplate = await EmailTemplateModels.findById(safeEmailTemplateId);

    if (!emailTemplate) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Template not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailTemplate.createdBy && emailTemplate.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot modify this Email Template",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    await EmailTemplateModels.findByIdAndUpdate(
      emailTemplateId,
      {
        templateName,
        emailFrom,
        emailFor,
        mailerName,
        emailCC,
        emailBCC,
        emailSubject,
        emailSignature,
        isActive,
        isAdmin,
        emailTo: emailTo || null,
      },
      { new: true },
    );

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Email Template updated successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const getEmailTemplateById = async (req, res) => {
  try {
    const { emailTemplateId } = req.params;

    const emailTemplate = await EmailTemplateModels.findById(emailTemplateId)
      .populate("emailFrom")
      .populate("emailFor")
      .populate("emailTo");

    if (!emailTemplate) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Template not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailTemplate.createdBy && emailTemplate.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot view this Email Template",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: emailTemplate,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const deleteEmailTemplate = async (req, res) => {
  try {
    const { emailTemplateId } = req.params;

    const emailTemplate = await EmailTemplateModels.findById(emailTemplateId);

    if (!emailTemplate) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Template not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailTemplate.createdBy && emailTemplate.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot delete this Email Template",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    await EmailTemplateModels.findByIdAndDelete(emailTemplateId);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Email Template deleted successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
};

export const listEmailTemplateByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    // Sanitize numeric inputs
    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

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

    const safeMatch = typeof match === "string" ? match.trim() : "";
    const escapedMatch = escapeRegex(safeMatch);

    const allowedFields = ["templateName", "mailerName", "emailSubject", "isActive", "createdAt", "updatedAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const pipeline = [
      { $sort: { [safeSortField]: sortOrder } },
      ...(safeMatch
        ? [
          {
            $match: {
              $or: [
                {
                  templateName: {
                    $regex: escapedMatch,
                    $options: "i",
                  },
                },
                {
                  mailerName: {
                    $regex: escapedMatch,
                    $options: "i",
                  },
                },
                {
                  emailSubject: {
                    $regex: escapedMatch,
                    $options: "i",
                  },
                },
                {
                  "emailFrom.email": {
                    $regex: escapedMatch,
                    $options: "i",
                  },
                },
                {
                  "emailFor.emailFor": {
                    $regex: escapedMatch,
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
        $lookup: {
          from: "emailsetups",
          localField: "emailFrom",
          foreignField: "_id",
          as: "emailFrom",
        },
      },
      {
        $lookup: {
          from: "emailfors",
          localField: "emailFor",
          foreignField: "_id",
          as: "emailFor",
        },
      },
      {
        $lookup: {
          from: "emailtos",
          localField: "emailTo",
          foreignField: "_id",
          as: "emailTo",
        },
      },
      {
        $unwind: {
          path: "$emailFrom",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: "$emailFor",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: "$emailTo",
          preserveNullAndEmptyArrays: true,
        },
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

    const list = await EmailTemplateModels.aggregate(pipeline);

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

export const listAllEmailTemplates = async (req, res) => {
  try {
    // === RBAC OWNERSHIP FILTER START ===
    const filterQuery = { isActive: true };
    if (req.user?.role !== "ADMIN") {
      filterQuery.createdBy = req.user?.id;
    }
    const emailTemplates = await EmailTemplateModels.find(filterQuery).select("_id templateName");
    // === RBAC OWNERSHIP FILTER END ===
    return res.status(200).json({
      isOk: true,
      data: emailTemplates,
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
