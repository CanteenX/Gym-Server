import EmailToModels from "../../models/EmailTo.js";
import EmailTemplateModels from "../../models/EmailTemplate.js";
import mongoose from "mongoose";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createEmailTo = async (req, res) => {
  try {
    const { name, email, isActive } = req.body;

    const safeName = typeof name === "string" ? name.trim() : "";
    const safeEmail = typeof email === "string" ? email.trim() : "";

    const existingEmailTo = await EmailToModels.findOne({
      $or: [
        { name: safeName },
        { email: safeEmail }
      ]
    });

    if (existingEmailTo) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email To configuration with this name or email already exists",
      });
    }

    const emailToData = new EmailToModels({
      name: safeName,
      email: safeEmail,
      isActive,
      // === RBAC OWNERSHIP FILTER START ===
      createdBy: req.user?.id || null,
      // === RBAC OWNERSHIP FILTER END ===
    });

    await emailToData.save();

    return res.status(201).json({
      status: 201,
      isOk: true,
      message: "Email To created successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const updateEmailTo = async (req, res) => {
  try {
    const { emailToId } = req.params;
    const { name, email, isActive } = req.body;

    const safeEmailToId = typeof emailToId === "string" ? emailToId : "";
    const safeName = typeof name === "string" ? name.trim() : "";
    const safeEmail = typeof email === "string" ? email.trim() : "";

    const emailToData = await EmailToModels.findById(safeEmailToId);

    if (!emailToData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email To not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailToData.createdBy && emailToData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot modify this Email To",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const existingEmailTo = await EmailToModels.findOne({
      $or: [
        { name: safeName },
        { email: safeEmail }
      ],
      _id: { $ne: safeEmailToId },
    });

    if (existingEmailTo) {
      return res.status(409).json({
        isOk: false,
        status: 409,
        message: "Email To with this name or email already exists",
      });
    }

    emailToData.name = safeName;
    emailToData.email = safeEmail;
    emailToData.isActive = isActive;

    await emailToData.save();

    return res.status(200).json({
      status: 200,
      isOk: true,
      message: "Email To updated successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const getEmailToById = async (req, res) => {
  try {
    const { emailToId } = req.params;

    const emailToData = await EmailToModels.findById(emailToId);

    if (!emailToData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email To not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailToData.createdBy && emailToData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot view this Email To",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      status: 200,
      isOk: true,
      data: emailToData,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const listAllEmailTo = async (req, res) => {
  try {
    // === RBAC OWNERSHIP FILTER START ===
    const filterQuery = { isActive: true };
    if (req.user?.role !== "ADMIN") {
      filterQuery.createdBy = req.user?.id;
    }
    const emailToData = await EmailToModels.find(filterQuery);
    // === RBAC OWNERSHIP FILTER END ===

    return res.status(200).json({
      status: 200,
      isOk: true,
      data: emailToData,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const deleteEmailTo = async (req, res) => {
  try {
    const { emailToId } = req.params;

    const emailToData = await EmailToModels.findById(emailToId);

    if (!emailToData) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Email To not found",
      });
    }

    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && emailToData.createdBy && emailToData.createdBy.toString() !== req.user?.id) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        message: "Access Denied: You cannot delete this Email To",
      });
    }
    // === RBAC OWNERSHIP FILTER END ===

    const dependantTemplate = await EmailTemplateModels.find({
      emailTo: emailToData._id,
    });

    if (dependantTemplate.length > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message:
          "Email To is being used in an Email Template. Please remove or change the Email To selection in that template first.",
      });
    }

    await EmailToModels.findByIdAndDelete(emailToId);

    return res.status(200).json({
      status: 200,
      isOk: true,
      message: "Email To deleted successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
      error: error.message,
    });
  }
};

export const listEmailToByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }
    // === RBAC OWNERSHIP FILTER START ===
    if (req.user?.role !== "ADMIN" && req.user?.id) {
      matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
    }
    // === RBAC OWNERSHIP FILTER END ===

    const allowedFields = ["name", "email", "isActive", "createdAt", "updatedAt"];
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
                    name: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
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

    const list = await EmailToModels.aggregate(pipeline);

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
