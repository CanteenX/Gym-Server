import mongoose from "mongoose";
import Lead, { LEAD_SOURCES, LEAD_STATUSES } from "../../models/Lead.js";
import Branch from "../../models/Branch.js";
import Employee from "../../models/Employee.js";
import { resolveBranchFilter, scopeFilter, scopedBranch } from "../../middlewares/branchScope.js";
import { sendMail, getMailFromAddress } from "../../services/mailService.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Hard ceiling on how long the lead-notification email may delay the response.
 *
 * WHY AWAIT AT ALL: the obvious answer is fire-and-forget. That is wrong on
 * Vercel — the function is frozen the moment the response is flushed, so a
 * detached promise is simply never resolved and the notification silently never
 * arrives. So the send IS awaited, but behind a race with this timeout and with
 * every error swallowed: worst case the visitor waits this long and still gets
 * a success; the lead itself is already committed before the email is even
 * attempted.
 */
const NOTIFY_TIMEOUT_MS = 8000;

/** Escapes a value for interpolation into the notification email's HTML. */
const esc = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Where internal lead alerts go.
 *
 * Defaults to the address the mail is SENT from — whoever owns the sending
 * account is by definition the person watching that inbox — so there is no
 * address hardcoded in the source. Override per-deployment with LEAD_NOTIFY_TO.
 *
 * @returns {Promise<string|null>}
 */
const notifyRecipient = async () =>
  process.env.LEAD_NOTIFY_TO?.trim() || (await getMailFromAddress());

/**
 * Sends the "new enquiry" alert. Never throws — a dead SMTP server must not
 * turn a captured lead into a failed one.
 *
 * @param {object} lead - the saved Lead document
 * @returns {Promise<void>}
 */
const notifyNewLead = async (lead) => {
  try {
    const to = await notifyRecipient();
    if (!to) {
      console.warn("⚠️ Lead notification skipped — no EmailSetup configured");
      return;
    }

    const rows = [
      ["Name", lead.name],
      ["Phone", lead.phone],
      ["Email", lead.email || "—"],
      ["Branch", lead.branch || "Not specified"],
      ["Source", lead.source],
      ["Message", lead.message || "—"],
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
        subject: `New website enquiry — ${lead.name}`,
        text:
          `New enquiry from the Mid City Gym website\n\n` +
          `Name: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email || "-"}\n` +
          `Branch: ${lead.branch || "Not specified"}\nSource: ${lead.source}\n\n` +
          `Message:\n${lead.message || "-"}\n`,
        html:
          `<h2 style="font-family:sans-serif;">New website enquiry</h2>` +
          `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">${rows}</table>` +
          `<p style="font-family:sans-serif;font-size:12px;color:#666;">Received ${esc(new Date(lead.createdAt).toISOString())}</p>`,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`lead notification timed out after ${NOTIFY_TIMEOUT_MS}ms`)),
          NOTIFY_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  } catch (err) {
    // Logged, never rethrown — see NOTIFY_TIMEOUT_MS above. The lead row is the
    // durable record; the email is a convenience on top of it.
    console.error(
      `❌ Lead notification failed for lead ${lead?._id} — the lead IS saved:`,
      err.message,
    );
  }
};

/**
 * Keeps a client-supplied branch honest without hardcoding "Vasna"/"Gotri".
 *
 * The branch on a lead is a visitor's stated preference, so it cannot come from
 * a session — but it is also what branch-scoping later filters on, so an
 * arbitrary string would create leads no admin can ever see. Unknown or
 * non-physical values are dropped to null (visible to super admins) rather than
 * rejected: a mistyped branch must not lose the enquiry.
 *
 * @param {unknown} requested
 * @returns {Promise<string|null>}
 */
const normaliseBranch = async (requested) => {
  const asked = typeof requested === "string" ? requested.trim() : "";
  if (!asked) return null;

  const branch = await Branch.findOne({
    name: asked,
    isActive: true,
    isPhysical: true,
  })
    .select("name")
    .lean();

  return branch?.name || null;
};

