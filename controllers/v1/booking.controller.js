import mongoose from "mongoose";
import ClassSession from "../../models/ClassSession.js";
import Booking, { BOOKING_STATUSES } from "../../models/Booking.js";
import Lead from "../../models/Lead.js";
import Member from "../../models/Member.js";
import {
  reserveSeat,
  releaseSeat,
  RESERVE_ERRORS,
} from "../../services/bookingCapacity.js";
import { scopeFilter, resolveBranchFilter } from "../../middlewares/branchScope.js";
import { sendMail, getMailFromAddress } from "../../services/mailService.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const ok = (res, status, message, data) =>
  res.status(status).json({ isOk: true, status, message, data });

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ isOk: false, status, message, ...extra });

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * Hard ceiling on how long the booking-notification email may delay the response.
 *
 * Same reasoning, verbatim, as lead.controller.js's NOTIFY_TIMEOUT_MS: on Vercel
 * the function is FROZEN the moment the response is flushed, so a detached
 * promise is simply never resolved and the notification silently never arrives.
 * The send is therefore awaited, but behind a race with this timeout and with
 * every error swallowed — the booking itself is committed before the email is
 * even attempted.
 *
 * Shorter than the lead one (8 s) because a booking response also carries a
 * confirmation the visitor is waiting on.
 */
const NOTIFY_TIMEOUT_MS = 6000;

/** Escapes a value for interpolation into the notification email's HTML. */
const esc = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Tells the front desk somebody booked. Never throws — a dead SMTP server must
 * not turn a taken seat into a failed request, and the seat is already reserved
 * by the time this runs.
 *
 * @param {object} booking
 * @param {object} session
 * @returns {Promise<void>}
 */
