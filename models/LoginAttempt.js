import mongoose from "mongoose";

const loginAttemptSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
            index: true,
        },
        userEmail: {
            type: String,
            required: true,
            unique: true,
        },
        attemptCount: {
            type: Number,
            default: 0,
            min: 0,
            max: 3,
        },
        isLocked: {
            type: Boolean,
            default: false,
        },
        lockUntil: {
            type: Date,
            default: null,
        },
        lastLoginAttempt: {
            type: Date,
            default: Date.now,
        },
        lastLoggedIn: {
            type: Date,
            default: null,
        },
        ipAddress: {
            type: String,
            required: false,
        },
        locationCoordinates: {
            latitude: { type: Number, default: null },
            longitude: { type: Number, default: null },
            city: { type: String, default: null },
            country: { type: String, default: null },
        },
    },
    {
        timestamps: true,
    }
);

// TTL Index - auto-delete expired lock records (optional)
loginAttemptSchema.index({ lockUntil: 1 }, { expireAfterSeconds: 0 });

// Compound index for userId and isLocked
loginAttemptSchema.index({ userId: 1, isLocked: 1 });

const LoginAttempt = mongoose.model("LoginAttempt", loginAttemptSchema);

export default LoginAttempt;
