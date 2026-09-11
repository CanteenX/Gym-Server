import Trainer from "../../models/Trainer.js";
import Member from "../../models/Member.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Lightweight list for dropdowns — active trainers only, name + branch. */
export const listAllTrainers = async (_req, res) => {
  try {
    const trainers = await Trainer.find({ isActive: true })
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
      branch: branch || "Vasna",
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
    const trainer = await Trainer.findById(id);
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    ["fullName", "mobileNumber", "email", "branch", "notes", "isActive"].forEach(
      (f) => {
        if (req.body[f] !== undefined) trainer[f] = req.body[f];
      },
    );

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
    const trainer = await Trainer.findById(id);
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

    await Trainer.findByIdAndDelete(id);

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
    if (branch) matchCondition.branch = branch;

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
    const trainer = await Trainer.findById(id);
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    const members = await Member.find({ trainerId: id }).sort({ fullName: 1 });

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

    const trainer = await Trainer.findById(id);
    if (!trainer) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Trainer not found" });
    }

    const result = await Member.updateMany(
      { _id: { $in: memberIds } },
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

    const member = await Member.findById(memberId);
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
    if (branch) condition.branch = branch;

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
