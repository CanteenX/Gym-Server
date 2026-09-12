import mongoose from "mongoose";

/** Where a lead came from. */
export const LEAD_SOURCES = ["WEBSITE", "CONTACT_FORM", "BOOKING"];

/** The pipeline a lead moves through. Terminal states are CONVERTED / CLOSED. */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "CONVERTED", "CLOSED"];

/**
 * An enquiry from the public website — the top of the sales funnel, before
 * anyone becomes a `Member`.
 *
 * DELIBERATELY NOT A Member: a lead has no plan, no payment, no branch
 * obligation and may never convert. Creating a half-populated Member row for
 * every contact-form submission would poison every member count, every renewal
 * report and every attendance denominator in the system. Conversion is an
 * explicit act that creates a Member and sets status to CONVERTED here.
 *
 * BRANCH: optional and client-supplied, because the person filling in the form
 * is telling us which gym they are interested in — it is a preference, not an
 * authorization fact. It IS however what branch-scoping filters on afterwards,
 * so a Gotri admin only works their own enquiries. A lead with no branch is
 * visible to super admins only (see the list controller for why).
 *
 * NOTES ARE APPEND-ONLY: a note records what was said on a call. Editing or
 * deleting one rewrites history that a later dispute depends on, so the update
 * endpoint only ever pushes.
 */
const LeadNoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    /** Which staff member wrote it — taken from the session, never the body. */
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const LeadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    /**
     * The only reliable way to reach a gym enquiry in Vadodara — email is
     * frequently left blank, which is why phone (not email) is the required
     * field here, mirroring Member.
     */
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    message: {
      type: String,
      trim: true,
      default: "",
    },
    source: {
      type: String,
      enum: LEAD_SOURCES,
      default: "WEBSITE",
    },
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "NEW",
    },
    /**
     * Plain string, matching Member.branch / Trainer.branch / Employee.branch.
     * branchScope.js compares it literally; see models/Branch.js for why these
     * are strings rather than references.
     */
    branch: {
      type: String,
      trim: true,
      default: null,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    notes: {
      type: [LeadNoteSchema],
      default: [],
    },
  },
  { timestamps: true },
);

/** The inbox view: newest first, filtered by status and/or branch. */
LeadSchema.index({ status: 1, createdAt: -1 });
LeadSchema.index({ branch: 1, createdAt: -1 });

export default mongoose.model("Lead", LeadSchema);