/**
 * PUBLIC — the website contact form.
 *
 * Unauthenticated by necessity (a prospective member has no account), so the
 * route in front of this applies authRateLimiter and the field validators. The
 * two defences that live HERE are the honeypot and the fact that nothing from
 * the body is ever spread into the model.
 *
 * POST /api/v1/site/leads
 */
export const createPublicLead = async (req, res) => {
  try {
    const { name, phone, email, message, source, branch, website } = req.body || {};

    // HONEYPOT. `website` is rendered hidden and left empty by a human; bots
    // fill every input they find. Answering 200 rather than 4xx is the point:
    // a bot that is told it failed retunes and retries, whereas one that is
    // told it succeeded moves on. Nothing is written.
    if (typeof website === "string" && website.trim() !== "") {
      console.warn("[SECURITY] Lead honeypot triggered — submission discarded");
      return res.status(201).json({
        isOk: true,
        status: 201,
        message: "Thanks — we'll be in touch shortly.",
        data: null,
      });
    }

    const safeSource =
      typeof source === "string" && LEAD_SOURCES.includes(source.trim().toUpperCase())
        ? source.trim().toUpperCase()
        : "WEBSITE";

    const lead = new Lead({
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: typeof email === "string" ? email.trim() : "",
      message: typeof message === "string" ? message.trim() : "",
      source: safeSource,
      branch: await normaliseBranch(branch),
      status: "NEW",
    });

    // Committed BEFORE the notification is attempted, so no email failure can
    // lose the enquiry.
    await lead.save();

    await notifyNewLead(lead);

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Thanks — we'll be in touch shortly.",
      // Only the id goes back: the public caller has no business reading the
      // stored row, and echoing it would confirm to a scraper what was kept.
      data: { id: lead._id },
    });
  } catch (error) {
    console.error("Error creating lead:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Could not submit your enquiry. Please try again.",
    });
  }
};

/**
 * ADMIN — the lead inbox, house `…-by-params` convention.
 *
 * BRANCH SCOPING: resolveBranchFilter reads req.session.user (NOT req.user,
 * which carries no branch — see middlewares/branchScope.js) and ignores any
 * client-supplied branch for a branch admin. A lead with branch null — the
 * visitor did not say which gym — stays visible to super admins only, because
 * there is no branch to attribute it to and showing it to both would double-
 * count every unattributed enquiry.
 */
export const listLeadsByParams = async (req, res) => {
  try {
    const { skip, per_page, sorton, sortdir, match, status, branch, assignedTo } =
      req.body || {};

    const safeSkip = Number.isFinite(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isFinite(Number(per_page)) ? Number(per_page) : 10;

    const matchCondition = {};

    const safeStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
    if (safeStatus && LEAD_STATUSES.includes(safeStatus)) {
      matchCondition.status = safeStatus;
    }

    if (typeof assignedTo === "string" && mongoose.isValidObjectId(assignedTo)) {
      matchCondition.assignedTo = assignedTo;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
        { message: { $regex: escaped, $options: "i" } },
      ];
    }

    // Applied LAST so it is authoritative over anything above.
    //
    // Unattributed leads are included deliberately. A website visitor rarely
    // says which gym they mean, so `branch: null` is the COMMON case, not the
    // edge case - and scoping it away would leave branch staff staring at an
    // empty inbox while enquiries went unanswered waiting for a super admin to
    // notice. Whoever is on duty can work them; assigning or setting a branch
    // is what narrows a lead to one side.
    //
    // Combined with $and because the free-text search above already owns $or,
    // and a second top-level $or would silently replace it.
    const effectiveBranch = resolveBranchFilter(req, branch);
    if (effectiveBranch) {
      const branchClause = {
        $or: [
          { branch: effectiveBranch },
          { branch: null },
          { branch: { $exists: false } },
        ],
      };
      if (matchCondition.$or) {
        matchCondition.$and = [{ $or: matchCondition.$or }, branchClause];
        delete matchCondition.$or;
      } else {
        Object.assign(matchCondition, branchClause);
      }
    }

    const allowed = ["name", "status", "branch", "createdAt", "updatedAt"];
    const safeSortField = allowed.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await Lead.countDocuments(matchCondition);
    const data = await Lead.find(matchCondition)
      .populate("assignedTo", "employeeName emailOffice branch")
      .populate("notes.by", "employeeName")
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
    console.error("Error listing leads by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: "Internal server error",
    });
  }
};