const notifyNewBooking = async (booking, session) => {
  try {
    const to = process.env.LEAD_NOTIFY_TO?.trim() || (await getMailFromAddress());
    if (!to) {
      console.warn("⚠️ Booking notification skipped — no EmailSetup configured");
      return;
    }

    const rows = [
      ["Class", session.title],
      ["When", new Date(session.start).toISOString()],
      ["Branch", session.branch],
      ["Name", booking.name],
      ["Phone", booking.phone],
      ["Email", booking.email || "—"],
      ["Booked as", booking.member ? "Member" : "Prospect (free trial)"],
      ["Seats left", String(Math.max(0, session.capacity - session.bookedCount))],
    ]
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 12px;font-weight:600;">${esc(label)}</td><td style="padding:6px 12px;">${esc(value)}</td></tr>`,
      )
      .join("");

    await Promise.race([
      sendMail({
        to,
        fromName: "Mid City Gym Website",
        subject: `New class booking — ${session.title} (${booking.name})`,
        text:
          `New class booking\n\n` +
          `Class: ${session.title}\nWhen: ${new Date(session.start).toISOString()}\n` +
          `Branch: ${session.branch}\nName: ${booking.name}\nPhone: ${booking.phone}\n` +
          `Email: ${booking.email || "-"}\n`,
        html:
          `<h2 style="font-family:sans-serif;">New class booking</h2>` +
          `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">${rows}</table>`,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`booking notification timed out after ${NOTIFY_TIMEOUT_MS}ms`)),
          NOTIFY_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  } catch (err) {
    console.error(
      `❌ Booking notification failed for booking ${booking?._id} — the booking IS saved:`,
      err.message,
    );
  }
};

/**
 * ============================================================================
 * THE SHARED BOOKING PATH. BOTH ENTRY POINTS GO THROUGH IT.
 * ============================================================================
 * Reserve the seat, THEN write the row, and give the seat back on every failure
 * after the reservation. services/bookingCapacity.js explains why that order
 * and not the other one (a crash mid-way leaves the class one seat under-full
 * rather than oversold).
 *
 * @param {object} args
 * @param {object} args.session        the ClassSession document
 * @param {object} args.subject        `{ member }` or `{ lead }` — exactly one
 * @param {object} args.identity       { name, phone, email } as given at booking time
 * @param {string} args.source         WEBSITE | PORTAL | ADMIN
 * @returns {Promise<{ok: true, booking: object, session: object} | {ok: false, code: string, message: string}>}
 */
const takeSeatAndBook = async ({ session, subject, identity, source }) => {
  const subjectFilter = subject.member
    ? { session: session._id, member: subject.member }
    : { session: session._id, lead: subject.lead };

  /**
   * FAST PATH ONLY — this read decides nothing.
   *
   * It exists so the common "I already booked" case answers immediately without
   * touching the counter. It is a read-then-write and it loses a race exactly
   * the way a capacity read would; the unique index on models/Booking.js is
   * what actually guarantees one row per person per class, and the E11000
   * branch below is the path that a lost race takes.
   */
  const existing = await Booking.findOne(subjectFilter).lean();
  if (existing && existing.status !== "CANCELLED") {
    return {
      ok: false,
      code: "ALREADY_BOOKED",
      message: "You have already booked this class.",
      booking: existing,
    };
  }

  // ---- THE ATOMIC BIT ----
  const reserved = await reserveSeat(ClassSession, session._id, new Date());
  if (!reserved.ok) {
    if (reserved.code === RESERVE_ERRORS.FULL) {
      return {
        ok: false,
        code: "FULL",
        message: "This class is fully booked. Please pick another slot.",
      };
    }
    if (reserved.code === RESERVE_ERRORS.NOT_FOUND) {
      return { ok: false, code: "NOT_FOUND", message: "Class not found." };
    }
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "This class is no longer open for booking.",
    };
  }
  const freshSession = reserved.session;

  const payload = {
    ...subjectFilter,
    name: identity.name,
    phone: identity.phone,
    email: identity.email || "",
    status: "BOOKED",
    source,
    branch: freshSession.branch,
    sessionStart: freshSession.start,
    cancelledAt: null,
    cancelReason: "",
  };

  try {
    /**
     * REVIVE BEFORE INSERT.
     *
     * The unique index covers CANCELLED rows too (models/Booking.js explains
     * why it must), so somebody who books, cancels and rebooks cannot be given a
     * second row. Reviving is also the better history: one row per (person,
     * class) that you can read, instead of three rows for one seat.
     *
     * Conditional on `status: "CANCELLED"` so it is itself race-safe — two
     * simultaneous rebookings cannot both revive the same row, and the loser
     * falls through to the insert and is caught by the index.
     */
    const revived = await Booking.findOneAndUpdate(
      { ...subjectFilter, status: "CANCELLED" },
      { $set: payload },
      { new: true },
    );
    if (revived) return { ok: true, booking: revived, session: freshSession };

    const booking = await Booking.create(payload);
    return { ok: true, booking, session: freshSession };
  } catch (error) {
    // Give the seat back. Every failure after the reservation must pass here,
    // or the class silently loses a seat for good.
    await releaseSeat(ClassSession, session._id);

    if (error?.code === 11000) {
      return {
        ok: false,
        code: "ALREADY_BOOKED",
        message: "You have already booked this class.",
      };
    }
    throw error;
  }
};

/**
 * Loads a session for booking and says why it cannot be booked, in words.
 *
 * The authoritative check is the atomic reservation, not this — this only
 * produces a good error before a seat is touched. A session that passes here
 * and fails there is the concurrency case, and it is handled.
 */
const loadBookableSession = async (id) => {
  if (!mongoose.isValidObjectId(id)) {
    return { error: { status: 400, message: "Invalid class id" } };
  }
  const session = await ClassSession.findById(id);
  if (!session || !session.isActive) {
    return { error: { status: 404, message: "Class not found" } };
  }
  if (new Date(session.start) <= new Date()) {
    return {
      error: { status: 409, message: "This class has already started.", code: "PAST" },
    };
  }
  return { session };
};

/**
 * PUBLIC — a prospect books a free trial from the marketing site.
 *
 * Unauthenticated by necessity: the whole point is that somebody who has never
 * walked in can reserve a place. The route in front of this applies
 * authRateLimiter and the field validators; the two defences that live HERE are
 * the honeypot and the fact that nothing from the body is ever spread into a
 * model — same shape as lead.controller.js's createPublicLead.
 *
 * A `Lead` is created (or reused, by phone) rather than a Member. models/Lead.js
 * explains why: a half-populated Member for every trial booking would poison
 * every member count, renewal report and attendance denominator in the system.
 *
 * POST /api/v1/classes/:id/book
 */
