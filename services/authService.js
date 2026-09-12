import LoginAttempt from "../models/LoginAttempt.js";
import mongoose from "mongoose";

// Constants
const MAX_ATTEMPTS = 3;
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/**
 * 1. Record a failed login attempt
 * Increments attemptCount and auto-locks if count >= 3
 * @param {string} userId - The user's MongoDB ObjectId
 * @param {string} userEmail - The user's email
 * @returns {Promise<Object>} Updated login attempt record
 */
const recordFailedAttempt = async (userId, userEmail) => {
    try {
        let attempt = await LoginAttempt.findOne({ userId });

        if (attempt) {
            // Update existing record
            attempt.attemptCount += 1;
            attempt.lastLoginAttempt = new Date();
            attempt.updatedAt = new Date();
        } else {
            // Create new record
            attempt = new LoginAttempt({
                userId,
                userEmail,
                attemptCount: 1,
                lastLoginAttempt: new Date(),
                isLocked: false,
                lockUntil: null,
            });
        }

        // Auto-lock if attempts >= MAX_ATTEMPTS
        if (attempt.attemptCount >= MAX_ATTEMPTS) {
            attempt.isLocked = true;
            attempt.lockUntil = new Date(Date.now() + LOCK_DURATION_MS);

        }

        await attempt.save();

        return {
            attemptCount: attempt.attemptCount,
            isLocked: attempt.isLocked,
            lockUntil: attempt.lockUntil,
            attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempt.attemptCount),
        };
    } catch (error) {
        console.error("Error recording failed attempt:", error);
        throw error;
    }
};

/**
 * 2. Lock an account manually
 * Sets isLocked: true, lockUntil: now + 24 hours
 * @param {string} userId - The user's MongoDB ObjectId
 * @returns {Promise<Object>} Updated login attempt record
 */
const lockAccount = async (userId) => {
    try {
        const cleanUserId = typeof userId === "string" ? userId.trim() : "";
        const isValid = /^[0-9a-fA-F]{24}$/.test(cleanUserId);
        if (!isValid) return null;

        const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);

        const result = await LoginAttempt.findOneAndUpdate(
            { userId: new mongoose.Types.ObjectId(cleanUserId) },
            {
                isLocked: true,
                lockUntil,
                updatedAt: new Date(),
            },
            { new: true }
        );

        if (result) {
            console.log(`Account manually locked until ${lockUntil}`);
        }

        return result;
    } catch (error) {
        console.error("Error locking account:", error);
        throw error;
    }
};

/**
 * 3. Check if an account is locked
 * Returns true if locked AND lockUntil > now. Auto-unlocks if expired.
 * @param {string} userId - The user's MongoDB ObjectId
 * @param {string} email - Optional email to check by email instead
 * @returns {Promise<boolean>} Whether the account is locked
 */
const isAccountLocked = async (userId, email = null) => {
    try {
        let query = {};
        if (email) {
            const cleanEmail = typeof email === "string" ? email.trim() : "";
            query = { userEmail: cleanEmail };
        } else {
            const cleanUserId = typeof userId === "string" ? userId.trim() : "";
            const isValid = /^[0-9a-fA-F]{24}$/.test(cleanUserId);
            if (!isValid) return false;
            query = { userId: new mongoose.Types.ObjectId(cleanUserId) };
        }
        const attempt = await LoginAttempt.findOne(query);

        if (!attempt?.isLocked) {
            return false;
        }

        // Check if lock has expired
        if (attempt.lockUntil && attempt.lockUntil < new Date()) {
            // Auto-unlock expired lock
            await LoginAttempt.findByIdAndUpdate(
                attempt._id,
                {
                    isLocked: false,
                    lockUntil: null,
                    attemptCount: 0,
                    updatedAt: new Date(),
                }
            );

            return false;
        }

        return true;
    } catch (error) {
        console.error("Error checking account lock status:", error);
        throw error;
    }
};

/**
 * 4. Record a successful login
 * Resets attemptCount: 0, isLocked: false, updates lastLoggedIn
 * @param {string} userId - The user's MongoDB ObjectId
 * @param {string} userEmail - The user's email
 * @returns {Promise<Object>} Updated login attempt record
 */
