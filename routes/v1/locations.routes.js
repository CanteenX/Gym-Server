import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createCountry,
  listAllCountries,
  deleteCountry,
  updateCountry,
  createState,
  listAllStates,
  deleteState,
  updateState,
  listStateByCountry,
  listStateByParams,
  createCity,
  listAllCities,
  deleteCity,
  updateCity,
  listCityByState,
  listCityByParams,
  listCountryStateCity,
  getCountryById,
  listCountryByParams,
  getStateById,
  getCityById,
} from "../../controllers/v1/location.controller.js";

const router = express.Router();

// ============ COUNTRY ENDPOINTS ============

/**
 * @swagger
 * /countries:
 *   post:
 *     summary: Create a new country
 *     tags: [Countries]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCountry'
 *     responses:
 *       200:
 *         description: Country created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Unauthorized
 */
router.post("/countries", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/country", "write"), createCountry);

/**
 * @swagger
 * /countries:
 *   get:
 *     summary: List all countries
 *     tags: [Countries]
 *     responses:
 *       200:
 *         description: List of countries
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
 *                     $ref: '#/components/schemas/Country'
 */
router.get("/countries", listAllCountries);

/**
 * @swagger
 * /countries/{countryId}:
 *   get:
 *     summary: Get country by ID
 *     tags: [Countries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: countryId
 *         required: true
 *         schema:
 *           type: string
 *         description: Country ID
 *     responses:
 *       200:
 *         description: Country details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Country not found
 */
router.get(
  "/countries/:countryId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/country", "read"),
  getCountryById,
);

/**
 * @swagger
 * /countries/{countryId}:
 *   put:
 *     summary: Update country
 *     tags: [Countries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: countryId
 *         required: true
 *         schema:
 *           type: string
 *         description: Country ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCountry'
 *     responses:
 *       200:
 *         description: Country updated successfully
 *       404:
 *         description: Country not found
 */
router.put(
  "/countries/:countryId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/country", "edit"),
  updateCountry,
);

/**
 * @swagger
 * /countries/{countryId}:
 *   delete:
 *     summary: Delete country
 *     tags: [Countries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: countryId
 *         required: true
 *         schema:
 *           type: string
 *         description: Country ID
 *     responses:
 *       200:
 *         description: Country deleted successfully
 *       404:
 *         description: Country not found
 */
router.delete(
  "/countries/:countryId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
   checkPermission("/country", "delete"),
  deleteCountry,
);

/**
 * @swagger
 * /countries/search:
 *   post:
 *     summary: Search countries with pagination
 *     tags: [Countries]
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
 *         description: Paginated list of countries
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/countries/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/country", "read"),
  listCountryByParams,
);

/**
 * @swagger
 * /countries/{countryId}/states:
 *   get:
 *     summary: List states by country
 *     tags: [States]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: countryId
 *         required: true
 *         schema:
 *           type: string
 *         description: Country ID
 *     responses:
 *       200:
 *         description: List of states in the country
 */
router.get(
  "/countries/:countryId/states",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/country", "read"),
  listStateByCountry,
);

// ============ STATE ENDPOINTS ============

/**
 * @swagger
 * /states:
 *   post:
 *     summary: Create a new state
 *     tags: [States]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateState'
 *     responses:
 *       200:
 *         description: State created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/states", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/state", "write"), createState);

/**
 * @swagger
 * /states:
 *   get:
 *     summary: List all states
 *     tags: [States]
 *     responses:
 *       200:
 *         description: List of states
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
 *                     $ref: '#/components/schemas/State'
 */
router.get("/states", listAllStates);

/**
 * @swagger
 * /states/{stateId}:
 *   get:
 *     summary: Get state by ID
 *     tags: [States]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stateId
 *         required: true
 *         schema:
 *           type: string
 *         description: State ID
 *     responses:
 *       200:
 *         description: State details
 *       404:
 *         description: State not found
 */
router.get(
  "/states/:stateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/state", "read"),
  getStateById,
);

/**
 * @swagger
 * /states/{stateId}:
 *   put:
 *     summary: Update state
 *     tags: [States]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stateId
 *         required: true
 *         schema:
 *           type: string
 *         description: State ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateState'
 *     responses:
 *       200:
 *         description: State updated successfully
 *       404:
 *         description: State not found
 */
router.put(
  "/states/:stateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/state", "edit"),
  updateState,
);

/**
 * @swagger
 * /states/{stateId}:
 *   delete:
 *     summary: Delete state
 *     tags: [States]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stateId
 *         required: true
 *         schema:
 *           type: string
 *         description: State ID
 *     responses:
 *       200:
 *         description: State deleted successfully
 *       404:
 *         description: State not found
 */
router.delete(
  "/states/:stateId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
   checkPermission("/state", "delete"),
  deleteState,
);

/**
 * @swagger
 * /states/search:
 *   post:
 *     summary: Search states with pagination
 *     tags: [States]
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
 *         description: Paginated list of states
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/states/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/state", "read"),
  listStateByParams,
);

/**
 * @swagger
 * /states/{stateId}/cities:
 *   get:
 *     summary: List cities by state
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stateId
 *         required: true
 *         schema:
 *           type: string
 *         description: State ID
 *     responses:
 *       200:
 *         description: List of cities in the state
 */
router.get(
  "/states/:stateId/cities",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/state", "read"),
  listCityByState,
);

// ============ CITY ENDPOINTS ============

/**
 * @swagger
 * /cities:
 *   post:
 *     summary: Create a new city
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCity'
 *     responses:
 *       200:
 *         description: City created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/cities", authMiddleware(["ADMIN", "EMPLOYEE"]),checkPermission("/city", "write"), createCity);

/**
 * @swagger
 * /cities:
 *   get:
 *     summary: List all cities
 *     tags: [Cities]
 *     responses:
 *       200:
 *         description: List of cities
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
 *                     $ref: '#/components/schemas/City'
 */
router.get("/cities", listAllCities);

/**
 * @swagger
 * /cities/{cityId}:
 *   get:
 *     summary: Get city by ID
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: cityId
 *         required: true
 *         schema:
 *           type: string
 *         description: City ID
 *     responses:
 *       200:
 *         description: City details
 *       404:
 *         description: City not found
 */
router.get(
  "/cities/:cityId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/city", "read"),
  getCityById,
);

/**
 * @swagger
 * /cities/{cityId}:
 *   put:
 *     summary: Update city
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: cityId
 *         required: true
 *         schema:
 *           type: string
 *         description: City ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCity'
 *     responses:
 *       200:
 *         description: City updated successfully
 *       404:
 *         description: City not found
 */
router.put(
  "/cities/:cityId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/city", "edit"),
  updateCity,
);

/**
 * @swagger
 * /cities/{cityId}:
 *   delete:
 *     summary: Delete city
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: cityId
 *         required: true
 *         schema:
 *           type: string
 *         description: City ID
 *     responses:
 *       200:
 *         description: City deleted successfully
 *       404:
 *         description: City not found
 */
router.delete(
  "/cities/:cityId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/city", "delete"),
  deleteCity,
);

/**
 * @swagger
 * /cities/search:
 *   post:
 *     summary: Search cities with pagination
 *     tags: [Cities]
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
 *         description: Paginated list of cities
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 */
router.post(
  "/cities/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/city", "read"),
  listCityByParams,
);

/**
 * @swagger
 * /locations:
 *   get:
 *     summary: List all locations (country/state/city combined)
 *     tags: [Countries, States, Cities]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Combined location data
 */
router.get(
  "/locations",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/country", "read"),
  listCountryStateCity,
);

export default router;
