import express from "express";
const router = express.Router();
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createRole,
  listAllRoles,
  updateRole,
  deleteRole,
  getRoleById,
  listRoleByParams,
  listAdminCreatedRoles,   // ← add
  listEmployeeCreatedRoles,
} from "../../controllers/v1/roleMaster.controller.js";

/**
 * @swagger
 * /roles:
 *   post:
 *     summary: Create a new role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateRole'
 *     responses:
 *       200:
 *         description: Role created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/roles", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/role-master", "write"), createRole);

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: List all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isOk:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Role'
 */
router.get("/roles", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/role-master", "read"), listAllRoles);
/**
 * @swagger
 * /roles/admin-created:
 *   get:
 *     summary: List all roles created by admin (createdBy = null)
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of admin created roles
 */
router.get(
  "/roles/admin-created",
  authMiddleware(["ADMIN"]),
  listAdminCreatedRoles,
);

/**
 * @swagger
 * /roles/employee-created:
 *   get:
 *     summary: List all roles created by employees grouped by employee
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of employee created roles grouped by employee
 */
router.get(
  "/roles/employee-created",
  authMiddleware(["ADMIN"]),
  listEmployeeCreatedRoles,
);

/**
 * @swagger
 * /roles/{roleId}:
 *   get:
 *     summary: Get role by ID
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     responses:
 *       200:
 *         description: Role details
 *       404:
 *         description: Role not found
 */
router.get(
  "/roles/:roleId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/role-master", "read"),
  getRoleById,
);

/**
 * @swagger
 * /roles/{roleId}:
 *   put:
 *     summary: Update role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateRole'
 *     responses:
 *       200:
 *         description: Role updated successfully
 *       404:
 *         description: Role not found
 */
router.put("/roles/:roleId", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/role-master", "edit"), updateRole);

/**
 * @swagger
 * /roles/{roleId}:
 *   delete:
 *     summary: Delete role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema:
 *           type: string
 *         description: Role ID
 *     responses:
 *       200:
 *         description: Role deleted successfully
 *       404:
 *         description: Role not found
 */
router.delete(
  "/roles/:roleId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/role-master", "delete"),
  deleteRole,
);

/**
 * @swagger
 * /roles/search:
 *   post:
 *     summary: Search roles with pagination
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SearchParams'
 *     responses:
 *       200:
 *         description: Paginated list of roles
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/roles/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/role-master", "read"),
  listRoleByParams,
);

export default router;
