import Trainer from "../../models/Trainer.js";
import Member from "../../models/Member.js";
import {
  scopeFilter,
  resolveBranchFilter,
  scopedBranch,
} from "../../middlewares/branchScope.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Lightweight list for dropdowns — active trainers only, name + branch. */
export const listAllTrainers = async (req, res) => {
  try {
    // Scoped so a branch admin's trainer dropdown cannot offer (or reveal) the
    // other branch's staff.
    const trainers = await Trainer.find({ ...scopeFilter(req), isActive: true })
      .select("fullName mobileNumber branch")
      .sort({ fullName: 1 });

    return res.status(200).json({ isOk: true, status: 200, data: trainers });
  } catch (error) {
    console.error("Error listing trainers:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createTrainer = async (req, res) => {
  try {
    const { fullName, mobileNumber, email, branch, notes, isActive } = req.body;

    if (!fullName?.trim()) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Trainer name is required" });
    }
    if (!mobileNumber?.trim()) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Contact number is required",
      });
    }

    const existing = await Trainer.findOne({
      mobileNumber: mobileNumber.trim(),
    });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A trainer with this contact number already exists",
      });
    }

    const trainer = new Trainer({
      fullName: fullName.trim(),
      mobileNumber: mobileNumber.trim(),
      email: email?.trim() || "",
      // scopedBranch() FIRST — a branch admin's new trainers land in their own
      // branch whatever the body says. null for a super admin.
      branch: scopedBranch(req) || branch || "Vasna",
      notes: notes?.trim() || "",
      isActive: isActive !== undefined ? isActive : true,
    });

    await trainer.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Trainer added successfully",
      data: trainer,
    });
  } catch (error) {
    console.error("Error creating trainer:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateTrainer = async (req, res) => {
  try {
    const { id } = req.params;
    /**
     * BRANCH SCOPE ON A BY-ID LOOKUP. Both list endpoints here were already
     * scoped (listAllTrainers, listTrainersByParams) while every by-id verb
     * was not — the same split that left Member and Transaction open. Trainer
     * rows carry name, mobile and email, so an unscoped read is a staff data
     * leak and an unscoped write is worse.
     *
     * Spread LAST; the refusal is the existing 404, not a 403, so the response
     * does not reveal that the id is real in the other branch.
     */
    const trainer = await Trainer.findOne({ _id: id, ...scopeFilter(req) });
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    // "branch" is editable ONLY by a super admin. Otherwise a branch admin who
    // legitimately reached one of their own trainers could push them into the
    // other branch — crossing the same boundary on the way out.
    const editable = ["fullName", "mobileNumber", "email", "notes", "isActive"];
    if (!scopedBranch(req)) editable.push("branch");
    editable.forEach((f) => {
      if (req.body[f] !== undefined) trainer[f] = req.body[f];
    });

    await trainer.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Trainer updated successfully",
      data: trainer,
    });
  } catch (error) {
    console.error("Error updating trainer:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Deleting a trainer who still has members would silently orphan them, so this
 * refuses and reports how many need reassigning first.
 */
export const deleteTrainer = async (req, res) => {
  try {
    const { id } = req.params;
    // scopeFilter spread LAST — deleting the other branch's trainer is a 404.
    const trainer = await Trainer.findOne({ _id: id, ...scopeFilter(req) });
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    const assignedCount = await Member.countDocuments({ trainerId: id });
    if (assignedCount > 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: `${trainer.fullName} still has ${assignedCount} member(s) assigned. Reassign or remove them before deleting this trainer.`,
        assignedCount,
      });
    }

    await Trainer.findOneAndDelete({ _id: id, ...scopeFilter(req) });

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Trainer deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting trainer:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listTrainersByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, isActive, branch } =
      req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    // Session scope wins over any client-supplied branch (see branchScope.js).
    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) matchCondition.branch = effectiveBranch;

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { fullName: { $regex: escaped, $options: "i" } },
        { mobileNumber: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowed = ["fullName", "branch", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "fullName";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    const totalCount = await Trainer.countDocuments(matchCondition);
    const trainers = await Trainer.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    // Attach the derived roster size so the list can show it without a second
    // round trip per row.
    const ids = trainers.map((t) => t._id);
    const counts = await Member.aggregate([
      { $match: { trainerId: { $in: ids } } },
      { $group: { _id: "$trainerId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

    const data = trainers.map((t) => ({
      ...t,
      memberCount: countMap.get(String(t._id)) || 0,
    }));

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing trainers by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** The trainer's roster — derived from Member.trainerId, never stored. */
export const getTrainerMembers = async (req, res) => {
  try {
    const { id } = req.params;
    // scopeFilter spread LAST on BOTH queries. The trainer check alone is not
    // enough: a member could have been assigned across branches before this
    // fix, and the roster must not surface them now.
    const trainer = await Trainer.findOne({ _id: id, ...scopeFilter(req) });
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    const members = await Member.find({
      trainerId: id,
      ...scopeFilter(req),
    }).sort({ fullName: 1 });

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: { trainer, members },
    });
  } catch (error) {
    console.error("Error fetching trainer roster:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Assign members to this trainer (the "add members from the trainer side"
 * direction). Writes the same `trainerId` the member form writes, so both
 * doors lead to one source of truth.
 */
export const assignMembers = async (req, res) => {
  try {
    const { id } = req.params;
    const { memberIds } = req.body;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Select at least one member to assign",
      });
    }

    // scopeFilter spread LAST on the trainer AND on the members.
    //
    // The updateMany was the sharpest edge in this file: memberIds comes
    // straight off the request body and was written with NO branch filter at
    // all, so a Vasna admin could reassign an arbitrary list of Gotri members
    // to a Vasna trainer in one call. listUnassignedMembers scopes the picker
    // it is normally driven from, but a picker is not a boundary — the write
    // is. Out-of-scope ids now simply match nothing, and modifiedCount reports
    // honestly how many were actually assigned.
    const trainer = await Trainer.findOne({ _id: id, ...scopeFilter(req) });
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    const result = await Member.updateMany(
      { _id: { $in: memberIds }, ...scopeFilter(req) },
      { $set: { trainerId: id } },
    );

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `${result.modifiedCount} member(s) assigned to ${trainer.fullName}`,
      data: { modifiedCount: result.modifiedCount },
    });
  } catch (error) {
    console.error("Error assigning members:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Remove one member from this trainer's roster. */
export const unassignMember = async (req, res) => {
  try {
    const { id, memberId } = req.params;

    // scopeFilter spread LAST — unassigning the other branch's member is a 404.
    const member = await Member.findOne({
      _id: memberId,
      ...scopeFilter(req),
    });
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    if (String(member.trainerId) !== String(id)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "That member is not assigned to this trainer",
      });
    }

    member.trainerId = null;
    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `${member.fullName} removed from this trainer`,
    });
  } catch (error) {
    console.error("Error unassigning member:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Members with no trainer yet — the candidate pool for the assign picker. */
export const listUnassignedMembers = async (req, res) => {
  try {
    const { branch, match } = req.body || {};

    const condition = {
      isActive: true,
      $or: [{ trainerId: null }, { trainerId: { $exists: false } }],
    };
    // Assigning across branches must not even be possible to attempt, so the
    // candidate pool itself is scoped.
    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) condition.branch = effectiveBranch;

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      condition.$and = [
        {
          $or: [
            { fullName: { $regex: escaped, $options: "i" } },
            { mobileNumber: { $regex: escaped, $options: "i" } },
          ],
        },
      ];
    }

    const members = await Member.find(condition)
      .select("fullName mobileNumber branch planCode endDate")
      .sort({ fullName: 1 })
      .limit(200);

    return res.status(200).json({ isOk: true, status: 200, data: members });
  } catch (error) {
    console.error("Error listing unassigned members:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