export const createPublicBooking = async (req, res) => {
  try {
    const { name, phone, email, website } = req.body || {};

    // HONEYPOT. `website` is rendered hidden and left empty by a human; bots
    // fill every input they find. Answering 201 rather than 4xx is the point: a
    // bot that is told it failed retunes and retries, whereas one that is told
    // it succeeded moves on. Nothing is written and NO SEAT IS TAKEN — which
    // matters more here than on the contact form, because a spam run against
    // this endpoint would otherwise fill every class in the timetable.
    if (typeof website === "string" && website.trim() !== "") {
      console.warn("[SECURITY] Booking honeypot triggered — submission discarded");
      return ok(res, 201, "Thanks — your place is booked. See you there!", null);
    }

    const { session, error } = await loadBookableSession(req.params.id);
    if (error) return fail(res, error.status, error.message, error.code ? { code: error.code } : {});

    if (!session.allowGuests) {
      return fail(
        res,
        403,
        "This class is for members only. Please sign in to the member portal to book.",
        { code: "MEMBERS_ONLY" },
      );
    }

    const safeName = String(name).trim().slice(0, 100);
    const safePhone = String(phone).trim().slice(0, 20);
    const safeEmail = typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";

    /**
     * One Lead per phone number, reused across bookings.
     *
     * Not `create()` every time: somebody who books two classes is one
     * prospect, and two Lead rows would show the front desk two people to call.
     * Reusing also makes the `{ session, lead }` unique index meaningful — it is
     * what stops the same phone number taking two seats in one class.
     */
    let lead = await Lead.findOne({ phone: safePhone });
    if (!lead) {
      lead = await Lead.create({
        name: safeName,
        phone: safePhone,
        email: safeEmail,
        source: "BOOKING",
        status: "NEW",
        branch: session.branch,
        message: `Booked: ${session.title} on ${new Date(session.start).toISOString()}`,
      });
    }

    const result = await takeSeatAndBook({
      session,
      subject: { lead: lead._id },
      identity: { name: safeName, phone: safePhone, email: safeEmail },
      source: "WEBSITE",
    });

    if (!result.ok) {
      const status = result.code === "FULL" || result.code === "ALREADY_BOOKED" ? 409 : 404;
      return fail(res, status, result.message, { code: result.code });
    }

    await notifyNewBooking(result.booking, result.session);

    return ok(res, 201, "Thanks — your place is booked. See you there!", {
      // Only the id and the human-readable details go back. The public caller
      // has no business reading the stored row.
      id: result.booking._id,
      title: result.session.title,
      start: result.session.start,
      branch: result.session.branch,
    });
  } catch (error) {
    console.error("Error creating public booking:", error);
    return fail(res, 500, "Could not book your place. Please try again.");
  }
};

/**
 * MEMBER PORTAL — a signed-in member books a class.
 *
 * `req.member.id` comes from the VERIFIED JWT (requireMember), never from the
 * body or the path: a booking is a claim about who is coming, so the member
 * must be identified by their token. Same rule attendance.controller.js follows.
 *
 * POST /api/v1/member-portal/classes/:id/book
 */
export const createMemberBooking = async (req, res) => {
  try {
    const { session, error } = await loadBookableSession(req.params.id);
    if (error) return fail(res, error.status, error.message, error.code ? { code: error.code } : {});

    const member = await Member.findById(req.member.id).select(
      "fullName mobileNumber email branch isActive",
    );
    if (!member || member.isActive === false) {
      return fail(res, 403, "Your membership is not active. Please see reception.", {
        code: "INACTIVE",
      });
    }

    /**
     * DELIBERATELY NOT GATED ON SUBSCRIPTION EXPIRY OR BALANCE.
     *
     * services/attendanceEligibility.js denies a check-in for those, because a
     * check-in is a claim about training TODAY on a membership that has lapsed.
     * A booking is a claim about a future slot — and somebody whose membership
     * expires next week booking a class the week after is exactly the person the
     * gym wants to keep. Refusing them at the booking form, with nobody there to
     * explain, would lose the renewal the reminder emails are trying to win.
     * The front desk sees the expiry on the roster and can have the conversation.
     */
    const result = await takeSeatAndBook({
      session,
      subject: { member: member._id },
      identity: {
        name: member.fullName,
        phone: member.mobileNumber,
        email: member.email || "",
      },
      source: "PORTAL",
    });

    if (!result.ok) {
      const status = result.code === "FULL" || result.code === "ALREADY_BOOKED" ? 409 : 404;
      return fail(res, status, result.message, { code: result.code });
    }

    return ok(res, 201, "Booked. See you there!", {
      id: result.booking._id,
      title: result.session.title,
      start: result.session.start,
      branch: result.session.branch,
    });
  } catch (error) {
    console.error("Error creating member booking:", error);
    return fail(res, 500, "Could not book your place. Please try again.");
  }
};