/**
 * ADMIN — change status, assign an owner, and/or append a note.
 *
 * The lookup is scoped, so a Gotri admin editing a Vasna lead id gets a 404
 * rather than a silent cross-branch write. The note author comes from the
 * session, never the body — a staff member cannot file a note under somebody
 * else's name.
 *
 * Unattributed leads (branch null) are editable by any branch, matching what
 * the inbox lists. Listing a lead that then 404s on the first status change
 * would be worse than hiding it outright.
 *
 * PUT /api/v1/site/leads/:id
 */
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Invalid lead id",
      });
    }

    // scopeFilter yields {} for a super admin and { branch: "X" } otherwise;
    // widen the latter to include unattributed leads so the inbox and the
    // actions on it agree.
    const scope = scopeFilter(req);
    const lead = await Lead.findOne(
      scope.branch
        ? {
            _id: id,
            $or: [
              { branch: scope.branch },
              { branch: null },
              { branch: { $exists: false } },
            ],
          }
        : { _id: id, ...scope },
    );
    if (!lead) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Lead not found",
      });
    }

    const { status, assignedTo, note } = req.body || {};

    // All three fields are optional and only the ones PRESENT are applied. An
    // empty string means "the form did not change this", not "clear it" — the
    // one exception is assignedTo below, where "" is the unassign signal,
    // because a select element has no other way to say "nobody".
    if (status !== undefined && status !== null && String(status).trim() !== "") {
      const safeStatus = String(status).trim().toUpperCase();
      if (!LEAD_STATUSES.includes(safeStatus)) {
        return res.status(400).json({
          isOk: false,
          status: 400,
          message: `Status must be one of: ${LEAD_STATUSES.join(", ")}`,
        });
      }
      lead.status = safeStatus;
    }

    if (assignedTo !== undefined) {
      if (assignedTo === null || assignedTo === "") {
        lead.assignedTo = null;
      } else {
        if (!mongoose.isValidObjectId(assignedTo)) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: "assignedTo must be a valid employee id",
          });
        }
        const employee = await Employee.findById(assignedTo).select("branch").lean();
        if (!employee) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            message: "Assigned employee not found",
          });
        }
        // A branch admin may only hand a lead to someone who can actually see
        // it: their own branch, or an unrestricted (super admin) account.
        const own = scopedBranch(req);
        if (own && employee.branch && employee.branch !== own) {
          return res.status(403).json({
            isOk: false,
            status: 403,
            message: "Cannot assign a lead to staff from another branch",
          });
        }
        lead.assignedTo = assignedTo;
      }
    }

    const safeNote = typeof note === "string" ? note.trim() : "";
    if (safeNote) {
      // Append-only: notes are a call log, not editable text (see models/Lead.js).
      lead.notes.push({
        text: safeNote.slice(0, 2000),
        by: req.session?.user?.id || null,
        at: new Date(),
      });
    }

    await lead.save();

    const data = await Lead.findById(lead._id)
      .populate("assignedTo", "employeeName emailOffice branch")
      .populate("notes.by", "employeeName")
      .lean();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Lead updated successfully",
      data,
    });
  } catch (error) {
    console.error("Error updating lead:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
