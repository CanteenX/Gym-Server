import express from "express";
import mongoose from "mongoose";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { checkPermission } from "../../middlewares/checkPermission.js";
import {
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeById,
  listAllEmployees,
  listEmployeesByParams,
  listAllEmployeesByDepartment,
  loginEmployee,
  getCurrentUser,
  resetPassword,
  logoutUser,
  verifySession,
} from "../../controllers/v1/employee.controller.js";
import { authRateLimiter } from "../../middlewares/rateLimiter.js";
import {
  loginValidation,
  allowOnlyFields,
  allowedLoginFields,
} from "../../middlewares/inputValidator.js";
import authService from "../../services/authService.js";

const router = express.Router();

// ============ EMPLOYEE CRUD ROUTES ============

router.post(
  "/employees",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "write"),
  createEmployee,
);

router.get(
  "/employees",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "read"),
  listAllEmployees,
);

router.get(
  "/employees/:employeeId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "read"),
  getEmployeeById,
);

router.put(
  "/employees/:employeeId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "edit"),
  updateEmployee,
);

router.delete(
  "/employees/:employeeId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "delete"),
  deleteEmployee,
);

router.post(
  "/employees/search",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "read"),
  listEmployeesByParams,
);

router.get(
  "/employees/department/:departmentId",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/employee", "read"),
  listAllEmployeesByDepartment,
);

// ADMIN only — no permission check needed
router.post(
  "/employees/:employeeId/reset-password",
  authMiddleware(["ADMIN"]),
  resetPassword,
);

// ============ AUTH ROUTES — no checkPermission needed ============

router.post(
  "/auth/employee/login",
  authRateLimiter,
  allowOnlyFields(allowedLoginFields),
  loginValidation,
  loginEmployee,
);

router.get("/auth/me", authMiddleware(["ADMIN", "EMPLOYEE"]), getCurrentUser);

router.post("/auth/logout", authMiddleware(["ADMIN", "EMPLOYEE"]), logoutUser);

router.get(
  "/auth/verify-session",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  verifySession,
);

// ============ LOGIN ATTEMPT ROUTES — ADMIN only ============

router.get(
  "/auth/login-status/:userId",
  authMiddleware(["ADMIN"]),
  async (req, res) => {
    try {
      const status = await authService.getLoginAttemptStatus(req.params.userId);
      res.status(200).json({ isOk: true, data: status, status: 200 });
    } catch (error) {
      res
        .status(500)
        .json({ isOk: false, message: error.message, status: 500 });
    }
  },
);

router.post("/auth/login-status-by-email", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ isOk: false, message: "Email is required", status: 400 });
    }
    const status = await authService.getLoginAttemptStatus(null, email);
    res.status(200).json({ isOk: true, data: status, status: 200 });
  } catch (error) {
    res.status(500).json({ isOk: false, message: error.message, status: 500 });
  }
});

router.post(
  "/admin/auth/reset-attempts",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/login-attempt-logs", "edit"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res
          .status(400)
          .json({ isOk: false, message: "userId is required", status: 400 });
      }
      await authService.resetLoginAttempts(userId);
      const status = await authService.getLoginAttemptStatus(userId);
      res.status(200).json({
        isOk: true,
        message: "Login attempts reset successfully",
        data: status,
        status: 200,
      });
    } catch (error) {
      res
        .status(500)
        .json({ isOk: false, message: error.message, status: 500 });
    }
  },
);

router.post(
  "/admin/auth/unlock",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/login-attempt-logs", "edit"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res
          .status(400)
          .json({ isOk: false, message: "userId is required", status: 400 });
      }
      await authService.unlockAccount(userId);
      const status = await authService.getLoginAttemptStatus(userId);
      res.status(200).json({
        isOk: true,
        message: "Account unlocked successfully",
        data: status,
        status: 200,
      });
    } catch (error) {
      res
        .status(500)
        .json({ isOk: false, message: error.message, status: 500 });
    }
  },
);

