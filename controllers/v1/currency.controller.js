import CurrencyMaster from "../../models/CurrencyMaster.js";
import {
  getReferencingCounts,
  formatReferenceMessage,
} from "../../utils/referenceHelper.js";
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
// Create CurrencyMaster
export const createCurrencyMaster = async (req, res) => {
  try {
    const { currencyName, currencyCode, currencySymbol, isActive } = req.body;

    const safeCurrencyName = typeof currencyName === "string" ? currencyName.trim() : "";
    const safeCurrencyCode = typeof currencyCode === "string" ? currencyCode.trim() : "";

    // Check if currency with same name already exists
    const existingCurrencyByName = await CurrencyMaster.findOne({
      currencyName: {
        $regex: new RegExp(`^${escapeRegex(safeCurrencyName)}$`, "i"),
      },
    });

    if (existingCurrencyByName) {
      return res.status(400).json({
        isOk: false,
        message: "Currency with this name already exists",
      });
    }

    // Check if currency with same code already exists
    const existingCurrencyByCode = await CurrencyMaster.findOne({
      currencyCode: {
        $regex: new RegExp(`^${escapeRegex(safeCurrencyCode)}$`, "i"),
      },
    });

    if (existingCurrencyByCode) {
      return res.status(400).json({
        isOk: false,
        message: "Currency with this code already exists",
      });
    }

    const newCurrencyMaster = new CurrencyMaster({
      currencyName: safeCurrencyName,
      currencyCode: safeCurrencyCode,
      currencySymbol,
      isActive,
    });

    const savedCurrencyMaster = await newCurrencyMaster.save();
    res.status(201).json({
      isOk: true,
      data: savedCurrencyMaster,
      message: "Currency created successfully",
    });
  } catch (error) {
    console.error("Error creating currency:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to create currency",
      error: error.message,
    });
  }
};

// Get CurrencyMaster by ID
export const getCurrencyMasterById = async (req, res) => {
  try {
    const { id } = req.params;
    const currencyMaster = await CurrencyMaster.findById(id);

    if (!currencyMaster) {
      return res.status(404).json({
        isOk: false,
        message: "Currency not found",
      });
    }

    res.status(200).json({
      isOk: true,
      data: currencyMaster,
    });
  } catch (error) {
    console.error("Error fetching currency:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to fetch currency",
      error: error.message,
    });
  }
};

// Update CurrencyMaster
export const updateCurrencyMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const { currencyName, currencyCode, currencySymbol, isActive } = req.body;

    const safeId = typeof id === "string" ? id.trim() : "";
    const safeCurrencyName = typeof currencyName === "string" ? currencyName.trim() : "";
    const safeCurrencyCode = typeof currencyCode === "string" ? currencyCode.trim() : "";

    // Check if another currency with same name already exists (excluding current currency)
    const existingCurrencyByName = await CurrencyMaster.findOne({
      _id: { $ne: safeId },
      currencyName: {
        $regex: new RegExp(`^${escapeRegex(safeCurrencyName)}$`, "i"),
      },
    });

    if (existingCurrencyByName) {
      return res.status(400).json({
        isOk: false,
        message: "Currency with this name already exists",
      });
    }

    // Check if another currency with same code already exists (excluding current currency)
    const existingCurrencyByCode = await CurrencyMaster.findOne({
      _id: { $ne: safeId },
      currencyCode: {
        $regex: new RegExp(`^${escapeRegex(safeCurrencyCode)}$`, "i"),
      },
    });

    if (existingCurrencyByCode) {
      return res.status(400).json({
        isOk: false,
        message: "Currency with this code already exists",
      });
    }

    const updatedCurrencyMaster = await CurrencyMaster.findByIdAndUpdate(
      safeId,
      {
        currencyName: safeCurrencyName,
        currencyCode: safeCurrencyCode,
        currencySymbol,
        isActive,
      },
      { new: true, runValidators: true },
    );

    if (!updatedCurrencyMaster) {
      return res.status(404).json({
        isOk: false,
        message: "Currency not found",
      });
    }

    res.status(200).json({
      isOk: true,
      data: updatedCurrencyMaster,
      message: "Currency updated successfully",
    });
  } catch (error) {
    console.error("Error updating currency:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to update currency",
      error: error.message,
    });
  }
};

// Delete CurrencyMaster
export const deleteCurrencyMaster = async (req, res) => {
  try {
    const { id } = req.params;

    // Check for references before deletion
    const referenceInfo = await getReferencingCounts("CurrencyMaster", id);

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete Currency. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    const deletedCurrencyMaster = await CurrencyMaster.findByIdAndDelete(id);

    if (!deletedCurrencyMaster) {
      return res.status(404).json({
        isOk: false,
        message: "Currency not found",
      });
    }

    res.status(200).json({
      isOk: true,
      message: "Currency deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting currency:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to delete currency",
      error: error.message,
    });
  }
};

// List CurrencyMasters with pagination, sorting, and filtering
export const listCurrencyMastersByParams = async (req, res) => {
  try {
    const {
      skip = 0,
      per_page = 100,
      sorton = "createdAt",
      sortdir = "desc",
      match = "",
      isActive,
    } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    // Filter by active status if provided
    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    let queryCondition = {};
    if (typeof safeIsActive === "boolean") {
      queryCondition.isActive = safeIsActive;
    }

    // Search functionality
    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escapedMatch = escapeRegex(safeMatch);

      queryCondition.$or = [
        { currencyName: { $regex: escapedMatch, $options: "i" } },
        { currencyCode: { $regex: escapedMatch, $options: "i" } },
        { currencySymbol: { $regex: escapedMatch, $options: "i" } },
      ];
    }

    // Sorting
    const allowedSortFields = ["currencyName", "currencyCode", "currencySymbol", "isActive", "createdAt", "updatedAt"];
    const safeSortField = allowedSortFields.includes(sorton) ? sorton : "createdAt";
    let sort = {};
    sort[safeSortField] = sortdir === "desc" ? -1 : 1;

    // Aggregation pipeline
    const pipeline = [
      { $match: queryCondition },
      {
        $facet: {
          data: [
            { $sort: sort },
            { $skip: safeSkip },
            { $limit: safePerPage },
          ],
          count: [{ $count: "total" }],
        },
      },
    ];

    const result = await CurrencyMaster.aggregate(pipeline);
    const currencies = result[0].data;
    const count = result[0].count[0]?.total || 0;

    const response = [
      {
        data: currencies,
        count: count,
      },
    ];

    res.status(200).json({
      isOk: true,
      data: response,
    });
  } catch (error) {
    console.error("Error listing currencies:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to fetch currencies",
      error: error.message,
    });
  }
};

// Get all active CurrencyMasters (for dropdowns)
export const getAllActiveCurrencyMasters = async (req, res) => {
  try {
    const currencies = await CurrencyMaster.find({ isActive: true })
      .select("currencyName currencyCode currencySymbol")
      .sort({ currencyName: 1 });

    res.status(200).json({
      isOk: true,
      data: currencies,
    });
  } catch (error) {
    console.error("Error fetching active currencies:", error);
    res.status(500).json({
      isOk: false,
      message: "Failed to fetch active currencies",
      error: error.message,
    });
  }
};
