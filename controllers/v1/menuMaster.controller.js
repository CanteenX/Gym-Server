import MenuMaster from "../../models/MenuMaster.js";
import mongoose from "mongoose";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createMenuMaster = async (req, res) => {
  try {
    const {
      menuName,
      menuGroup,
      menuUrl,
      sequence,
      isActive,
      isParent,
      parentMenu,
    } = req.body;
    

    const menuMaster = await MenuMaster.create({
      menuName,
      menuGroup,
      menuUrl,
      sequence,
      isActive,
      isParent: isParent || false,
      parentMenu: parentMenu || null,
      icon: req.body.icon || "",
    });

    res.status(201).json({
      isOk: true,
      message: "Menu master created successfully",
      data: menuMaster,
    });
  } catch (error) {
    console.log("Error in createMenuMaster:", error);
    res.status(500).json({
      isOk: false,
      message: "Error creating menu master",
      error: error.message,
    });
  }
};

export const getAllMenuMasters = async (req, res) => {
  try {
    const menuMasters = await MenuMaster.find({ isActive: true });
    res.status(200).json({
      isOk: true,
      message: "Menu masters fetched successfully",
      data: menuMasters,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching menu masters",
      error: error.message,
    });
  }
};

export const updateMenuMaster = async (req, res) => {
  try {
    const { menuMasterId } = req.params;
    const {
      menuName,
      menuGroup,
      menuUrl,
      sequence,
      isActive,
      isParent,
      parentMenu,
    } = req.body;
    

    const menuMaster = await MenuMaster.findByIdAndUpdate(
      menuMasterId,
      {
        menuName,
        menuGroup,
        menuUrl,
        sequence,
        isActive,
        isParent: isParent || false,
        parentMenu: parentMenu || null,
        icon: req.body.icon || "",
      },
      { new: true },
    );

    res.status(200).json({
      isOk: true,
      message: "Menu master updated successfully",
      data: menuMaster,
    });
  } catch (error) {
    console.log("Error in updateMenuMaster:", error);
    res.status(500).json({
      isOk: false,
      message: "Error updating menu master",
      error: error.message,
    });
  }
};

export const deleteMenuMaster = async (req, res) => {
  try {
    const { menuMasterId } = req.params;
    

    const menuMaster = await MenuMaster.findByIdAndUpdate(menuMasterId, {
      isActive: false,
    });

    res.status(200).json({
      isOk: true,
      message: "Menu master deleted successfully",
      data: menuMaster,
    });
  } catch (error) {
    console.log("Error in deleteMenuMaster:", error);
    res.status(500).json({
      isOk: false,
      message: "Error deleting menu master",
      error: error.message,
    });
  }
};

export const getMenuMasterById = async (req, res) => {
  try {
    const { menuMasterId } = req.params;
    const menuMaster =
      await MenuMaster.findById(menuMasterId).populate("menuGroup");
    res.status(200).json({
      isOk: true,
      message: "Menu master fetched successfully",
      data: menuMaster,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching menu master",
      error: error.message,
    });
  }
};

export const listMenuMasterByParams = async (req, res) => {
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
    const escapedMatch = escapeRegex(safeMatch);

    const allowedFields = ["menuName", "menuGroup", "menuUrl", "sequence", "isActive", "createdAt", "updatedAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const pipeline = [
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    menuName: {
                      $regex: escapedMatch,
                      $options: "i",
                    },
                  },
                  {
                    menuGroup: {
                      $regex: escapedMatch,
                      $options: "i",
                    },
                  },
                  {
                    menuUrl: {
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
          from: "menugroupmasters",
          localField: "menuGroup",
          foreignField: "_id",
          as: "menuGroup",
        },
      },
      {
        $unwind: {
          path: "$menuGroup",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          menuName: 1,
          menuGroup: "$menuGroup.menuGroupName",
          menuUrl: 1,
          sequence: 1,
          isActive: 1,
          icon: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { $sort: { [safeSortField]: sortOrder } },
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

    const list = await MenuMaster.aggregate(pipeline);

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

export const getMenuByGroups = async (req, res) => {
  try {
    // Get all active menu groups ordered by sequence
    const menuGroups = await mongoose
      .model("MenuGroupMaster")
      .find({ isActive: true })
      .sort({ sequence: 1 });

    // Create a result object
    const result = [];

    // Helper function to recursively build menu tree
    const buildMenuTree = async (parentId = null) => {
      const menus = await MenuMaster.find({
        parentMenu: parentId,
        isActive: true,
      }).sort({ sequence: 1 });

      const menuItems = [];

      for (const menu of menus) {
        // Check if this menu has children
        const hasChildren = await MenuMaster.exists({
          parentMenu: menu._id,
          isActive: true,
        });

        const menuItem = {
          id: menu._id,
          name: menu.menuName,
          url: menu.menuUrl || "#",
          sequence: menu.sequence,
          isParent: !!hasChildren,
          icon: menu.icon,
        };

        // If this menu has children, recursively get them
        if (hasChildren) {
          menuItem.children = await buildMenuTree(menu._id);
        }

        menuItems.push(menuItem);
      }

      return menuItems;
    };

    // For each menu group, get its menus
    for (const group of menuGroups) {
      // If this is a direct link menu group, add it differently
      if (group.isLink) {
        result.push({
          groupId: group._id,
          groupName: group.menuGroupName,
          sequence: group.sequence,
          isLink: true,
          url: group.menuUrl,
          icon: group.icon,
          menus: [], // Empty menus for direct link groups
        });
        continue; // Skip the rest of the loop for this group
      }

      // Find all top-level menus for this group (no parent)
      const topLevelMenus = await MenuMaster.find({
        menuGroup: group._id,
        isActive: true,
        $or: [{ parentMenu: null }, { parentMenu: { $exists: false } }],
      }).sort({ sequence: 1 });

      // Process each top-level menu
      const processedMenus = [];

      for (const menu of topLevelMenus) {
        // Check if this menu has children
        const hasChildren = await MenuMaster.exists({
          parentMenu: menu._id,
          isActive: true,
        });

        const menuItem = {
          id: menu._id,
          name: menu.menuName,
          url: menu.menuUrl,
          sequence: menu.sequence,
          isParent: !!hasChildren,
          icon: menu.icon,
        };

        // If this menu has children, recursively get them
        if (hasChildren) {
          menuItem.children = await buildMenuTree(menu._id);
        }

        processedMenus.push(menuItem);
      }

      if (processedMenus.length > 0 || !group.isLink) {
        result.push({
          groupId: group._id,
          groupName: group.menuGroupName,
          sequence: group.sequence,
          isLink: false,
          icon: group.icon,
          menus: processedMenus,
        });
      }
    }
    res.status(200).json({
      isOk: true,
      message: "Menus by groups fetched successfully",
      data: result,
    });
  } catch (error) {
    console.log("Error in getMenuByGroups:", error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching menus by groups",
      error: error.message,
    });
  }
};

// Test endpoint to check if the API is working
export const getMenuTest = async (req, res) => {
  try {
    // Return a simple test menu structure
    const testData = [
      {
        groupId: "1",
        groupName: "Test Group 1",
        sequence: 1,
        menus: [
          {
            id: "1",
            name: "Test Menu 1",
            url: "/test1",
            sequence: 1,
          },
          {
            id: "2",
            name: "Test Menu 2",
            url: "/test2",
            sequence: 2,
          },
        ],
      },
    ];

    res.status(200).json({
      isOk: true,
      message: "Test menus fetched successfully",
      data: testData,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      isOk: false,
      message: "Error fetching test menus",
      error: error.message,
    });
  }
};
