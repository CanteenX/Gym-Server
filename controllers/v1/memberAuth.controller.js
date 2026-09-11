import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Member from "../../models/Member.js";

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

const issueToken = (member) =>
  jwt.sign({ id: member._id.toString(), role: "MEMBER" }, memberSecret(), {
    expiresIn: TOKEN_TTL,
  });

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
        member: publicProfile(member),
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
 * Guard for every member-portal route.
 * Reads a bearer token and attaches { id } as req.member.
 */
export const requireMember = (req, res, next) => {
  if (!secretOk()) return secretMissingResponse(res);

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res
      .status(401)
      .json({ isOk: false, status: 401, message: "Not logged in" });
  }

  try {
    const payload = jwt.verify(token, memberSecret());
    if (payload.role !== "MEMBER") {
      return res
        .status(403)
        .json({ isOk: false, status: 403, message: "Access denied" });
    }
    req.member = { id: payload.id };
    next();
  } catch {
    return res.status(401).json({
      isOk: false,
      status: 401,
      message: "Session expired — please log in again",
    });
  }
};
