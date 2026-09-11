import EmailSetupModels from "../../models/EmailSetup.js";
import EmailTemplateModels from "../../models/EmailTemplate.js";
import mongoose from "mongoose";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createEmailSetup = async (req, res) => {
  try {
    const { email, appPassword, SSL, port, host, isActive } = req.body;

    const safeEmail = typeof email === "string" ? email.trim() : "";

    const existingEmailSetup = await EmailSetupModels.findOne({ email: safeEmail });

    if (existingEmailSetup) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email Setup already exists",
      });
    }

    const newEmailSetup = new EmailSetupModels({
      email: safeEmail,
      appPassword,
      SSL,
      port,
      host,
      isActive,
      // === RBAC OWNERSHIP FILTER START ===
      createdBy: req.user?.id || null,
      // === RBAC OWNERSHIP FILTER END ===
    });

    await newEmailSetup.save();

    res.status(201).json({
      status: 201,
      isOk: true,
      message: "Email Setup created successfully",
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

export const updateEmailSetup = async (req, res) => {
  try {
    const { emailSetupId } = req.params;

    const { email, appPassword, SSL, port, host, isActive } = req.body;

    const safeEmailSetupId = typeof emailSetupId === "string" ? emailSetupId.trim() : "";
    const safeEmail = typeof email === "string" ? email.trim() : "";

    const emailSetup = await EmailSetupModels.findById(safeEmailSetupId);

    if (!emailSetup) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Setup not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailSetup.createdBy && emailSetup.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot modify this Email Setup",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const existingEmailSetup = await EmailSetupModels.findOne({
      email: safeEmail,
      _id: { $ne: safeEmailSetupId },
    });

    if (existingEmailSetup) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email Setup already exists",
      });
    }

    emailSetup.email = safeEmail;
    emailSetup.appPassword = appPassword;
    emailSetup.SSL = SSL;
    emailSetup.port = port;
    emailSetup.host = host;
    emailSetup.isActive = isActive;

    await emailSetup.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Email Setup updated successfully",
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

export const getEmailSetupById = async (req, res) => {
  try {
    const { emailSetupId } = req.params;

    const emailSetup = await EmailSetupModels.findById(emailSetupId);

    if (!emailSetup) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Setup not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailSetup.createdBy && emailSetup.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot view this Email Setup",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: emailSetup,
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

export const listAllEmailSetup = async (req, res) => {
  try {
    // === RBAC OWNERSHIP FILTER START ===
    const filterQuery = { isActive: true };
    if (req.user?.role !== "ADMIN") {
      filterQuery.createdBy = req.user?.id;
    }
    const emailSetup = await EmailSetupModels.find(filterQuery);
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: emailSetup,
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

export const deleteEmailSetup = async (req, res) => {
  try {
    const { emailSetupId } = req.params;

    const emailSetup = await EmailSetupModels.findById(emailSetupId);

    if (!emailSetup) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email Setup not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailSetup.createdBy && emailSetup.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot delete this Email Setup",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const dependantTemplate = await EmailTemplateModels.find({
      emailFrom: emailSetup._id,
    });

    if (dependantTemplate.length > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "Email Setup is being used in Email Template. Either Delete or change the Email Field in the Template.",
      });
    }

    await EmailSetupModels.findByIdAndDelete(emailSetupId);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Email Setup deleted successfully",
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

export const listEmailSetupByParams = async (req, res) => {
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

    const allowedFields = ["email", "isActive", "createdAt", "updatedAt"];
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
                    email: {
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

    const list = await EmailSetupModels.aggregate(pipeline);

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
