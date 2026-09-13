import bcrypt from "bcrypt";
import Trainer from "../../models/Trainer.js";

/**
 * STAFF-SIDE management of a trainer's portal credentials (plan.md D4).
 *
 * The exact counterpart of setMemberPassword / revokeMemberPortalAccess in
 * memberAuth.controller.js — same flow, same wording, same rules — so the admin
 * screen for a trainer is the member one with a different noun. Kept in its own
 * file rather than bolted onto memberAuth.controller.js only because that file
 * is already long; the behaviour is deliberately identical.
 *
 * ============================================================================
 * BOTH HANDLERS WRITE CREDENTIALS, SO BOTH ROUTES MUST BE BEHIND A STAFF
 * SESSION. See routes/v1/memberAuth.routes.js — the member equivalents once
 * shipped with NO guard at all, which meant anyone who could guess a trainer's
 * _id could set their password and then log in as them. Do not repeat it.
 * ============================================================================
 *
 * NOTE ON SCOPING: these are not branch-scoped, matching the rest of
 * trainers.routes.js, where a branch admin can already edit any trainer.
 * Narrowing that is a change to the whole trainer surface, not to this file.
 */

const fail = (res, status, message) =>
  res.status(status).json({ isOk: false, status, message });

/**
 * PUT /api/v1/trainers/:id/set-password
 *
 * Set or reset a trainer's portal password, and optionally give them a custom
 * login ID. `mustChangePassword` is forced true: the password travelled through
 * a member of staff to reach the trainer, so it is known to somebody else and
 * has to be replaced on first use.
 */
export const setTrainerPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password, loginId } = req.body;

    if (!password || String(password).length < 6) {
      return fail(res, 400, "Password must be at least 6 characters");
    }

    const trainer = await Trainer.findById(id);
    if (!trainer) return fail(res, 404, "Trainer not found");

    // A custom login ID must not collide with another trainer's. It is checked
    // against trainers only — a member and a trainer may share an identifier
    // because the login resolves members first and trainers only as a fallback,
    // which makes that collision resolvable rather than ambiguous.
    if (loginId !== undefined) {
      const wanted = String(loginId).trim().toLowerCase();
      if (wanted) {
        const clash = await Trainer.findOne({
          _id: { $ne: id },
          loginId: wanted,
        });
        if (clash) {
          return fail(
            res,
            400,
            `"${wanted}" is already used by another trainer. Choose a different login ID.`,
          );
        }
        trainer.loginId = wanted;
      } else {
        // Cleared — fall back to the mobile number.
        trainer.loginId = null;
      }
    }

    trainer.passwordHash = await bcrypt.hash(password, 10);
    trainer.mustChangePassword = true;
    await trainer.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Portal access enabled for ${trainer.fullName}. Login ID: ${
        trainer.loginId || trainer.mobileNumber
      }. They will be asked to change this password on first login.`,
      data: { loginId: trainer.loginId || trainer.mobileNumber },
    });
  } catch (error) {
    console.error("Set trainer password error:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * DELETE /api/v1/trainers/:id/portal-access
 *
 * Revoke portal access without deleting the trainer. Clearing the hash is
 * enough: the login handler skips any trainer with an empty hash, and the
 * pre-save hook flips hasPortalAccess so the admin list shows it immediately.
 *
 * Already-issued tokens stay valid until they expire (15 days) — that is the
 * standing trade-off of stateless JWT on the portal side and it is the same for
 * members. Deactivating the trainer (isActive: false) is the instant lever,
 * because the scan handler re-reads the record on every call.
 */
export const revokeTrainerPortalAccess = async (req, res) => {
  try {
    const trainer = await Trainer.findById(req.params.id);
    if (!trainer) return fail(res, 404, "Trainer not found");

    trainer.passwordHash = "";
    trainer.mustChangePassword = true;
    await trainer.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Portal access removed for ${trainer.fullName}`,
    });
  } catch (error) {
    console.error("Revoke trainer portal access error:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};

/**
 * POST /api/v1/portal-auth/trainer/change-password
 *
 * The trainer's own password change, behind requireTrainer. Mirrors
 * changeMemberPassword, including the rule that a trainer still on their
 * staff-issued first password does not have to retype it.
 */
export const changeTrainerPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || String(newPassword).length < 6) {
      return fail(res, 400, "New password must be at least 6 characters");
    }

    const trainer = await Trainer.findById(req.trainer.id).select(
      "+passwordHash",
    );
    if (!trainer) return fail(res, 404, "Trainer not found");

    if (!trainer.mustChangePassword) {
      const ok = await bcrypt.compare(
        currentPassword || "",
        trainer.passwordHash,
      );
      if (!ok) return fail(res, 401, "Current password is incorrect");
    }

    trainer.passwordHash = await bcrypt.hash(newPassword, 10);
    trainer.mustChangePassword = false;
    await trainer.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Change trainer password error:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