/**
 * MEMBER PORTAL — the member's own bookings.
 *
 * Filtered on `req.member.id` from the token. There is no `memberId` parameter
 * and there must never be one.
 *
 * GET /api/v1/member-portal/bookings
 */
export const listMyBookings = async (req, res) => {
  try {
    const upcomingOnly = req.query?.upcoming === "true";
    const filter = { member: req.member.id };
    if (upcomingOnly) {
      filter.sessionStart = { $gte: new Date() };
      filter.status = "BOOKED";
    }

    const bookings = await Booking.find(filter)
      .populate("session", "title start durationMinutes branch isActive")
      .sort({ sessionStart: -1 })
      .limit(100)
      .lean();

    return ok(res, 200, "Bookings fetched successfully", bookings);
  } catch (error) {
    console.error("Error listing member bookings:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * MEMBER PORTAL — cancel my own booking.
 *
 * ============================================================================
 * THE CANCELLATION IS A CONDITIONAL UPDATE, FOR THE SAME REASON THE BOOKING IS.
 * ============================================================================
 * Reading the booking, seeing BOOKED, writing CANCELLED and then decrementing
 * the counter releases TWO seats when the member double-taps Cancel — the
 * second pass reads the row it has not finished writing yet. So the status
 * change is `{ _id, member, status: "BOOKED" } -> CANCELLED` in one operation,
 * and the seat is released ONLY when that operation returned a document. The
 * second tap matches nothing, releases nothing, and answers "already cancelled".
 *
 * POST /api/v1/member-portal/bookings/:id/cancel
 */
export const cancelMyBooking = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return fail(res, 400, "Invalid booking id");

    const cancelled = await Booking.findOneAndUpdate(
      // `member` is in the FILTER, not checked afterwards: a member must not be
      // able to cancel somebody else's place by guessing an id.
      { _id: id, member: req.member.id, status: "BOOKED" },
      {
        $set: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelReason: String(req.body?.reason || "Cancelled by member").slice(0, 200),
        },
      },
      { new: true },
    );

    if (!cancelled) {
      return fail(res, 404, "No active booking of yours matches that id.", {
        code: "NOT_BOOKED",
      });
    }

    await releaseSeat(ClassSession, cancelled.session);

    return ok(res, 200, "Booking cancelled.", { id: cancelled._id });
  } catch (error) {
    console.error("Error cancelling member booking:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — bookings across classes, house `…-by-params` convention.
 *
 * BRANCH SCOPING reads the booking's own denormalised `branch` (copied from the
 * session on write — see models/Booking.js) so no $lookup is needed and the
 * scope cannot be lost in a join. Spread LAST, as always.
 *
 * POST /api/v1/class-bookings-by-params
 */
export const listBookingsByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, status, branch, session, fromDate, toDate } =
      req.body || {};

    const safeSkip = Math.max(0, toInt(skip, 0));
    const safePerPage = Math.min(Math.max(toInt(per_page, 20), 1), 200);

    const matchCondition = {};

    const safeStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
    if (safeStatus && BOOKING_STATUSES.includes(safeStatus)) {
      matchCondition.status = safeStatus;
    }

    if (typeof session === "string" && mongoose.isValidObjectId(session)) {
      matchCondition.session = session;
    }

    const from = fromDate ? new Date(fromDate) : null;
    const to = toDate ? new Date(toDate) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      matchCondition.sessionStart = {};
      if (from && !Number.isNaN(from.getTime())) matchCondition.sessionStart.$gte = from;
      if (to && !Number.isNaN(to.getTime())) matchCondition.sessionStart.$lte = to;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }

    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) matchCondition.branch = effectiveBranch;

    const allowed = ["sessionStart", "name", "status", "createdAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "sessionStart";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await Booking.countDocuments(matchCondition);
    const data = await Booking.find(matchCondition)
      .populate("session", "title start branch")
      .populate("member", "fullName mobileNumber endDate")
      .populate("lead", "name phone status")
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage)
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [{ count: totalCount, data }],
    });
  } catch (error) {
    console.error("Error listing bookings:", error);
    return fail(res, 500, "Internal server error");
  }
};

