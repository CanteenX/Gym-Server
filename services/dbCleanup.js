import AuditLog from "../models/AuditLog.js";
import Notification from "../models/Notification.js";
import PushSubscription from "../models/PushSubscription.js";
import LoginAttempt from "../models/LoginAttempt.js";

/**
 * Retention thresholds agreed upon for database optimization:
 * - AuditLog: > 15 days
 * - Notification (Broadcast & Dispatch History + in-app inbox): > 30 days
 * - PushSubscription (inactive only): > 30 days
 * - LoginAttempt (unlocked & idle): > 15 days
 * - ReminderLog: Indefinite (preserved for records & duplicate prevention)
 */
export const RETENTION_CONFIG = {
  AUDIT_LOG_DAYS: 15,
  NOTIFICATION_DAYS: 30,
  INACTIVE_PUSH_DAYS: 30,
  LOGIN_ATTEMPT_DAYS: 15,
};

/**
 * Runs the database cleanup process.
 * Can be run in dryRun mode to preview count of rows to be deleted.
 *
 * @param {{ dryRun?: boolean }} options
 * @returns {Promise<object>} Execution report
 */
export const cleanDatabase = async ({ dryRun = false } = {}) => {
  const startedAt = Date.now();
  const now = new Date();

  const auditLogCutoff = new Date(now.getTime() - RETENTION_CONFIG.AUDIT_LOG_DAYS * 24 * 60 * 60 * 1000);
  const notificationCutoff = new Date(now.getTime() - RETENTION_CONFIG.NOTIFICATION_DAYS * 24 * 60 * 60 * 1000);
  const pushCutoff = new Date(now.getTime() - RETENTION_CONFIG.INACTIVE_PUSH_DAYS * 24 * 60 * 60 * 1000);
  const loginAttemptCutoff = new Date(now.getTime() - RETENTION_CONFIG.LOGIN_ATTEMPT_DAYS * 24 * 60 * 60 * 1000);

  const filters = {
    auditLogs: { createdAt: { $lt: auditLogCutoff } },
    notifications: { createdAt: { $lt: notificationCutoff } },
    pushSubscriptions: { active: false, updatedAt: { $lt: pushCutoff } },
    loginAttempts: { isLocked: false, updatedAt: { $lt: loginAttemptCutoff } },
  };

  const totals = {
    auditLogs: 0,
    notifications: 0,
    pushSubscriptions: 0,
    loginAttempts: 0,
  };

  if (dryRun) {
    const [auditCount, notifCount, pushCount, loginCount] = await Promise.all([
      AuditLog.countDocuments(filters.auditLogs),
      Notification.countDocuments(filters.notifications),
      PushSubscription.countDocuments(filters.pushSubscriptions),
      LoginAttempt.countDocuments(filters.loginAttempts),
    ]);

    totals.auditLogs = auditCount;
    totals.notifications = notifCount;
    totals.pushSubscriptions = pushCount;
    totals.loginAttempts = loginCount;
  } else {
    const [auditRes, notifRes, pushRes, loginRes] = await Promise.all([
      AuditLog.deleteMany(filters.auditLogs),
      Notification.deleteMany(filters.notifications),
      PushSubscription.deleteMany(filters.pushSubscriptions),
      LoginAttempt.deleteMany(filters.loginAttempts),
    ]);

    totals.auditLogs = auditRes.deletedCount || 0;
    totals.notifications = notifRes.deletedCount || 0;
    totals.pushSubscriptions = pushRes.deletedCount || 0;
    totals.loginAttempts = loginRes.deletedCount || 0;
  }

  const durationMs = Date.now() - startedAt;

  return {
    dryRun,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs,
    totals,
    retentionRules: {
      auditLogs: `Older than ${RETENTION_CONFIG.AUDIT_LOG_DAYS} days`,
      notifications: `Older than ${RETENTION_CONFIG.NOTIFICATION_DAYS} days`,
      reminderLogs: "Preserved indefinitely (0 deletions)",
      inactivePushSubscriptions: `Inactive older than ${RETENTION_CONFIG.INACTIVE_PUSH_DAYS} days`,
      unlockedLoginAttempts: `Unlocked older than ${RETENTION_CONFIG.LOGIN_ATTEMPT_DAYS} days`,
    },
  };
};

/**
 * Starts a recurring background cleanup interval for long-running node processes (e.g. PM2).
 */
export const startDailyCleanupSchedule = () => {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // Run initial cleanup 2 minutes after startup once all models are initialized
  setTimeout(() => {
    cleanDatabase()
      .then((res) => {
        console.log(`🧹 [dbCleanup] Initial cleanup executed:`, res.totals);
      })
      .catch((err) => {
        console.error(`❌ [dbCleanup] Initial cleanup failed:`, err);
      });
  }, 2 * 60 * 1000);

  // Recurring daily execution
  setInterval(() => {
    cleanDatabase()
      .then((res) => {
        console.log(`🧹 [dbCleanup] Scheduled daily cleanup executed:`, res.totals);
      })
      .catch((err) => {
        console.error(`❌ [dbCleanup] Scheduled daily cleanup failed:`, err);
      });
  }, TWENTY_FOUR_HOURS);
};

