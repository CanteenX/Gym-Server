import Employee from "../models/Employee.js";
import CompanyMaster from "../models/CompanyMaster.js";

/**
 * The floor under every operation that can remove a way into the system.
 *
 * ============================================================================
 * WHY THIS IS SHARED, AND WHY THAT MATTERS MORE THAN IT LOOKS
 * ============================================================================
 *
 * A super admin can exist in EITHER table. `CompanyMaster` holds the owner's
 * login; an `Employee` row can also carry `isSuperAdmin`. The privilege is one
 * idea living in two collections, so any count that consults one of them is
 * not a count of super admins — it is a count of half of them.
 *
 * That is not hypothetical. The first version of this guard lived inside
 * employee.controller.js and counted `Employee` rows only. Live, that number
 * is ZERO: the single super admin in this system is a CompanyMaster row. The
 * guard was correct code aimed at the wrong collection, so it would never have
 * fired for the one account it existed to protect, while reading — in review,
 * in tests, in the commit message — exactly as though it did. A guard that
 * cannot fire is worse than an absent one, because its presence ends the
 * conversation.
 *
 * ============================================================================
 * WHAT IT PROTECTS
 * ============================================================================
 *
 * The CMS, the SEO manager, the audit log and the role screens are reachable
 * ONLY through the isSuperAdmin bypass — there is no permission row that grants
 * them, by design. So removing the last active super admin does not degrade the
 * system, it closes it: nobody can grant the privilege back, because granting
 * it requires a screen nobody can open. The only repair is editing the database
 * by hand.
 *
 * Deactivation reaches the same end as deletion — `findUserByEmail` filters on
 * `isActive: true`, so a switched-off super admin cannot log in — which is why
 * both paths must call this.
 *
 * It refuses the LAST one, not the idea: removing a super admin while another
 * active one remains is allowed.
 */

/**
 * Active super admins across both tables, optionally ignoring one row.
 *
 * `excludeId` is the row about to be removed or switched off. Without it the
 * count includes the very account being acted on and the guard cheerfully
 * allows the last removal.
 *
 * @param {import("mongoose").Types.ObjectId|string|null} excludeId
 * @returns {Promise<number>}
 */
export const countActiveSuperAdmins = async (excludeId = null) => {
  const not = excludeId ? { _id: { $ne: excludeId } } : {};
  const [employees, companies] = await Promise.all([
    Employee.countDocuments({ ...not, isSuperAdmin: true, isActive: true }),
    CompanyMaster.countDocuments({ ...not, isSuperAdmin: true, isActive: true }),
  ]);
  return employees + companies;
};

/**
 * Whether this request may remove or switch off this account.
 *
 * @param {object} req              the request, for the acting session
 * @param {{_id: any, isSuperAdmin?: boolean}} target  the row being acted on
 * @returns {Promise<string|null>}  an error to refuse with, or null to allow
 */
export const lastSuperAdminError = async (req, target) => {
  const actingId = String(req.session?.user?.id || "");
  if (actingId && actingId === String(target._id)) {
    return "You cannot remove or deactivate your own account while signed in to it.";
  }

  // Only a super admin can be the last one. Anyone else is free to remove.
  if (target.isSuperAdmin !== true) return null;

  const othersLeft = await countActiveSuperAdmins(target._id);
  if (othersLeft > 0) return null;

  return (
    "This is the last active super admin. Removing it would leave nobody able " +
    "to open the CMS, the audit log or the roles screens — and no way to grant " +
    "the privilege back, because granting it needs a screen nobody could open. " +
    "Create another super admin first."
  );
};