/**
 * ADMIN — mark a booking ATTENDED / NO_SHOW / CANCELLED, or reinstate it.
 *
 * ============================================================================
 * EVERY TRANSITION THAT MOVES A SEAT IS A CONDITIONAL UPDATE.
 * ============================================================================
 * Three cases, and only two of them touch the counter:
 *
 *   -> ATTENDED / NO_SHOW   The class happened. The seat was used either way,
 *                           so the counter does NOT change. Marking a no-show
 *                           must not free a seat in a class that is over.
 *   -> CANCELLED            The seat comes back, but ONLY if the row was
 *                           actually BOOKED a moment ago — the conditional
 *                           update is what makes a double submit release one
 *                           seat rather than two.
 *   -> BOOKED (reinstate)   A seat has to be TAKEN again, and it may not be
 *                           available any more. So it is reserved first, and
 *                           released again if the status update then loses its
 *                           own race. A reinstatement is the one admin action
 *                           that can legitimately fail with "class is full".
 *
 * PUT /api/v1/class-bookings/:id
 */
export const updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return fail(res, 400, "Invalid booking id");

    const requested = String(req.body?.status || "").trim().toUpperCase();
    if (!BOOKING_STATUSES.includes(requested)) {
      return fail(res, 400, `status must be one of: ${BOOKING_STATUSES.join(", ")}`);
    }

    // scopeFilter spread LAST — a Gotri admin gets a 404 on a Vasna booking
    // rather than a silent cross-branch write.
    const booking = await Booking.findOne({ _id: id, ...scopeFilter(req) }).lean();
    if (!booking) return fail(res, 404, "Booking not found");

    if (booking.status === requested) {
      return ok(res, 200, `Booking is already ${requested}.`, booking);
    }

    const actor = req.session?.user?.id || null;
    const reason = String(req.body?.reason || "").trim().slice(0, 200);

    // ---- Reinstating: take a seat BEFORE changing the status ----
    if (requested === "BOOKED") {
      const reserved = await reserveSeat(ClassSession, booking.session, new Date());
      if (!reserved.ok) {
        return fail(
          res,
          409,
          reserved.code === RESERVE_ERRORS.FULL
            ? "That class is now full — a seat would have to be freed first."
            : "That class is no longer open for booking.",
          { code: reserved.code },
        );
      }
      const reinstated = await Booking.findOneAndUpdate(
        { _id: id, status: { $ne: "BOOKED" } },
        {
          $set: {
            status: "BOOKED",
            cancelledAt: null,
            cancelReason: "",
            markedBy: actor,
            markedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!reinstated) {
        // Somebody else got there first; the seat we took is not ours to keep.
        await releaseSeat(ClassSession, booking.session);
        return fail(res, 409, "That booking changed while you were editing it.", {
          code: "CONFLICT",
        });
      }
      return ok(res, 200, "Booking reinstated.", reinstated);
    }

    // ---- Cancelling: release ONLY if this call is the one that cancelled it ----
    if (requested === "CANCELLED") {
      const cancelled = await Booking.findOneAndUpdate(
        { _id: id, status: "BOOKED" },
        {
          $set: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelReason: reason || "Cancelled by staff",
            markedBy: actor,
            markedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!cancelled) {
        return fail(res, 409, "That booking is no longer active.", { code: "CONFLICT" });
      }
      await releaseSeat(ClassSession, cancelled.session);
      return ok(res, 200, "Booking cancelled.", cancelled);
    }

    // ---- ATTENDED / NO_SHOW: no seat movement, see the header ----
    const marked = await Booking.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: requested,
          markedBy: actor,
          markedAt: new Date(),
          ...(reason ? { cancelReason: reason } : {}),
        },
      },
      { new: true },
    );
    return ok(res, 200, `Booking marked ${requested}.`, marked);
  } catch (error) {
    console.error("Error updating booking:", error);
    return fail(res, 500, error.message || "Internal server error");
  }
};
