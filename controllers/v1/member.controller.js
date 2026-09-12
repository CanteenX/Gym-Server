import fs from "node:fs";
import path from "node:path";
import Member from "../../models/Member.js";
import MembershipPlan from "../../models/MembershipPlan.js";
import { compressToWebP } from "../../middlewares/secureUpload.js";
import { persistBuffer } from "../../storage/fileStore.js";
import { scopeFilter, resolveBranchFilter } from "../../middlewares/branchScope.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Midnight today, so "expiring in 7 days" ignores clock time. */
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Converts an uploaded image to WebP and returns the stored path.
 *
 * The route's multer pass has compression disabled because the same field set
 * accepts PDFs, which must not be transcoded. Optimising here — after upload,
 * where the real file type is known — keeps PDFs intact while still shrinking
 * photos substantially (typically 70-90%).
 *
 * On any failure the original file is kept, so a member never loses an upload
 * to a conversion problem.
 */
const optimizeUpload = async (file) => {
  if (!file) return null;

  // The uploader validated these bytes but deliberately did not store them
  // (compress:false => storagePending), so this is the only write that happens.
  // Storing first and re-encoding afterwards would leave an orphaned
  // full-resolution copy behind whenever the cleanup delete failed.
  if (file.storagePending && file.buffer) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    let buffer = file.buffer;
    let outExt = ext || ".bin";
    let mime = file.mimetype || "application/octet-stream";

    if (ext !== ".pdf" && ext !== ".webp") {
      try {
        const webp = await compressToWebP(buffer, { quality: 82 });
        // compressToWebP returns the input unchanged when sharp is unavailable.
        if (webp !== buffer) {
          buffer = webp;
          outExt = ".webp";
          mime = "image/webp";
        }
      } catch (error) {
        console.error("[MEMBER] Image optimization failed:", error.message);
      }
    }

    const base = (file.filename || "upload").replace(/\.[^.]+$/, "");
    return persistBuffer(
      buffer,
      `${base}${outExt}`,
      mime,
      file.destination || "uploads",
    );
  }

  if (!file.path) return null;

  const ext = path.extname(file.path).toLowerCase();
  if (ext === ".pdf" || ext === ".webp") return file.path;

  try {
    const original = await fs.promises.readFile(file.path);
    const webp = await compressToWebP(original, { quality: 82 });

    // compressToWebP returns the input unchanged when sharp is unavailable.
    if (webp === original) return file.path;

    const webpPath = file.path.replace(/\.[^.]+$/, ".webp");
    await fs.promises.writeFile(webpPath, webp);

    if (webpPath !== file.path) {
      await fs.promises.unlink(file.path).catch(() => {});
    }
    return webpPath;
  } catch (error) {
    console.error("[MEMBER] Image optimization failed:", error.message);
    return file.path;
  }
};

/** Adds whole months, clamping to the last valid day (31 Jan + 1mo = 28/29 Feb). */
const addMonths = (date, months) => {
  const d = new Date(date);
  const targetDay = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < targetDay) {
    d.setDate(0);
  }
  return d;
};

/**
 * The plan catalogue, read from the Membership Plan master so the member form
 * always reflects whatever plans the admin has configured.
 */
