import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Member from "../../models/Member.js";
import Trainer from "../../models/Trainer.js";

/**
 * Member portal authentication.
 *
 * WHY THIS IS SEPARATE FROM THE ADMIN AUTH:
 *   - the admin locks an account after 3 failed attempts; a member who mistypes
 *     a password mid-workout would become a phone call to the front desk,
 *   - JWT survives a phone's browser/PWA context more reliably than the
 *     admin's session cookie,
 *   - a compromise on one side must not expose the other.
 *
 * Members log in with their MOBILE NUMBER — the one identifier they always
 * know and that staff already record. Email is optional on a member record, so
 * it cannot be the login key.
 */

const TOKEN_TTL = "15d";

/**
 * Signing key for member tokens.
 *
 * Deliberately its own key rather than sharing the staff secret: a leak on the
 * member side must not let anyone forge an admin token. There is no hardcoded
 * fallback — a known default is the same as no security at all.
 *
 * A missing key is a BOOT-TIME misconfiguration, so it is reported once and
 * loudly at startup. Throwing from inside a request handler instead produced an
 * opaque 500 with an empty body, which told nobody anything.
 */
// Read LAZILY, never at module scope.
//
// ES module imports are hoisted and evaluated before the importing module's
// body runs — so this file is fully evaluated BEFORE server.js reaches its
// dotenv.config() call. Capturing process.env at import time therefore always
// saw an empty value, which is what disabled member login even with a valid
// 128-character key sitting in .env.
const memberSecret = () => process.env.MEMBER_JWT_SECRET_KEY || "";
const secretOk = () => memberSecret().length >= 32;

/** Returns a clear 503 rather than a bare 500 when the key is absent. */
const secretMissingResponse = (res) =>
  res.status(503).json({
    isOk: false,
    status: 503,
    message:
      "Member login is not configured on this server. Set MEMBER_JWT_SECRET_KEY in .env and restart.",
  });

/** Digits only, so "90000 00001" and "9000000001" are the same person. */
const normaliseMobile = (value = "") => String(value).replace(/\D/g, "");

/**
 * The two kinds of portal user. Trainers arrived in Phase 3 (plan.md D4).
 *
 * These strings are the SAME VOCABULARY as Attendance.subjectType, on purpose:
 * the scan handler takes this value straight off the verified token and writes
 * it into the row, so a mismatch between the two would be a class of bug that
 * only shows up as wrong footfall numbers weeks later.
 */
export const SUBJECT_MEMBER = "MEMBER";
export const SUBJECT_TRAINER = "TRAINER";

/**
 * Portal token.
 *
 * ============================================================================
 * subjectType IS A SECURITY FIELD, NOT A LABEL. IT IS WHY THE GUARDS CHECK IT.
 * ============================================================================
 * Member and trainer tokens are signed with the SAME key
 * (MEMBER_JWT_SECRET_KEY) because both are portal users and the important
 * separation is the one from the staff session cookie. The consequence is that
 * a trainer's token is a perfectly valid signature to any code that only calls
 * jwt.verify() — validity alone therefore proves "some portal user", never
 * "a member".
 *
 * So every guard below decides on the CLAIM, not on the signature:
 *   requireMember      -> subjectType must be MEMBER   (weight, workouts, the
 *                         member's own attendance history and profile)
 *   requireTrainer     -> subjectType must be TRAINER
 *   requirePortalUser  -> either, and it tells the handler which
 *
 * `role` is written alongside and kept identical to subjectType so that any
 * code still reading the old claim — requireMember did, before Phase 3 — fails
 * closed on a trainer token rather than open.
 */
const issuePortalToken = (subject, subjectType) =>
  jwt.sign(
    { id: subject._id.toString(), role: subjectType, subjectType },
    memberSecret(),
    { expiresIn: TOKEN_TTL },
  );

/** Back-compat alias: every existing caller means "a member token". */
const issueToken = (member) => issuePortalToken(member, SUBJECT_MEMBER);

/** Shape returned to the portal — never includes the hash. */
const publicProfile = (member) => ({
  _id: member._id,
  fullName: member.fullName,
  mobileNumber: member.mobileNumber,
  email: member.email,
  branch: member.branch,
  planCode: member.planCode,
  startDate: member.startDate,
  endDate: member.endDate,
  photo: member.photo,
  heightCm: member.heightCm,
  sessionMinutes: member.sessionMinutes,
  totalFee: member.totalFee,
  paidAmount: member.paidAmount,
  balanceAmount: member.balanceAmount,
  mustChangePassword: member.mustChangePassword,
  isActive: member.isActive,
});

