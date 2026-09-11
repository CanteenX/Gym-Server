import BodyMetric from "../../models/BodyMetric.js";
import Member from "../../models/Member.js";

/**
 * Member-portal body metrics (weight log).
 *
 * Every handler here scopes its query by req.member.id, which requireMember
 * derives from the verified token. No handler accepts a memberId from the
 * client — that would let any logged-in member read or write another's log.
 */

/** Midnight local, so a weigh-in belongs to a day rather than an instant. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

/** BMI needs height, which lives on the member record and is often unset. */
const computeBmi = (weightKg, heightCm) => {
  if (!weightKg || !heightCm || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
};

/**
 * Record (or correct) today's weight.
 * Upserts on {memberId, recordedOn} so a second weigh-in the same day replaces
 * the first rather than adding a duplicate point.
 */
export const recordWeight = async (req, res) => {
  try {
    const { weightKg, recordedOn, note } = req.body;

    const weight = Number(weightKg);
    if (!weight || Number.isNaN(weight)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Weight is required",
      });
    }
    if (weight < 20 || weight > 400) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Please enter a weight between 20 and 400 kg",
      });
    }

    const day = startOfDay(recordedOn);
    if (!day) {
      return res
        .status(400)
        .json({ isOk: false, status: 400, message: "Invalid date" });
    }

    // Recording a weigh-in for a future date would put a point beyond "today"
    // on the chart and break the 15-day window's meaning.
    const today = startOfDay();
    if (day > today) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "You can't record a weight for a future date",
      });
    }

    const entry = await BodyMetric.findOneAndUpdate(
      { memberId: req.member.id, recordedOn: day },
      {
        $set: {
          weightKg: weight,
          note: String(note || "").trim(),
        },
        $setOnInsert: { memberId: req.member.id, recordedOn: day },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Weight recorded",
      data: entry,
    });
  } catch (error) {
    console.error("Record weight error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/**
 * The weight log for a trailing window (default 15 days).
 *
 * Returns the raw entries only — days with no weigh-in are simply absent, and
 * the chart renders those as gaps rather than inventing a value. Summary stats
 * come back alongside so the page doesn't recompute them.
 */
export const listWeights = async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 15, 1), 365);

    const since = startOfDay();
    since.setDate(since.getDate() - (days - 1));

    const entries = await BodyMetric.find({
      memberId: req.member.id,
      recordedOn: { $gte: since },
    })
      .sort({ recordedOn: 1 })
      .lean();

    // Height is on the member record, so BMI is derived here rather than
    // stored — a corrected height should fix every past BMI, not just new ones.
    const member = await Member.findById(req.member.id).select("heightCm");
    const heightCm = member?.heightCm || null;

    const latest = entries.length ? entries[entries.length - 1] : null;
    const first = entries.length ? entries[0] : null;

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        days,
        from: since,
        heightCm,
        entries: entries.map((e) => ({
          _id: e._id,
          weightKg: e.weightKg,
          recordedOn: e.recordedOn,
          note: e.note,
        })),
        latestWeightKg: latest ? latest.weightKg : null,
        latestBmi: latest ? computeBmi(latest.weightKg, heightCm) : null,
        // Net movement across the window. Null with fewer than two points,
        // because a single reading shows no trend.
        changeKg:
          entries.length > 1
            ? Math.round((latest.weightKg - first.weightKg) * 10) / 10
            : null,
      },
    });
  } catch (error) {
    console.error("List weights error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

/** Remove one of the member's own entries. */
export const deleteWeight = async (req, res) => {
  try {
    // Scoped by memberId as well as _id: without it, a guessed id from another
    // member's log would delete successfully.
    const deleted = await BodyMetric.findOneAndDelete({
      _id: req.params.id,
      memberId: req.member.id,
    });

    if (!deleted) {
      return res
        .status(404)
        .json({ isOk: false, status: 404, message: "Entry not found" });
    }

    return res
      .status(200)
      .json({ isOk: true, status: 200, message: "Entry removed" });
  } catch (error) {
    console.error("Delete weight error:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
