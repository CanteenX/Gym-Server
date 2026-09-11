import MenuGroupMaster from "../../models/MenuGroupMaster.js";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createMenuGroup = async (req, res) => {
  try {
    const { menuGroupName, sequence, isActive, isLink, menuUrl } = req.body;

    const menuGroup = await MenuGroupMaster.create({
      menuGroupName,
      sequence,
      isActive,
      isLink: isLink || false,
      menuUrl: isLink ? menuUrl : "#",
      icon: req.body.icon || "",
    });

    res.status(201).json({
      isOk: true,
      message: "Menu Group created successfully",
      data: menuGroup,
    });
  } catch (error) {
    console.log("Error creating menu group:", error);
    res.status(500).json({
      isOk: false,
      message: "Error creating menu group",
      error: error.message,
    });
  }
};

export const getAllMenuGroups = async (req, res) => {
  try {
    const menuGroups = await MenuGroupMaster.find({ isActive: true });

    res.status(200).json({
      isOk: true,
      message: "Menu Groups fetched successfully",
      data: menuGroups,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching menu groups",
      error: error.message,
    });
  }
};

export const getMenuGroupById = async (req, res) => {
  try {
    const { menuGroupId } = req.params;

    const menuGroup = await MenuGroupMaster.findById(menuGroupId);

    res.status(200).json({
      isOk: true,
      message: "Menu Group fetched successfully",
      data: menuGroup,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching menu group",
      error: error.message,
    });
  }
};

export const updateMenuGroup = async (req, res) => {
  try {
    const { menuGroupId } = req.params;
    const { menuGroupName, sequence, isActive, isLink, menuUrl } = req.body;

    const menuGroup = await MenuGroupMaster.findByIdAndUpdate(
      menuGroupId,
      {
        menuGroupName,
        sequence,
        isActive,
        isLink: isLink || false,
        menuUrl: isLink ? menuUrl : "#",
        icon: req.body.icon || "",
      },
      { new: true },
    );

    res.status(200).json({
      isOk: true,
      message: "Menu Group updated successfully",
      data: menuGroup,
    });
  } catch (error) {
    console.log("Error updating menu group:", error);
    res.status(500).json({
      isOk: false,
      message: "Error updating menu group",
      error: error.message,
    });
  }
};

export const deleteMenuGroup = async (req, res) => {
  try {
    const { menuGroupId } = req.params;

    const menuGroup = await MenuGroupMaster.findByIdAndUpdate(
      menuGroupId,
      { isActive: false },
      { new: true },
    );

    res.status(200).json({
      isOk: true,
      message: "Menu Group deleted successfully",
      data: menuGroup,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error deleting menu group",
      error: error.message,
    });
  }
};

export const listMenuGroupByParams = async (req, res) => {
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

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const allowedFields = ["menuGroupName", "sequence", "isActive", "createdAt", "updatedAt"];
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
                    menuGroupName: {
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

    const list = await MenuGroupMaster.aggregate(pipeline);

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
