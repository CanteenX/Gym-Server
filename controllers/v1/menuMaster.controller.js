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
    // Previously this issued a query PER NODE: one find per group, an exists()
    // per menu to test for children, and a recursive find per level. With the
    // real menu tree that is 50-100 sequential round trips to Atlas, and it
    // measured a consistent 9.3 seconds - the single slowest endpoint in the
    // admin panel, and what left the sidebar on "Loading menus..." for ~10s
    // after every login.
    //
    // Two queries now fetch everything and the tree is assembled in memory.
    const [menuGroups, allMenus] = await Promise.all([
      mongoose
        .model("MenuGroupMaster")
        .find({ isActive: true })
        // _id breaks ties: several menus share a sequence, and without a
        // tiebreaker Mongo returns them in an arbitrary order, so the
        // sidebar silently reordered itself between requests. _id sorts by
        // creation, which is stable.
        .sort({ sequence: 1, _id: 1 })
        .lean(),
      MenuMaster.find({ isActive: true }).sort({ sequence: 1, _id: 1 }).lean(),
    ]);

    // Index children by parent id. Both source queries are already sorted by
    // sequence, so every bucket keeps that order without re-sorting.
    const childrenByParent = new Map();
    for (const menu of allMenus) {
      if (!menu.parentMenu) continue;
      const key = String(menu.parentMenu);
      const bucket = childrenByParent.get(key);
      if (bucket) bucket.push(menu);
      else childrenByParent.set(key, [menu]);
    }

    /**
     * @param {object} menu
     * @param {boolean} nested - nested rows fall back to "#" for a missing url,
     *   top-level rows leave it undefined. Preserved from the original shape,
     *   because the sidebar distinguishes the two.
     */
    const toMenuItem = (menu, nested) => {
      const children = childrenByParent.get(String(menu._id)) || [];
      const item = {
        id: menu._id,
        name: menu.menuName,
        url: nested ? menu.menuUrl || "#" : menu.menuUrl,
        sequence: menu.sequence,
        isParent: children.length > 0,
        // .lean() skips schema defaults, and JSON.stringify drops undefined - so
        // the default has to be applied here or the key vanishes from the
        // response for every menu without an icon.
        icon: menu.icon ?? "",
      };
      if (children.length > 0) {
        item.children = children.map((child) => toMenuItem(child, true));
      }
      return item;
    };

    // Top-level menus (no parent) bucketed by their group.
    const topLevelByGroup = new Map();
    for (const menu of allMenus) {
      if (menu.parentMenu || !menu.menuGroup) continue;
      const key = String(menu.menuGroup);
      const bucket = topLevelByGroup.get(key);
      if (bucket) bucket.push(menu);
      else topLevelByGroup.set(key, [menu]);
    }

    const result = menuGroups.map((group) => {
      // A direct-link group navigates straight to its own url and carries no
      // menus of its own.
      if (group.isLink) {
        return {
          groupId: group._id,
          groupName: group.menuGroupName,
          sequence: group.sequence,
          isLink: true,
          url: group.menuUrl ?? "#",
          icon: group.icon ?? "",
          menus: [],
        };
      }

      return {
        groupId: group._id,
        groupName: group.menuGroupName,
        sequence: group.sequence,
        isLink: false,
        icon: group.icon ?? "",
        menus: (topLevelByGroup.get(String(group._id)) || []).map((menu) =>
          toMenuItem(menu, false),
        ),
      };
    });

    res.status(200).json({
      isOk: true,
      message: "Menus by groups fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error in getMenuByGroups:", error);
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
