import DepartmentModels from "../../models/Department.js";
import mongoose from "mongoose";
import {
  getReferencingCounts,
  formatReferenceMessage,
} from "../../utils/referenceHelper.js";
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Helper: Build sort stage for aggregation pipeline
const buildSortStage = (sorton, sortdir) => {
  const allowedSortFields = [
    "departmentName",
    "departmentCode",
    "isActive",
    "createdAt",
    "updatedAt",
  ];

  const safeSortField = allowedSortFields.includes(sorton)
    ? sorton
    : "createdAt";
  const sortOrder = sortdir === "desc" ? -1 : 1;

  return { $sort: { [safeSortField]: sortOrder } };
};

export const createDepartment = async (req, res) => {
  try {
    const { departmentName, departmentCode, isActive } = req.body;

    if (!departmentName && !departmentCode) {
      return res.status(400).json({
        message: "Department name and code are required",
        isOk: false,
        status: 400,
      });
    }

    const safeDepartmentCode =
      typeof departmentCode === "string" ? departmentCode.trim() : "";

    const existingDepartment = await DepartmentModels.findOne({
      departmentCode: safeDepartmentCode,
    });

    if (existingDepartment) {
      return res.status(400).json({
        message: "Department already exists",
        isOk: true,
        status: 400,
      });
    }

    const department = new DepartmentModels({
      departmentName,
      departmentCode,
      isActive,
      createdBy: req.user.role === "EMPLOYEE" ? req.user.id : null,
    });

    await department.save();

    return res.status(201).json({
      message: "Department created successfully",
      isOk: true,
      status: 201,
    });
  } catch (error) {
    console.log("Error in createDepartmentName", error);
    return res.status(500).json({
      message: "Internal server error",
      isOk: false,
      status: 500,
    });
  }
};

export const updateDepartment = async (req, res) => {
  try {
    const { departmentName, departmentCode, isActive } = req.body;
    const { departmentId } = req.params;

    const department = await DepartmentModels.findById(departmentId);

    if (!department) {
      return res.status(400).json({
        message: "Department not found",
        isOk: true,
        status: 400,
      });
    }

    department.departmentName = departmentName;
    department.departmentCode = departmentCode;
    department.isActive = isActive;

    await department.save();

    return res.status(200).json({
      message: "Department updated successfully",
      isOk: true,
      status: 200,
    });
  } catch (error) {
    console.log("Error in updateDepartment", error);
    return res.status(500).json({
      message: "Internal server error",
      isOk: false,
      status: 500,
    });
  }
};

export const deleteDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;

    const department = await DepartmentModels.findById(departmentId);

    if (!department) {
      return res.status(400).json({
        message: "Department not found",
        isOk: false,
        status: 400,
      });
    }

    // Check if this department is referenced by other documents
    const referenceInfo = await getReferencingCounts(
      "Department",
      departmentId,
    );

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete department. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    // No references found, safe to delete
    await DepartmentModels.findByIdAndDelete(departmentId);

    return res.status(200).json({
      message: "Department deleted successfully",
      isOk: true,
      status: 200,
    });
  } catch (error) {
    console.log("Error in deleteDepartment", error);
    return res.status(500).json({
      message: "Internal server error",
      isOk: false,
      status: 500,
      error: error.message,
    });
  }
};

export const getDeparmentById = async (req, res) => {
  try {
    const { departmentId } = req.params;

    const department = await DepartmentModels.findById(departmentId);

    if (!department) {
      return res.status(400).json({
        message: "Department not found",
        isOk: true,
        status: 400,
      });
    }

    return res.status(200).json({
      message: "Department found",
      data: department,
      isOk: true,
      status: 200,
    });
  } catch (error) {
    console.log("Error in getDeparmentById", error);
    return res.status(500).json({
      message: "Internal server error",
      isOk: false,
      status: 500,
    });
  }
};

export const listDepartmentByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    // Build the initial match condition
    let matchCondition = {};
    
    // Extract nested ternary: normalize isActive to boolean or undefined
    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    if (typeof safeIsActive === "boolean") {
      matchCondition.isActive = safeIsActive;
    }
    /**
     * NO createdBy FILTER — see listDepartments below for the full reasoning.
     * Short version: `role` is which table you logged in from, so every staff
     * login is "EMPLOYEE", and the super admin created these rows, so this
     * returned an empty list to every branch admin.
     */
    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;

    const safePerPage = Number.isInteger(Number(per_page))
      ? Number(per_page)
      : 100;

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const sortStage = sorton && sortdir 
      ? buildSortStage(sorton, sortdir)
      : { $sort: { createdAt: -1 } };

    const pipeline = [
      sortStage,
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    departmentName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    departmentCode: {
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

    const list = await DepartmentModels.aggregate(pipeline);

    return res.status(200).json({
      isOk: true,
      data: list,
      status: 200,
    });
  } catch (error) {
    console.error("Error in listBranchByParams:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listDepartments = async (req, res) => {
  try {
    /**
     * ========================================================================
     * WHY THERE IS NO createdBy FILTER HERE.
     * ========================================================================
     * This used to read:
     *
     *     if (req.user.role === "EMPLOYEE") {
     *       filter.createdBy = new mongoose.Types.ObjectId(req.user.id);
     *     }
     *
     * inherited from the SaaS template this codebase started from. `role` is
     * which TABLE you logged in from, not a privilege level — so every staff
     * login is "EMPLOYEE", branch admin and front desk alike, and only the
     * super admin (a CompanyMaster row) escaped it. The super admin created
     * both departments, so every branch admin got back an empty list.
     * Measured live: 2 rows in the database, 0 returned to the Vasna admin.
     *
     * An empty list is the worst way for this to fail — it reads as "no
     * departments yet" rather than "you were filtered out", so nothing
     * errored anywhere. Gym-Admin's Employee form fills its Department
     * dropdown from here and then refuses to submit without a selection, so
     * the symptom was a branch admin unable to save any employee, with
     * nothing on screen naming the cause.
     *
     * A department is a two-row global master with no branch and no tenant
     * dimension; there is nothing for it to be scoped by. listBranches, the
     * closest comparable master, has no such filter either. This is not a
     * licence to drop scoping generally — where a collection genuinely
     * belongs to a branch, use middlewares/branchScope.js. "Whoever typed it
     * in" was simply never the right axis for a shared lookup.
     *
     * The identical filter was removed from employee.controller.js for the
     * same reason; four sibling controllers still carry it (email*, roles),
     * so do not copy it back from one of those.
     */
    const filter = { isActive: true };
    const departments = await DepartmentModels.find(filter);

    return res.status(200).json({
      isOk: true,
      data: departments,
      status: 200,
    });
  } catch (error) {
    console.error("Error in listBranch:", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};