/**
 * Shape returned to the portal for a trainer. Never includes the hash.
 *
 * Much smaller than a member's because a trainer has no membership: no plan, no
 * dates, no balance. The portal branches on `subjectType` rather than on which
 * fields happen to be present.
 */
const publicTrainerProfile = (trainer) => ({
  _id: trainer._id,
  fullName: trainer.fullName,
  mobileNumber: trainer.mobileNumber,
  email: trainer.email,
  branch: trainer.branch,
  mustChangePassword: trainer.mustChangePassword,
  isActive: trainer.isActive,
});

/**
 * Resolve a trainer from whatever was typed into the portal login box.
 *
 * Returns null when there is NO trainer with credentials behind that
 * identifier — which the caller reads as "keep going and answer as before" —
 * and a { ok } result once a trainer has been found, so a trainer who simply
 * mistyped their password is told so instead of being told to go and ask an
 * administrator for credentials they already have.
 *
 * `isActive: true` in the query is load-bearing: deactivating a trainer is how
 * staff revoke a leaver's access, and it has to take effect at the login, not
 * only in the pickers.
 */
const tryTrainerLogin = async (typed, digits, password) => {
  const lowered = String(typed).toLowerCase();

  // Same in-memory match as the member path above, for the same reason: the
  // typed value may be a custom loginId or a mobile number written with spaces,
  // and normalising both sides in the database is not something an index can do.
  const candidates = await Trainer.find({ isActive: true }).select(
    "+passwordHash",
  );
  const trainer = candidates.find(
    (t) =>
      (t.loginId && t.loginId.toLowerCase() === lowered) ||
      (digits.length > 0 && normaliseMobile(t.mobileNumber) === digits),
  );

  if (!trainer || !trainer.passwordHash) return null;

  const ok = await bcrypt.compare(password, trainer.passwordHash);
  if (!ok) return { ok: false };

  trainer.lastLoginAt = new Date();
  await trainer.save();
  return { ok: true, trainer };
};

/** The login response for a trainer. No membership fields — there are none. */
const respondTrainerLogin = (res, result) => {
  if (!result.ok) {
    return res.status(401).json({
      isOk: false,
      status: 401,
      code: "BAD_PASSWORD",
      message: "Incorrect password. Please try again.",
    });
  }

  const { trainer } = result;
  return res.status(200).json({
    isOk: true,
    status: 200,
    message: "Login successful",
    data: {
      token: issuePortalToken(trainer, SUBJECT_TRAINER),
      subjectType: SUBJECT_TRAINER,
      trainer: publicTrainerProfile(trainer),
      // Explicitly null rather than absent: the portal reads `data.member` to
      // decide what to render, and an absent key and a null one are easy to
      // confuse in a client that was written before trainers existed.
      member: null,
      mustChangePassword: trainer.mustChangePassword,
    },
  });
};