export const getMemberPlans = async (_req, res) => {
  try {
    const plans = await MembershipPlan.find({ isActive: true }).sort({
      sequence: 1,
      label: 1,
    });

    return res.status(200).json({ isOk: true, status: 200, data: plans });
  } catch (error) {
    console.error("Error fetching member plans:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const createMember = async (req, res) => {
  try {
    const {
      fullName,
      mobileNumber,
      email,
      gender,
      dateOfBirth,
      emergencyContactName,
      emergencyContactNumber,
      address,
      branch,
      trainerId,
      planCode,
      startDate,
      endDate,
      totalFee,
      notes,
      isActive,
      initialPayment,
      heightCm,
    } = req.body;

    if (!fullName?.trim()) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Member name is required" });
    }
    if (!mobileNumber?.trim()) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Contact number is required",
      });
    }
    if (!startDate) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Start date is required" });
    }

    const plan = planCode
      ? await MembershipPlan.findOne({ code: planCode })
      : null;
    const start = new Date(startDate);

    // End date is explicit when given, otherwise derived from the plan length.
    const end = endDate
      ? new Date(endDate)
      : addMonths(start, plan ? plan.months : 1);

    const existing = await Member.findOne({ mobileNumber: mobileNumber.trim() });
    if (existing) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A member with this contact number already exists",
      });
    }

    const payments = [];
    if (initialPayment && Number(initialPayment.amount) > 0) {
      payments.push({
        amount: Number(initialPayment.amount),
        paidOn: initialPayment.paidOn
          ? new Date(initialPayment.paidOn)
          : new Date(),
        mode: initialPayment.mode || "Cash",
        receiptNo: initialPayment.receiptNo || "",
        note: initialPayment.note || "Joining payment",
      });
    }

    const member = new Member({
      fullName: fullName.trim(),
      mobileNumber: mobileNumber.trim(),
      email: email?.trim() || "",
      gender: gender || "",
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      emergencyContactName: emergencyContactName?.trim() || "",
      emergencyContactNumber: emergencyContactNumber?.trim() || "",
      address: address?.trim() || "",
      branch: branch || "Vasna",
      trainerId: trainerId || null,
      planCode: planCode || "MONTHLY",
      startDate: start,
      endDate: end,
      totalFee:
        totalFee !== undefined ? Number(totalFee) : plan?.defaultFee || 0,
      payments,
      notes: notes?.trim() || "",
      isActive: isActive !== undefined ? isActive : true,
    });

    if (req.files?.photo) {
      member.photo = await optimizeUpload(req.files.photo[0]);
    }
    if (req.files?.idProof) {
      member.idProof = await optimizeUpload(req.files.idProof[0]);
    }

    await member.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Member added successfully",
      data: member,
    });
  } catch (error) {
    console.error("Error creating member:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const fields = [
      "fullName",
      "mobileNumber",
      "email",
      "gender",
      "emergencyContactName",
      "emergencyContactNumber",
      "address",
      // "branch" is deliberately NOT updatable. A member belongs to the branch
      // they joined at, and moving them would retroactively move their payment
      // history with them, silently rewriting both branches' past revenue. A
      // genuine move is a new membership at the other branch.
      "planCode",
      "notes",
      "isActive",
    ];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) member[f] = req.body[f];
    });

    // An empty string from a cleared dropdown means "no trainer".
    if (req.body.trainerId !== undefined) {
      member.trainerId = req.body.trainerId || null;
    }

    // Same convention for the exercise plan: an empty string from the admin's
    // "Gym default plan" option means null, which is not "no plan" but "follow
    // whatever the gym default currently is" (see Member.workoutPlanId).
    if (req.body.workoutPlanId !== undefined) {
      member.workoutPlanId = req.body.workoutPlanId || null;
    }

    if (req.body.dateOfBirth !== undefined) {
      member.dateOfBirth = req.body.dateOfBirth
        ? new Date(req.body.dateOfBirth)
        : null;
    }
    if (req.body.startDate !== undefined) {
      member.startDate = new Date(req.body.startDate);
    }
    if (req.body.endDate !== undefined) {
      member.endDate = new Date(req.body.endDate);
    }
    if (req.body.totalFee !== undefined) {
      member.totalFee = Number(req.body.totalFee);
    }
    // Height drives BMI in the member portal. Coerced to a number because the
    // admin form sends strings, and cleared to null rather than 0 — an unknown
    // height must stay unknown, since 0 would produce an infinite BMI.
    if (req.body.heightCm !== undefined) {
      const h = Number(req.body.heightCm);
      member.heightCm = req.body.heightCm === "" || Number.isNaN(h) ? null : h;
    }

    if (req.files?.photo) {
      member.photo = await optimizeUpload(req.files.photo[0]);
    }
    if (req.files?.idProof) {
      member.idProof = await optimizeUpload(req.files.idProof[0]);
    }

    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Member updated successfully",
      data: member,
    });
  } catch (error) {
    console.error("Error updating member:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Renews in place: shifts the period forward and resets the fee for the new
 * cycle. Past payments are cleared because they belonged to the previous
 * period — the renewal starts a fresh balance.
 */
export const renewMembership = async (req, res) => {
  try {
    const { id } = req.params;
    const { planCode, startDate, endDate, totalFee, payment } = req.body;

    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    const plan = await MembershipPlan.findOne({
      code: planCode || member.planCode,
    });

    // A renewal normally starts the day after the current period ends, unless
    // the membership already lapsed — then it starts today.
    let start;
    if (startDate) {
      start = new Date(startDate);
    } else {
      const dayAfterExpiry = new Date(member.endDate);
      dayAfterExpiry.setDate(dayAfterExpiry.getDate() + 1);
      start = dayAfterExpiry > new Date() ? dayAfterExpiry : startOfToday();
    }

    member.planCode = planCode || member.planCode;
    member.startDate = start;
    member.endDate = endDate
      ? new Date(endDate)
      : addMonths(start, plan ? plan.months : 1);
    member.totalFee =
      totalFee !== undefined
        ? Number(totalFee)
        : plan?.defaultFee || member.totalFee;
    member.payments = [];
    member.isActive = true;

    if (payment && Number(payment.amount) > 0) {
      member.payments.push({
        amount: Number(payment.amount),
        paidOn: payment.paidOn ? new Date(payment.paidOn) : new Date(),
        mode: payment.mode || "Cash",
        receiptNo: payment.receiptNo || "",
        note: payment.note || "Renewal payment",
      });
    }

    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Membership renewed successfully",
      data: member,
    });
  } catch (error) {
    console.error("Error renewing membership:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const addPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, paidOn, mode, receiptNo, note } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "A payment amount greater than zero is required",
      });
    }

    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    member.payments.push({
      amount: Number(amount),
      paidOn: paidOn ? new Date(paidOn) : new Date(),
      mode: mode || "Cash",
      receiptNo: receiptNo || "",
      note: note || "",
    });

    await member.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Payment recorded successfully",
      data: member,
    });
  } catch (error) {
    console.error("Error adding payment:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteMember = async (req, res) => {
  try {
    const { id } = req.params;
    const member = await Member.findById(id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }

    await Member.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Member deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting member:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getMemberById = async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Member not found" });
    }
    return res.status(200).json({ isOk: true, status: 200, data: member });
  } catch (error) {
    console.error("Error fetching member:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listMembersByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, isActive, branch, status } =
      req.body;

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page))
      ? Number(per_page)
      : 10;

    const matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    // The client may still pass `branch` to narrow the view, but a branch
    // admin's own scope OVERRIDES it: resolveBranchFilter ignores the request
    // entirely for them and returns their branch. For a super admin it honours
    // whatever was asked, or "" for both branches.
    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) matchCondition.branch = effectiveBranch;

    const today = startOfToday();
    const in7Days = endOfDay(
      new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000),
    );

    if (status === "EXPIRING") {
      matchCondition.endDate = { $gte: today, $lte: in7Days };
    } else if (status === "EXPIRED") {
      matchCondition.endDate = { $lt: today };
    } else if (status === "ACTIVE") {
      matchCondition.endDate = { $gt: in7Days };
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { fullName: { $regex: escaped, $options: "i" } },
        { mobileNumber: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = [
      "fullName",
      "endDate",
      "startDate",
      "createdAt",
      "totalFee",
    ];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "endDate";
    const sortOrder = sortdir === "desc" ? -1 : 1;

    if (req.body.trainerId) matchCondition.trainerId = req.body.trainerId;

    const totalCount = await Member.countDocuments(matchCondition);
    const data = await Member.find(matchCondition)
      .populate("trainerId", "fullName mobileNumber branch")
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing members:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * Powers the dashboard. Returns headline counts plus the two actionable lists:
 * memberships lapsing inside 7 days, and members carrying an unpaid balance.
 */
export const getMemberDashboardStats = async (req, res) => {
  try {
    const today = startOfToday();
    const in7Days = endOfDay(
      new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000),
    );

    // Every figure on this dashboard is branch-scoped. This used to take no
    // request at all (`_req`) and so reported gym-wide totals to everyone —
    // a Vasna admin saw Gotri's member count, revenue and outstanding dues.
    const scope = scopeFilter(req);

    const [totalMembers, activeMembers, expiringSoon, expired] =
      await Promise.all([
        Member.countDocuments({ ...scope }),
        Member.countDocuments({
          ...scope,
          isActive: true,
          endDate: { $gte: today },
        }),
        Member.find({
          ...scope,
          isActive: true,
          endDate: { $gte: today, $lte: in7Days },
        })
          .sort({ endDate: 1 })
          .limit(50),
        Member.find({ ...scope, isActive: true, endDate: { $lt: today } })
          .sort({ endDate: 1 })
          .limit(50),
      ]);

    // "Payment due" = money outstanding for the current period. Computed in JS
    // because balance is a virtual derived from the payments subdocuments.
    const allActive = await Member.find({ ...scope, isActive: true });
    const paymentDue = allActive
      .filter((m) => m.balanceAmount > 0)
      .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
      .slice(0, 50)
      .map((m) => ({
        _id: m._id,
        fullName: m.fullName,
        mobileNumber: m.mobileNumber,
        branch: m.branch,
        planCode: m.planCode,
        endDate: m.endDate,
        totalFee: m.totalFee,
        paidAmount: m.paidAmount,
        balanceAmount: m.balanceAmount,
      }));

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const collectedThisMonth = allActive.reduce((sum, m) => {
      const monthPayments = (m.payments || []).filter(
        (p) => new Date(p.paidOn) >= monthStart,
      );
      return sum + monthPayments.reduce((s, p) => s + (p.amount || 0), 0);
    }, 0);

    const totalOutstanding = allActive.reduce(
      (sum, m) => sum + m.balanceAmount,
      0,
    );

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        counts: {
          totalMembers,
          activeMembers,
          expiringSoon: expiringSoon.length,
          expired: expired.length,
          paymentDue: paymentDue.length,
          collectedThisMonth,
          totalOutstanding,
        },
        expiringSoon,
        expired,
        paymentDue,
      },
    });
  } catch (error) {
    console.error("Error building member dashboard stats:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
