import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createMenuGroup,
  getAllMenuGroups,
  updateMenuGroup,
  deleteMenuGroup,
  listMenuGroupByParams,
  getMenuGroupById,
} from "../../controllers/v1/menuGroup.controller.js";
import {
  createMenuMaster,
  getAllMenuMasters,
  updateMenuMaster,
  deleteMenuMaster,
  listMenuMasterByParams,
  getMenuMasterById,
  getMenuByGroups,
  getMenuTest,
} from "../../controllers/v1/menuMaster.controller.js";

const router = express.Router();

// ============ MENU GROUP ENDPOINTS ============

/**
 * @swagger
 * /menu-groups:
 *   post:
 *     summary: Create a new menu group
 *     tags: [Menu Groups]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMenuGroup'
 *     responses:
 *       200:
 *         description: Menu group created successfully
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/menu-groups",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "write"),
  createMenuGroup,
);

/**
 * @swagger
 * /menu-groups:
 *   get:
 *     summary: List all menu groups
 *     tags: [Menu Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of menu groups
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
 *                     $ref: '#/components/schemas/MenuGroup'
 */
router.get(
  "/menu-groups",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "read"),
  getAllMenuGroups,
);

/**
 * @swagger
 * /menu-groups/{menuGroupId}:
 *   get:
 *     summary: Get menu group by ID
 *     tags: [Menu Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuGroupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu Group ID
 *     responses:
 *       200:
 *         description: Menu group details
 *       404:
 *         description: Menu group not found
 */
router.get(
  "/menu-groups/:menuGroupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "read"),
  getMenuGroupById,
);

/**
 * @swagger
 * /menu-groups/{menuGroupId}:
 *   put:
 *     summary: Update menu group
 *     tags: [Menu Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuGroupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu Group ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMenuGroup'
 *     responses:
 *       200:
 *         description: Menu group updated successfully
 *       404:
 *         description: Menu group not found
 */
router.put(
  "/menu-groups/:menuGroupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "edit"),
  updateMenuGroup,
);

/**
 * @swagger
 * /menu-groups/{menuGroupId}:
 *   delete:
 *     summary: Delete menu group
 *     tags: [Menu Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuGroupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu Group ID
 *     responses:
 *       200:
 *         description: Menu group deleted successfully
 *       404:
 *         description: Menu group not found
 */
router.delete(
  "/menu-groups/:menuGroupId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "delete"),
  deleteMenuGroup,
);

/**
 * @swagger
 * /menu-groups/search:
 *   post:
 *     summary: Search menu groups with pagination
 *     tags: [Menu Groups]
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
 *         description: Paginated list of menu groups
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/menu-groups/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-group", "read"),
  listMenuGroupByParams,
);

// ============ MENU MASTER ENDPOINTS ============

/**
 * @swagger
 * /menus:
 *   post:
 *     summary: Create a new menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMenu'
 *     responses:
 *       200:
 *         description: Menu created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/menus", authMiddleware(["ADMIN", "EMPLOYEE"]), checkPermission("/menu-master", "write"), createMenuMaster);

/**
 * @swagger
 * /menus:
 *   get:
 *     summary: List all menus
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of menus
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
 *                     $ref: '#/components/schemas/Menu'
 */
router.get("/menus", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/menu-master", "read"), getAllMenuMasters);

/**
 * @swagger
 * /menus/by-groups:
 *   get:
 *     summary: Get menus grouped by menu groups
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Menus organized by groups
 */
router.get(
  "/menus/by-groups",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getMenuByGroups,
);

/**
 * @swagger
 * /menus/test:
 *   get:
 *     summary: Test endpoint
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Test response
 */
router.get("/menus/test", authMiddleware(["ADMIN", "EMPLOYEE"]), getMenuTest);

/**
 * @swagger
 * /menus/{menuMasterId}:
 *   get:
 *     summary: Get menu by ID
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuMasterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu ID
 *     responses:
 *       200:
 *         description: Menu details
 *       404:
 *         description: Menu not found
 */
router.get(
  "/menus/:menuMasterId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-master", "read"),
  getMenuMasterById,
);

/**
 * @swagger
 * /menus/{menuMasterId}:
 *   put:
 *     summary: Update menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuMasterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMenu'
 *     responses:
 *       200:
 *         description: Menu updated successfully
 *       404:
 *         description: Menu not found
 */
router.put(
  "/menus/:menuMasterId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-master", "edit"),
  updateMenuMaster,
);

/**
 * @swagger
 * /menus/{menuMasterId}:
 *   delete:
 *     summary: Delete menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: menuMasterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Menu ID
 *     responses:
 *       200:
 *         description: Menu deleted successfully
 *       404:
 *         description: Menu not found
 */
router.delete(
  "/menus/:menuMasterId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-master", "delete"),
  deleteMenuMaster,
);

/**
 * @swagger
 * /menus/search:
 *   post:
 *     summary: Search menus with pagination
 *     tags: [Menus]
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
 *         description: Paginated list of menus
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/menus/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/menu-master", "read"),
  listMenuMasterByParams,
);

export default router;
