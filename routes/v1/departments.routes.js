import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getDeparmentById,
  listDepartments,
  listDepartmentByParams,
} from "../../controllers/v1/department.controller.js";

const router = express.Router();

/**
 * @swagger
 * /departments:
 *   post:
 *     summary: Create a new department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDepartment'
 *     responses:
 *       200:
 *         description: Department created successfully
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/departments",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
   checkPermission("/department", "write"),
  createDepartment,
);

/**
 * @swagger
 * /departments:
 *   get:
 *     summary: List all departments
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of departments
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
 *                     $ref: '#/components/schemas/Department'
 */
router.get(
  "/departments",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/department", "read"),
  listDepartments,
);

/**
 * @swagger
 * /departments/{departmentId}:
 *   get:
 *     summary: Get department by ID
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: departmentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Department ID
 *     responses:
 *       200:
 *         description: Department details
 *       404:
 *         description: Department not found
 */
router.get(
  "/departments/:departmentId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/department", "read"),
  getDeparmentById,
);

/**
 * @swagger
 * /departments/{departmentId}:
 *   put:
 *     summary: Update department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: departmentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Department ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDepartment'
 *     responses:
 *       200:
 *         description: Department updated successfully
 *       404:
 *         description: Department not found
 */
router.put(
  "/departments/:departmentId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
   checkPermission("/department", "edit"),
  updateDepartment,
);

/**
 * @swagger
 * /departments/{departmentId}:
 *   delete:
 *     summary: Delete department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: departmentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Department ID
 *     responses:
 *       200:
 *         description: Department deleted successfully
 *       404:
 *         description: Department not found
 */
router.delete(
  "/departments/:departmentId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/department", "delete"),
  deleteDepartment,
);

/**
 * @swagger
 * /departments/search:
 *   post:
 *     summary: Search departments with pagination
 *     tags: [Departments]
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
 *         description: Paginated list of departments
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/departments/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/department", "read"),
  listDepartmentByParams,
);

export default router;