const recordSuccessfulLogin = async (userId, userEmail) => {
    try {
        const updateData = {
            attemptCount: 0,
            isLocked: false,
            lockUntil: null,
            lastLoggedIn: new Date(),
            updatedAt: new Date(),
        };

        const result = await LoginAttempt.findOneAndUpdate(
            { userId },
            updateData,
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        // If it's a new record (upserted), set the required fields
        if (!result.userEmail) {
            result.userEmail = userEmail;
            await result.save();
        }


        return result;
    } catch (error) {
        console.error("Error recording successful login:", error);
        throw error;
    }
};

/**
 * 5. Get login attempt status
 * Returns {attemptCount, isLocked, lockUntil, remainingTimeMs}
 * @param {string} userId - The user's MongoDB ObjectId
 * @param {string} email - Optional email to check by email
 * @returns {Promise<Object>} Login attempt status
 */
const buildAttemptQuery = (userId, email) => {
    if (email) {
        const cleanEmail = typeof email === "string" ? email.trim() : "";
        return { userEmail: cleanEmail };
    }

    const cleanUserId = typeof userId === "string" ? userId.trim() : "";
    const isValid = /^[0-9a-fA-F]{24}$/.test(cleanUserId);
    if (!isValid) return null;

    return { userId: new mongoose.Types.ObjectId(cleanUserId) };
};

const processAttemptLock = async (attempt) => {
    let isLocked = attempt.isLocked;
    let lockUntil = attempt.lockUntil;
    let remainingTime = null;
    let attemptCount = attempt.attemptCount;

    if (isLocked && lockUntil) {
        const now = new Date();
        if (lockUntil <= now) {
            await LoginAttempt.findByIdAndUpdate(
                attempt._id,
                {
                    isLocked: false,
                    lockUntil: null,
                    attemptCount: 0,
                    updatedAt: new Date(),
                }
            );
            isLocked = false;
            lockUntil = null;
            attemptCount = 0;
        } else {
            remainingTime = lockUntil.getTime() - now.getTime();
        }
    }

    return {
        attemptCount,
        isLocked,
        lockUntil,
        remainingTime,
        attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attemptCount),
    };
};

const getLoginAttemptStatus = async (userId, email = null) => {
    try {
        const query = buildAttemptQuery(userId, email);
        if (query === null) {
            return {
                attemptCount: 0,
                isLocked: false,
                lockUntil: null,
                remainingTime: null,
                attemptsRemaining: MAX_ATTEMPTS,
            };
        }

        const attempt = await LoginAttempt.findOne(query);
        if (attempt) {
            return await processAttemptLock(attempt);
        }

        return {
            attemptCount: 0,
            isLocked: false,
            lockUntil: null,
            remainingTime: null,
            attemptsRemaining: MAX_ATTEMPTS,
        };
    } catch (error) {
        console.error("Error getting login attempt status:", error);
        throw error;
    }
};

/**
 * Admin: Unlock a user account
 * @param {string} userId - The user's MongoDB ObjectId
 * @returns {Promise<Object>} Updated login attempt record
 */
const unlockAccount = async (userId) => {
    try {
        const cleanUserId = typeof userId === "string" ? userId.trim() : "";
        const isValid = /^[0-9a-fA-F]{24}$/.test(cleanUserId);
        if (!isValid) return null;

        const result = await LoginAttempt.findOneAndUpdate(
            { userId: new mongoose.Types.ObjectId(cleanUserId) },
            {
                isLocked: false,
                lockUntil: null,
                attemptCount: 0,
                updatedAt: new Date(),
            },
            { new: true }
        );

        if (result) {
            console.log("Account unlocked successfully");
        }

        return result;
    } catch (error) {
        console.error("Error unlocking account:", error);
        throw error;
    }
};

/**
 * Admin: Reset login attempts for a user
 * @param {string} userId - The user's MongoDB ObjectId
 * @returns {Promise<Object>} Updated login attempt record
 */
const resetLoginAttempts = async (userId) => {
    try {
        const cleanUserId = typeof userId === "string" ? userId.trim() : "";
        const isValid = /^[0-9a-fA-F]{24}$/.test(cleanUserId);
        if (!isValid) return null;

        const result = await LoginAttempt.findOneAndUpdate(
            { userId: new mongoose.Types.ObjectId(cleanUserId) },
            {
                attemptCount: 0,
                isLocked: false,
                lockUntil: null,
                updatedAt: new Date(),
            },
            { new: true }
        );

        if (result) {
            console.log("Login attempts reset successfully");
        }

        return result;
    } catch (error) {
        console.error("Error resetting login attempts:", error);
        throw error;
    }
};

export {
    recordFailedAttempt,
    lockAccount,
    isAccountLocked,
    recordSuccessfulLogin,
    getLoginAttemptStatus,
    unlockAccount,
    resetLoginAttempts,
};

export default {
    recordFailedAttempt,
    lockAccount,
    isAccountLocked,
    recordSuccessfulLogin,
    getLoginAttemptStatus,
    unlockAccount,
    resetLoginAttempts,
};
