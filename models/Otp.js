import mongoose from "mongoose";

const OtpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    otp: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 600, // OTP expires after 10 minutes (600 seconds)
    },
  },
  {
    timestamps: true,
  },
);

const Otp = mongoose.model("Otp", OtpSchema);

export default Otp;
