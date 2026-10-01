import mongoose from "mongoose";

/**
 * Audit record of all custom notifications broadcast or dispatched from the
 * Notification Centre. Stores targeting metadata, delivery metrics, and individual
 * recipient read statuses for the member's in-app inbox.
 */
const NotificationRecipientSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      index: true,
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const NotificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    targetType: {
      type: String,
      enum: ["SPECIFIC", "ALL", "PAID"],
      required: true,
      index: true,
    },
    targetMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
      index: true,
    },
    targetMemberName: {
      type: String,
      default: "",
      trim: true,
    },
    linkUrl: {
      type: String,
      default: "/dashboard",
      trim: true,
    },
    category: {
      type: String,
      enum: ["GENERAL", "ANNOUNCEMENT", "REMINDER", "OFFER", "ALERT"],
      default: "GENERAL",
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    sentByName: {
      type: String,
      default: "Gym Staff",
      trim: true,
    },
    totalTargeted: {
      type: Number,
      default: 0,
    },
    deliveredCount: {
      type: Number,
      default: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
    },
    recipients: [NotificationRecipientSchema],
  },
  { timestamps: true }
);

NotificationSchema.index({ "recipients.memberId": 1, createdAt: -1 });

export default mongoose.models.Notification ||
  mongoose.model("Notification", NotificationSchema);
