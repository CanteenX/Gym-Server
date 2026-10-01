import express from "express";
import { authMiddleware } from "../../middlewares/authMiddleware.js";
import { requirePortalUser } from "../../controllers/v1/memberAuth.controller.js";
import {
  getVapidPublicKey,
  getAudienceCounts,
  searchMembersForNotification,
  sendNotification,
  getNotificationHistory,
  savePushSubscription,
  getMemberNotifications,
  markNotificationRead,
} from "../../controllers/v1/notification.controller.js";

const router = express.Router();

// ── Public / Common ─────────────────────────────────────────────────────────
router.get("/notifications/vapid-public-key", getVapidPublicKey);

// ── Staff / Admin Notification Centre ───────────────────────────────────────
router.get(
  "/notifications/audience-counts",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getAudienceCounts
);

router.get(
  "/notifications/search-members",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  searchMembersForNotification
);

router.post(
  "/notifications/send",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  sendNotification
);

router.get(
  "/notifications/history",
  authMiddleware(["ADMIN", "EMPLOYEE"]),
  getNotificationHistory
);

// ── Member Portal PWA ───────────────────────────────────────────────────────
router.post(
  "/member-portal/push-subscription",
  requirePortalUser,
  savePushSubscription
);

router.get(
  "/member-portal/notifications",
  requirePortalUser,
  getMemberNotifications
);

router.put(
  "/member-portal/notifications/:id/read",
  requirePortalUser,
  markNotificationRead
);

export default router;
