import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createEmployeeRoles,
  getEmployeeRoles,
  updateEmployeeRoles,
} from "../../controllers/v1/employeeRoles.controller.js";

const router = express.Router();

/**
 * @swagger
 * /employee-roles:
 *   post:
 *     summary: Create employee role permissions
 *     tags: [Employee Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmployeeRoles'
 *     responses:
 *       200:
 *         description: Employee roles created successfully
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/employee-roles",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee-roles", "write"),
  createEmployeeRoles,
);

/**
 * @swagger
 * /employee-roles/{roleId}:
 *   get:
 *     summary: Get employee role permissions by role ID
 *     tags: [Employee Roles]
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
 *         description: Employee role permissions
 *       404:
 *         description: Employee roles not found
 */
router.get(
  "/employee-roles/:roleId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee-roles", "read"),
  getEmployeeRoles,
);

/**
 * @swagger
 * /employee-roles/{roleId}:
 *   put:
 *     summary: Update employee role permissions
 *     tags: [Employee Roles]
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
 *             $ref: '#/components/schemas/EmployeeRoles'
 *     responses:
 *       200:
 *         description: Employee roles updated successfully
 *       404:
 *         description: Employee roles not found
 */
router.put(
  "/employee-roles/:roleId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee-roles", "edit"),
  updateEmployeeRoles,
);

export default router;
