import express from "express";
const router = express.Router();
import {
  createCurrencyMaster,
  getCurrencyMasterById,
  updateCurrencyMaster,
  deleteCurrencyMaster,
  listCurrencyMastersByParams,
  getAllActiveCurrencyMasters,
} from "../../controllers/v1/currency.controller.js";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";

/**
 * @swagger
 * /currencies:
 *   post:
 *     summary: Create a new currency
 *     tags: [Currencies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCurrency'
 *     responses:
 *       200:
 *         description: Currency created successfully
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/currencies",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "write"),
  createCurrencyMaster,
);

/**
 * @swagger
 * /currencies:
 *   get:
 *     summary: List all active currencies
 *     tags: [Currencies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of currencies
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
 *                     $ref: '#/components/schemas/Currency'
 */
router.get(
  "/currencies",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "read"),
  getAllActiveCurrencyMasters,
);

/**
 * @swagger
 * /currencies/{id}:
 *   get:
 *     summary: Get currency by ID
 *     tags: [Currencies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency ID
 *     responses:
 *       200:
 *         description: Currency details
 *       404:
 *         description: Currency not found
 */
router.get(
  "/currencies/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "read"),
  getCurrencyMasterById,
);

/**
 * @swagger
 * /currencies/{id}:
 *   put:
 *     summary: Update currency
 *     tags: [Currencies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCurrency'
 *     responses:
 *       200:
 *         description: Currency updated successfully
 *       404:
 *         description: Currency not found
 */
router.put(
  "/currencies/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "edit"),
  updateCurrencyMaster,
);

/**
 * @swagger
 * /currencies/{id}:
 *   delete:
 *     summary: Delete currency
 *     tags: [Currencies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency ID
 *     responses:
 *       200:
 *         description: Currency deleted successfully
 *       404:
 *         description: Currency not found
 */
router.delete(
  "/currencies/:id",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "delete"),
  deleteCurrencyMaster,
);

/**
 * @swagger
 * /currencies/search:
 *   post:
 *     summary: Search currencies with pagination
 *     tags: [Currencies]
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
 *         description: Paginated list of currencies
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/currencies/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/currency-master", "read"),
  listCurrencyMastersByParams,
);

export default router;
