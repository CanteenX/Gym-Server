import mongoose from "mongoose";
import Member from "../../models/Member.js";
import PushSubscription from "../../models/PushSubscription.js";
import Notification from "../../models/Notification.js";
import { getVapidKeys, sendWebPush } from "../../services/webPush.service.js";

/**
 * Returns VAPID public key so PWA can register with browser push service.
 */
export async function getVapidPublicKey(req, res) {
  try {
    const keys = getVapidKeys();
    res.json({
      success: true,
      publicKey: keys.publicKey,
    });
  } catch (err) {
    console.error("getVapidPublicKey error:", err);
    res.status(500).json({ success: false, message: "Failed to retrieve VAPID key" });
  }
}

/**
 * Returns member audience counts for the 3 tabs in the Notification Centre.
 */
export async function getAudienceCounts(req, res) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalUsers, paidUsers, pushSubscribers] = await Promise.all([
      Member.countDocuments(),
      Member.countDocuments({
        balanceAmount: { $lte: 0 },
        endDate: { $gte: today },
      }),
      PushSubscription.countDocuments({ active: true }),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        paidUsers,
        pushSubscribers,
      },
    });
  } catch (err) {
    console.error("getAudienceCounts error:", err);
    res.status(500).json({ success: false, message: "Failed to count audience" });
  }
}

/**
 * Search members for "A specific user" tab.
 */
export async function searchMembersForNotification(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.json({ success: true, data: [] });
    }

    const regex = new RegExp(q, "i");
    const members = await Member.find({
      $or: [
        { fullName: regex },
        { mobileNumber: regex },
        { membershipNumber: regex },
      ],
    })
      .select("_id fullName mobileNumber membershipNumber planCode endDate balanceAmount")
      .limit(10)
      .lean();

    // Check which of these members have active push subscriptions
    const memberIds = members.map((m) => m._id);
    const activeSubs = await PushSubscription.find({
      memberId: { $in: memberIds },
      active: true,
    })
      .select("memberId")
      .lean();

    const subMap = new Set(activeSubs.map((s) => s.memberId.toString()));

    const result = members.map((m) => ({
      ...m,
      hasPush: subMap.has(m._id.toString()),
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error("searchMembersForNotification error:", err);
    res.status(500).json({ success: false, message: "Member search failed" });
  }
}

/**
 * Dispatches custom notification to target audience (SPECIFIC, ALL, or PAID).
 */
export async function sendNotification(req, res) {
  try {
    const {
      title,
      body,
      targetType,
      targetMemberId,
      linkUrl = "/dashboard",
      category = "GENERAL",
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: "Notification title is required." });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ success: false, message: "Notification message body is required." });
    }
    if (!["SPECIFIC", "ALL", "PAID"].includes(targetType)) {
      return res.status(400).json({ success: false, message: "Invalid target audience tab." });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let targetMemberIds = [];
    let targetMemberName = "";

    if (targetType === "SPECIFIC") {
      if (!targetMemberId) {
        return res.status(400).json({
          success: false,
          message: "Please select a specific member to notify.",
        });
      }
      const member = await Member.findById(targetMemberId).select("fullName");
      if (!member) {
        return res.status(404).json({ success: false, message: "Target member not found." });
      }
      targetMemberIds = [member._id];
      targetMemberName = member.fullName;
    } else if (targetType === "PAID") {
      const paidMembers = await Member.find({
        balanceAmount: { $lte: 0 },
        endDate: { $gte: today },
      })
        .select("_id")
        .lean();
      targetMemberIds = paidMembers.map((m) => m._id);
    } else {
      // ALL
      const allMembers = await Member.find().select("_id").lean();
      targetMemberIds = allMembers.map((m) => m._id);
    }

    if (targetMemberIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No recipients matched the selected audience criteria.",
      });
    }

    // Build notification record for member inboxes
    const staffUser = req.user || req.session?.user || {};
    const sentByName = staffUser.fullName || staffUser.name || "Gym Staff";

    const recipients = targetMemberIds.map((id) => ({
      memberId: id,
      read: false,
    }));

    const notificationDoc = new Notification({
      title: title.trim(),
      body: body.trim(),
      targetType,
      targetMemberId: targetType === "SPECIFIC" ? targetMemberId : null,
      targetMemberName,
      linkUrl: linkUrl?.trim() || "/dashboard",
      category,
      sentBy: staffUser._id || null,
      sentByName,
      totalTargeted: targetMemberIds.length,
      recipients,
    });

    // Query active push subscriptions for these members
    const subscriptions = await PushSubscription.find({
      memberId: { $in: targetMemberIds },
      active: true,
    });

    // Prepare Web Push payload
    const pushPayload = JSON.stringify({
      title: title.trim(),
      body: body.trim(),
      url: linkUrl?.trim() || "/dashboard",
      icon: "/icon-app.svg",
      badge: "/icon-app.svg",
      tag: `notification-${notificationDoc._id}`,
    });

    // Broadcast push notifications in batches
    let deliveredCount = 0;
    let failedCount = 0;

    if (subscriptions.length > 0) {
      const results = await Promise.allSettled(
        subscriptions.map((sub) => sendWebPush(sub, pushPayload))
      );

      for (const res of results) {
        if (res.status === "fulfilled" && res.value.success) {
          deliveredCount++;
        } else {
          failedCount++;
        }
      }
    }

    notificationDoc.deliveredCount = deliveredCount;
    notificationDoc.failedCount = failedCount;
    await notificationDoc.save();

    res.json({
      success: true,
      message: `Notification dispatched successfully to ${targetMemberIds.length} members (${deliveredCount} push deliveries sent).`,
      data: {
        notificationId: notificationDoc._id,
        targetType,
        totalTargeted: targetMemberIds.length,
        pushDevicesReached: deliveredCount,
      },
    });
  } catch (err) {
    console.error("sendNotification error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to send notification" });
  }
}