router.post(
  "/admin/auth/login-attempts",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/login-attempt-logs", "read"),
  async (req, res) => {
    try {
      const { skip = 0, per_page = 10, match, sorton, sortdir } = req.body;
      const sessionUser = req.session.user;
      const LoginAttempt = (await import("../../models/LoginAttempt.js"))
        .default;
      const Employee = (await import("../../models/Employee.js")).default;
      const CompanyMaster = (await import("../../models/CompanyMaster.js"))
        .default;

      // ── BUILD USER ID FILTER BASED ON ROLE ──────────────────────
      let allowedUserIds = null; // null means no restriction

      if (!sessionUser.isSuperAdmin) {
        if (sessionUser.role === "EMPLOYEE") {
          const subordinates = await Employee.find({
            createdBy: sessionUser.id,
          }).select("_id");

          allowedUserIds = subordinates.map((e) => e._id);
        } else if (sessionUser.role === "ADMIN") {
          const superAdmins = await CompanyMaster.find({
            isSuperAdmin: true,
          }).select("_id");

          const superAdminIds = superAdmins.map((s) => s._id.toString());
          allowedUserIds = { excludeIds: superAdminIds };
        }
      }
      // ────────────────────────────────────────────────────────────

      let matchQuery = {};

      if (match) {
        matchQuery = {
          $or: [
            { userEmail: { $regex: match, $options: "i" } },
            { ipAddress: { $regex: match, $options: "i" } },
            { "locationCoordinates.city": { $regex: match, $options: "i" } },
            { "locationCoordinates.country": { $regex: match, $options: "i" } },
          ],
        };
      }

      // Apply userId filter to matchQuery
      if (allowedUserIds !== null) {
        if (Array.isArray(allowedUserIds)) {
          // Employee — only these userIds
          matchQuery.userId = { $in: allowedUserIds };
        } else if (allowedUserIds.excludeIds) {
          // Admin — exclude super admin userIds
          matchQuery.userId = {
            $nin: allowedUserIds.excludeIds.map(
              (id) => new mongoose.Types.ObjectId(id),
            ),
          };
        }
      }

      let sortQuery = { lastLoginAttempt: -1 };
      if (sorton && sortdir) {
        sortQuery = { [sorton]: sortdir === "desc" ? -1 : 1 };
      }

      const totalCount = await LoginAttempt.countDocuments(matchQuery);
      const attempts = await LoginAttempt.find(matchQuery)
        .sort(sortQuery)
        .skip(skip)
        .limit(per_page)
        .lean();

      const formattedAttempts = await Promise.all(
        attempts.map(async (attempt) => {
          let employeeName = "Unknown";
          let isActive = true;

          if (attempt.userId) {
            const foundUser = await Employee.findById(attempt.userId)
              .select("employeeName isActive")
              .lean();
            if (foundUser) {
              employeeName = foundUser.employeeName || "Unknown";
              isActive = foundUser.isActive;
            } else {
              const company = await CompanyMaster.findById(attempt.userId)
                .select("companyName email isActive")
                .lean();
              if (company) {
                employeeName = company.companyName || company.email || "Admin";
                isActive = company.isActive;
              }
            }
          }

          return {
            _id: attempt._id,
            userId: attempt.userId,
            employeeName,
            userEmail: attempt.userEmail,
            attemptCount: attempt.attemptCount,
            isLocked: attempt.isLocked,
            lockUntil: attempt.lockUntil,
            lastLoginAttempt: attempt.lastLoginAttempt,
            lastLoggedIn: attempt.lastLoggedIn,
            ipAddress: attempt.ipAddress,
            city: attempt.locationCoordinates?.city || "-",
            country: attempt.locationCoordinates?.country || "-",
            latitude: attempt.locationCoordinates?.latitude || null,
            longitude: attempt.locationCoordinates?.longitude || null,
            isActive,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
          };
        }),
      );

      res.status(200).json({
        isOk: true,
        data: [{ count: totalCount, data: formattedAttempts }],
        status: 200,
      });
    } catch (error) {
      res.status(500).json({
        isOk: false,
        message: error.message,
        status: 500,
      });
    }
  },
);
router.post(
  "/admin/auth/block",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/login-attempt-logs", "edit"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res
          .status(400)
          .json({ isOk: false, message: "userId is required", status: 400 });
      }
      const Employee = (await import("../../models/Employee.js")).default;
      const CompanyMaster = (await import("../../models/CompanyMaster.js"))
        .default;
      let user = await Employee.findByIdAndUpdate(userId, { isActive: false });
      let userType = "Employee";
      if (!user) {
        user = await CompanyMaster.findByIdAndUpdate(userId, {
          isActive: false,
        });
        userType = "Company";
      }
      if (!user) {
        return res
          .status(404)
          .json({ isOk: false, message: "User not found", status: 404 });
      }
      res.status(200).json({
        isOk: true,
        message: `${userType} account blocked successfully`,
        status: 200,
      });
    } catch (error) {
      res
        .status(500)
        .json({ isOk: false, message: error.message, status: 500 });
    }
  },
);

router.post(
  "/admin/auth/unblock",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  checkPermission("/login-attempt-logs", "edit"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res
          .status(400)
          .json({ isOk: false, message: "userId is required", status: 400 });
      }
      const Employee = (await import("../../models/Employee.js")).default;
      const CompanyMaster = (await import("../../models/CompanyMaster.js"))
        .default;
      let user = await Employee.findByIdAndUpdate(userId, { isActive: true });
      let userType = "Employee";
      if (!user) {
        user = await CompanyMaster.findByIdAndUpdate(userId, {
          isActive: true,
        });
        userType = "Company";
      }
      if (!user) {
        return res
          .status(404)
          .json({ isOk: false, message: "User not found", status: 404 });
      }
      res.status(200).json({
        isOk: true,
        message: `${userType} account unblocked successfully`,
        status: 200,
      });
    } catch (error) {
      res
        .status(500)
        .json({ isOk: false, message: error.message, status: 500 });
    }
  },
);

export default router;