export const memberLogin = async (req, res) => {
  try {
    if (!secretOk()) return secretMissingResponse(res);

    const { mobileNumber, password } = req.body;

    if (!mobileNumber || !password) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Mobile number and password are required",
      });
    }

    // The portal sends whatever the member typed. It may be a custom login ID
    // (email or otherwise) or their mobile number, so both are accepted.
    const typed = String(mobileNumber || req.body.loginId || "").trim();
    const digits = normaliseMobile(typed);
    const lowered = typed.toLowerCase();

    const candidates = await Member.find({ isActive: true }).select(
      "+passwordHash",
    );
    const member = candidates.find(
      (m) =>
        (m.loginId && m.loginId.toLowerCase() === lowered) ||
        (digits.length > 0 && normaliseMobile(m.mobileNumber) === digits),
    );

    const ADMIN_PROMPT =
      "This portal is accessible for Mid City Gym members only. Please ask the Mid City administrator to give you credentials. Thank you.";

    /**
     * ========================================================================
     * TRAINER FALLBACK (plan.md D4). ONE PORTAL LOGIN, TWO KINDS OF USER.
     * ========================================================================
     * Only reached when no member with credentials matched, so the member path
     * above is byte-for-byte the behaviour it always had — a member cannot be
     * shadowed by a trainer who happens to share a mobile number, and no
     * existing response shape or error code changed.
     *
     * A trainer gets NO subscription checks (there is no subscription to
     * check), and the token they receive carries subjectType: "TRAINER", which
     * is the only thing standing between them and the member-only routes.
     */
    if (!member || !member.passwordHash) {
      const trainerResult = await tryTrainerLogin(typed, digits, password);
      if (trainerResult) return respondTrainerLogin(res, trainerResult);
    }

    // Unknown number, or a member the front desk never issued credentials to:
    // both get the same guidance, which also avoids revealing who is a member.
    if (!member || !member.passwordHash) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        code: "NOT_A_MEMBER",
        message: ADMIN_PROMPT,
      });
    }

    // Wrong password stays a plain 401 — the account exists, the secret didn't.
    const ok = await bcrypt.compare(password, member.passwordHash);
    if (!ok) {
      return res.status(401).json({
        isOk: false,
        status: 401,
        code: "BAD_PASSWORD",
        message: "Incorrect password. Please try again.",
      });
    }

    // ===== Access rules, checked only AFTER the password is proven =====
    // Order matters: a lapsed member is told to renew rather than being told
    // their password is wrong.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (member.endDate && new Date(member.endDate) < today) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        code: "EXPIRED",
        message:
          "Your membership has ended. Please renew your gym subscription to access the portal.",
      });
    }

    // balanceAmount is a virtual derived from totalFee minus payments.
    if (member.balanceAmount > 0) {
      return res.status(403).json({
        isOk: false,
        status: 403,
        code: "PAYMENT_DUE",
        message: `You have ₹${member.balanceAmount.toLocaleString(
          "en-IN",
        )} pending. Please renew your gym subscription at the front desk to access the portal.`,
        dueAmount: member.balanceAmount,
      });
    }

    member.lastLoginAt = new Date();
    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Login successful",
      data: {
        token: issueToken(member),
        // Added in Phase 3 so the portal can tell the two kinds of login apart
        // without inspecting which fields happen to be present. Additive — no
        // existing key changed.
        subjectType: SUBJECT_MEMBER,
        member: publicProfile(member),
        trainer: null,
        mustChangePassword: member.mustChangePassword,
      },
    });
  } catch (error) {
    console.error("Member login error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Current member, resolved from the bearer token by requireMember. */
export const getMemberProfile = async (req, res) => {
  try {
    const member = await Member.findById(req.member.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }
    return res
      .status(200)
      .json({ isOk: true, status: 200, data: publicProfile(member) });
  } catch (error) {
    console.error("Member profile error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const changeMemberPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "New password must be at least 6 characters",
      });
    }

    const member = await Member.findById(req.member.id).select("+passwordHash");
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    // A member on their staff-issued first password shouldn't have to retype
    // it; anyone changing a password they already chose must confirm the old one.
    if (!member.mustChangePassword) {
      const ok = await bcrypt.compare(
        currentPassword || "",
        member.passwordHash,
      );
      if (!ok) {
        return res.status(401).json({
          isOk: false,
          status: 401,
          message: "Current password is incorrect",
        });
      }
    }

    member.passwordHash = await bcrypt.hash(newPassword, 10);
    member.mustChangePassword = false;
    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Change member password error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Staff-side: set or reset a member's portal password, and optionally give
 * them a custom login ID.
 */
export const setMemberPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password, loginId } = req.body;

    if (!password || String(password).length < 6) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Password must be at least 6 characters",
      });
    }

    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    // A custom login ID must not collide with another member's ID or number.
    if (loginId !== undefined) {
      const wanted = String(loginId).trim().toLowerCase();
      if (wanted) {
        const clash = await Member.findOne({
          _id: { $ne: id },
          loginId: wanted,
        });
        if (clash) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: `"${wanted}" is already used by another member. Choose a different login ID.`,
          });
        }
        member.loginId = wanted;
      } else {
        // Cleared — fall back to the mobile number.
        member.loginId = null;
      }
    }

    member.passwordHash = await bcrypt.hash(password, 10);
    member.mustChangePassword = true;
    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Portal access enabled for ${member.fullName}. Login ID: ${
        member.loginId || member.mobileNumber
      }. They will be asked to change this password on first login.`,
      data: { loginId: member.loginId || member.mobileNumber },
    });
  } catch (error) {
    console.error("Set member password error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Staff-side: revoke portal access without deleting the member. */
export const revokeMemberPortalAccess = async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    member.passwordHash = "";
    member.mustChangePassword = true;
    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Portal access removed for ${member.fullName}`,
    });
  } catch (error) {
    console.error("Revoke portal access error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Verifies the bearer token and returns its claims, or null.
 *
 * Shared by all three guards so there is exactly one place that calls
 * jwt.verify — and so "verified" can never be confused with "authorised",
 * which is the mistake the guards below exist to prevent. This function
 * deliberately does NOT decide anything about who may do what.
 */
const readPortalToken = (req) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, memberSecret());
    if (!payload?.id) return null;
    // A token minted before Phase 3 carries no subjectType and is a member's,
    // because members were the only portal users that existed. Defaulting it
    // here is what keeps every member logged in across the deploy instead of
    // signing out the whole gym.
    const subjectType =
      payload.subjectType || payload.role || SUBJECT_MEMBER;
    if (subjectType !== SUBJECT_MEMBER && subjectType !== SUBJECT_TRAINER) {
      return null;
    }
    return { id: payload.id, subjectType };
  } catch {
    return null;
  }
};