/**
 * Returns past sent notifications for the history table in Notification Centre.
 */
export async function getNotificationHistory(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "20", 10)));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Notification.find()
        .select("-recipients")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(),
    ]);

    res.json({
      success: true,
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("getNotificationHistory error:", err);
    res.status(500).json({ success: false, message: "Failed to load notification history" });
  }
}

/**
 * Member Portal: Save/update a device push subscription.
 */
export async function savePushSubscription(req, res) {
  try {
    const { endpoint, keys, userAgent } = req.body;
    const memberId = req.portalUser?.id || req.member?._id;

    if (!memberId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, message: "Invalid push subscription object" });
    }

    const subjectType = req.portalUser?.subjectType || "MEMBER";

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        memberId,
        subjectType,
        endpoint,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
        userAgent: userAgent || req.headers["user-agent"] || "",
        active: true,
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: "Push notification subscription registered successfully.",
    });
  } catch (err) {
    console.error("savePushSubscription error:", err);
    res.status(500).json({ success: false, message: "Failed to register push subscription" });
  }
}

/**
 * Member Portal: Fetch member's in-app notification inbox.
 */
export async function getMemberNotifications(req, res) {
  try {
    const memberId = req.portalUser?.id || req.member?._id;
    if (!memberId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    const mId = new mongoose.Types.ObjectId(memberId);

    const notifications = await Notification.aggregate([
      { $match: { "recipients.memberId": mId } },
      { $sort: { createdAt: -1 } },
      { $limit: 30 },
      {
        $project: {
          title: 1,
          body: 1,
          category: 1,
          linkUrl: 1,
          sentByName: 1,
          createdAt: 1,
          recipient: {
            $filter: {
              input: "$recipients",
              as: "r",
              cond: { $eq: ["$$r.memberId", mId] },
            },
          },
        },
      },
    ]);

    const formatted = notifications.map((n) => ({
      _id: n._id,
      title: n.title,
      body: n.body,
      category: n.category,
      linkUrl: n.linkUrl,
      sentByName: n.sentByName,
      createdAt: n.createdAt,
      read: n.recipient?.[0]?.read ?? false,
      readAt: n.recipient?.[0]?.readAt ?? null,
    }));

    const unreadCount = formatted.filter((n) => !n.read).length;

    res.json({
      success: true,
      data: formatted,
      unreadCount,
    });
  } catch (err) {
    console.error("getMemberNotifications error:", err);
    res.status(500).json({ success: false, message: "Failed to load notifications" });
  }
}

/**
 * Member Portal: Mark notification as read.
 */
export async function markNotificationRead(req, res) {
  try {
    const memberId = req.portalUser?.id || req.member?._id;
    const { id } = req.params;

    if (!memberId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    await Notification.updateOne(
      {
        _id: id,
        "recipients.memberId": new mongoose.Types.ObjectId(memberId),
      },
      {
        $set: {
          "recipients.$.read": true,
          "recipients.$.readAt": new Date(),
        },
      }
    );

    res.json({ success: true, message: "Marked as read" });
  } catch (err) {
    console.error("markNotificationRead error:", err);
    res.status(500).json({ success: false, message: "Failed to update notification status" });
  }
}
