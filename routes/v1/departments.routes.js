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

/**
 * READS ARE LOOKUPS AND ARE NOT GATED ON THE MENU. WRITES STILL ARE.
 *
 * models/MenuMaster.js has one switch, `isActive`, and it means two unrelated
 * things: "show this in the sidebar", and "this menu backs an API" —
 * hasMenuPermission() resolves `{ menuUrl, isActive: true }`, so an inactive
 * row returns menuFound false and 403s everyone but the super admin, who
 * bypasses the check and therefore cannot see that anything broke.
 *
 * The `/department` row IS inactive. Someone hid the Department screen, which
 * is reasonable — this is a gym, not an HR system. But these reads are not
 * really the Department screen's: Gym-Admin's Employee form calls the list to
 * fill its Department dropdown. Gated, that chain ran
 *
 *     branch admin opens Employee form -> GET /departments -> 403 ->
 *     empty dropdown -> "Department is required" -> cannot save ANY employee.
 *
 * A lookup read must not depend on the sidebar state of a screen that merely
 * happens to own the same data, so the three reads sit behind authMiddleware
 * alone — staff-only, not public. This is the same reasoning CLAUDE.md records
 * for why checkPermission is deliberately absent from the gym routes.
 *
 * Creating, editing and deleting a department genuinely IS that screen's
 * business, so those three keep their permission checks. Opening the reads
 * must not open the writes; scripts/tests/menuDeactivationGuard.test.mjs pins
 * both halves.
 */

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
  listDepartmentByParams,
);

export default router;