const notLoggedIn = (res) =>
  res.status(401).json({ isOk: false, status: 401, message: "Not logged in" });

const expired = (res) =>
  res.status(401).json({
    isOk: false,
    status: 401,
    message: "Session expired — please log in again",
  });

const forbidden = (res, message = "Access denied") =>
  res.status(403).json({ isOk: false, status: 403, message });

/**
 * Guard for MEMBER-ONLY portal routes. Attaches { id } as req.member.
 *
 * ============================================================================
 * DELIBERATELY NOT WIDENED IN PHASE 3. DO NOT REPLACE IT WITH requirePortalUser.
 * ============================================================================
 * Phase 3 added trainers to the portal, and the tempting move was to swap this
 * guard for the wider one everywhere. That would have handed every trainer the
 * routes behind it — weight logs, workout plans and logs, a member's own
 * attendance history and profile — because those handlers read `req.member.id`
 * and would have happily treated a trainer's id as a member's. A trainer
 * scanning in has no business reading a member's body metrics, and widening a
 * guard is exactly how that kind of access appears with nobody deciding it.
 *
 * So this stays strict, the wider guard is opt-in per route, and the one new
 * route that genuinely serves both (the scan) asks for the wider one by name.
 */
export const requireMember = (req, res, next) => {
  if (!secretOk()) return secretMissingResponse(res);

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return notLoggedIn(res);

  const claims = readPortalToken(req);
  if (!claims) return expired(res);

  // THE CHECK THAT MATTERS: a trainer's token is validly signed with this very
  // key, so the signature alone proves nothing about which routes it may reach.
  if (claims.subjectType !== SUBJECT_MEMBER) {
    return forbidden(res, "This area is for members only");
  }

  req.member = { id: claims.id };
  req.portalUser = { id: claims.id, subjectType: SUBJECT_MEMBER };
  next();
};

/**
 * Guard for TRAINER-ONLY portal routes.
 *
 * Nothing uses it yet — the scan is shared and the trainer's own shift history
 * is Phase 4's. It exists so that when something does, the check is already
 * written the same way round as the others rather than improvised.
 */
export const requireTrainer = (req, res, next) => {
  if (!secretOk()) return secretMissingResponse(res);

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return notLoggedIn(res);

  const claims = readPortalToken(req);
  if (!claims) return expired(res);

  if (claims.subjectType !== SUBJECT_TRAINER) {
    return forbidden(res, "This area is for trainers only");
  }

  req.trainer = { id: claims.id };
  req.portalUser = { id: claims.id, subjectType: SUBJECT_TRAINER };
  next();
};

/**
 * Guard for routes a MEMBER OR A TRAINER may use (plan.md D4).
 *
 * Attaches `req.portalUser = { id, subjectType }`, and that is the ONLY thing a
 * handler behind this guard may key off. It sets `req.member` for a member so
 * shared helpers keep working, and pointedly does NOT set it for a trainer:
 * a handler that forgets to branch on subjectType then crashes on an undefined
 * `req.member.id` instead of quietly running a member code path with a
 * trainer's id in it. Loud beats silent for this particular mistake.
 */
export const requirePortalUser = (req, res, next) => {
  if (!secretOk()) return secretMissingResponse(res);

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return notLoggedIn(res);

  const claims = readPortalToken(req);
  if (!claims) return expired(res);

  req.portalUser = { id: claims.id, subjectType: claims.subjectType };
  if (claims.subjectType === SUBJECT_MEMBER) req.member = { id: claims.id };
  else req.trainer = { id: claims.id };
  next();
};

/**
 * Whoever is logged in to the portal, member or trainer.
 *
 * The portal calls this on boot to restore a session. It exists because
 * /member-auth/me is behind requireMember and 403s a trainer — correctly, since
 * it returns a MEMBER profile — which would leave a trainer unable to refresh
 * the page without logging in again.
 */
export const getPortalProfile = async (req, res) => {
  try {
    const { id, subjectType } = req.portalUser;

    if (subjectType === SUBJECT_TRAINER) {
      const trainer = await Trainer.findById(id);
      if (!trainer || trainer.isActive === false) {
        return res
          .status(404)
          .json({ isOk: false, status: 404, message: "Trainer not found" });
      }
      return res.status(200).json({
        isOk: true,
        status: 200,
        data: { subjectType, trainer: publicTrainerProfile(trainer) },
      });
    }

    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }
    return res.status(200).json({
      isOk: true,
      status: 200,
      data: { subjectType, member: publicProfile(member) },
    });
  } catch (error) {
    console.error("Portal profile error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
