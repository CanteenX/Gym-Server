import mongoose from "mongoose";

/**
 * Stores browser Web Push API subscriptions for members and trainers.
 *
 * Each subscription represents an installed browser/PWA instance on a device.
 * A single member can have multiple subscriptions (e.g. mobile phone + laptop).
 */
const PushSubscriptionSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      index: true,
      required: true,
    },
    subjectType: {
      type: String,
      enum: ["MEMBER", "TRAINER"],
      default: "MEMBER",
      required: true,
    },
    endpoint: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    keys: {
      p256dh: {
        type: String,
        required: true,
        trim: true,
      },
      auth: {
        type: String,
        required: true,
        trim: true,
      },
    },
    userAgent: {
      type: String,
      default: "",
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.models.PushSubscription ||
  mongoose.model("PushSubscription", PushSubscriptionSchema);
