import RoleMaster from "../../models/RoleMaster.js";
import mongoose from "mongoose";
import {
  getReferencingCounts,
  formatReferenceMessage,
} from "../../utils/referenceHelper.js";
import { listAssignableRoles } from "../../middlewares/roleCeiling.js";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const createRole = async (req, res) => {
  try {
    const { roleName, isActive } = req.body;

    if (!roleName) {
      return res
        .status(400)
        .json({ isOk: false, message: "Role name is required" });
    }

    const newRole = new RoleMaster({
      roleName,
      isActive: isActive === undefined ? true : isActive,
      createdBy: req.user.role === "EMPLOYEE" ? req.user.id : null,
    });

    await newRole.save();
    res.status(201).json({ isOk: true, data: newRole });
  } catch (error) {
    // roleName is uniquely indexed. A duplicate is a normal thing for a user to
    // do — they cannot see roles they did not create (see listAllRoles), so the
    // name they are typing may already exist invisibly. Surfacing the raw Mongo
    // error as a 500 told them the server was broken; it is a 400 with a
    // sentence naming the clash.
    if (error?.code === 11000) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `A role named "${req.body.roleName}" already exists.`,
      });
    }
    console.error("Error creating role:", error);
    res.status(500).json({ isOk: false, message: "Internal server error" });
  }
};

export const listAllRoles = async (req, res) => {
  try {
    let query = { isActive: true };

    /**
     * An ordinary employee sees only the roles they created themselves.
     *
     * A SUPER ADMIN must see every role, including the system ones seeded with
     * `createdBy: null` — otherwise "Branch Admin" is invisible in the Role
     * dropdown and they cannot assign it, while a uniquely-indexed re-creation
     * of the same name fails. Super-admin status is read from the session,
     * never from the request (see middlewares/branchScope.js).
     */
    if (req.user.role === "EMPLOYEE" && !req.session?.user?.isSuperAdmin) {
      const safeUserId = typeof req.user.id === "string" ? req.user.id.trim() : "";
      const isValidUser = typeof safeUserId === "string" && /^[0-9a-fA-F]{24}$/.test(safeUserId);
      if (isValidUser) {
        query.createdBy = safeUserId;
      }
    }

    const roles = await RoleMaster.find(query);

    return res.status(200).json({
      isOk: true,
      data: roles,
    });
  } catch (error) {
    console.error("Error in listAllRoles:", error);
    return res.status(500).json({
      isOk: false,
      message: "Internal server error",
    });
  }
};

export const updateRole = async (req, res) => {
  try {
    const { roleId } = req.params;
    const { roleName, isActive } = req.body;

    if (!roleName) {
      return res
        .status(400)
        .json({ isOk: false, message: "Role name is required" });
    }

    const updatedRole = await RoleMaster.findByIdAndUpdate(
      roleId,
      { roleName, isActive },
      { new: true },
    );

    if (!updatedRole) {
      return res.status(404).json({ isOk: false, message: "Role not found" });
    }

    res.status(200).json({ isOk: true, data: updatedRole });
  } catch (error) {
    console.error("Error updating role:", error);
    res.status(500).json({ isOk: false, message: "Internal server error" });
  }
};

export const deleteRole = async (req, res) => {
  try {
    const { roleId } = req.params;

    const role = await RoleMaster.findById(roleId);
    if (!role) {
      return res.status(404).json({
        isOk: false,
        message: "Role not found",
        status: 404,
      });
    }

    const referenceInfo = await getReferencingCounts("RoleMaster", roleId);

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete role. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    await RoleMaster.findByIdAndDelete(roleId);

    res.status(200).json({
      isOk: true,
      message: "Role deleted successfully",
      status: 200,
    });
  } catch (error) {
    console.error("Error deleting role:", error);
    res.status(500).json({
      isOk: false,
      message: "Internal server error",
      status: 500,
      error: error.message,
    });
  }
};

export const getRoleById = async (req, res) => {
  try {
    const { roleId } = req.params;

    const role = await RoleMaster.findById(roleId);
    if (!role) {
      return res.status(404).json({ isOk: false, message: "Role not found" });
    }

    res.status(200).json({ isOk: true, data: role });
  } catch (error) {
    console.error("Error fetching role by ID:", error);
    res.status(500).json({ isOk: false, message: "Internal server error" });
  }
};

export const listRoleByParams = async (req, res) => {
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

    // Employee filtering
    if (req.user.role === "EMPLOYEE") {
      matchCondition.createdBy = new mongoose.Types.ObjectId(req.user.id);
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const allowedFields = ["roleName", "isActive", "createdAt", "updatedAt"];
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
                    roleName: {
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

    const list = await RoleMaster.aggregate(pipeline);

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
export const listAdminCreatedRoles = async (req, res) => {
  try {
    const roles = await RoleMaster.findAdminCreatedRoles();

    return res.status(200).json({
      isOk: true,
      data: roles,
    });
  } catch (error) {
    console.error("Error in listAdminCreatedRoles:", error);
    return res.status(500).json({
      isOk: false,
      message: "Internal server error",
    });
  }
};

export const listEmployeeCreatedRoles = async (req, res) => {
  try {
    const roles = await RoleMaster.findEmployeeCreatedRoles();

    // Group by employee
    const grouped = {};
    for (const role of roles) {
      const employeeId = role.createdBy?._id?.toString();
      const employeeName = role.createdBy?.employeeName || "Unknown";

      if (!grouped[employeeId]) {
        grouped[employeeId] = {
          employeeId,
          employeeName,
          roles: [],
        };
      }

      grouped[employeeId].roles.push({
        value: role._id,
        label: role.roleName,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: Object.values(grouped),
    });
  } catch (error) {
    console.error("Error in listEmployeeCreatedRoles:", error);
    return res.status(500).json({
      isOk: false,
      message: "Internal server error",
    });
  }
};
/**
 * The roles this caller may put on a member of staff.
 *
 * This is what the admin panel's Role dropdown reads, and it exists because
 * the roles SCREEN is reserved to the super admin while creating staff is not.
 * A branch admin legitimately holds `write` on /employee, so they were being
 * asked to pick a role from a list they were 403'd out of — the dropdown came
 * back empty and the form refused to save, which is the bug the owner hit.
 *
 * It is not the roles screen with a softer gate. It returns ids and names only,
 * for roles the caller could already assign anyway, so it discloses nothing
 * they could not establish by trying one. The alternative — showing every role
 * and refusing on save — is the same dead end wearing a different hat.
 *
 * The bound itself is middlewares/roleCeiling.js, shared with the role-editing
 * guard so the two cannot drift.
 */
export const listAssignableRolesHandler = async (req, res) => {
  try {
    const roles = await listAssignableRoles(req);
    return res.status(200).json({ isOk: true, status: 200, data: roles });
  } catch (error) {
    console.error("Error in listAssignableRoles", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message,
    });
  }
};
