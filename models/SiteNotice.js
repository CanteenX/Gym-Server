import mongoose from "mongoose";
import { liveWindowFilter, isCurrentlyLive, liveStatus } from "./liveWindow.js";

/**
 * The gym talking to its members, and the gym selling to them — two things that
 * are emphatically NOT adverts.
 *
 * WHY THIS COLLECTION EXISTS, and it is a real incident rather than a tidiness
 * argument. The owner needed to tell members the gym was shut for Ganesh
 * Chaturthi, and the only scheduled, self-expiring content type on the site was
 * Advertisement. So the closure notice was created as an advert, and the site
 * rendered it exactly as it was asked to: a small 16:9 creative card, under a
 * heading that said "Sponsored". Right pipeline, wrong vehicle. Nothing was
 * broken; the model simply had no word for what the owner was doing.
 *
 * The three things are distinct in WHO IS SPEAKING and HOW LOUD:
 *
 *   ANNOUNCEMENT  the gym, to its members. A closure, a timing change, a new
 *                 class. It is a sentence, not a picture, so `body` carries the
 *                 message and `imageUrl` does not apply. It is site-wide — a
 *                 closure is true on every page — so it has no placement.
 *                 Dismissible, because a member who has read it should be able
 *                 to put it away.
 *   BANNER        the gym, promoting itself. A membership offer, a new branch.
 *                 A large slab with an optional image and a call to action,
 *                 placed in a specific slot on a specific page — so it DOES
 *                 take a placement, and is not dismissible (a promo that a
 *                 visitor can close is a promo that is never seen twice).
 *   Advertisement a THIRD PARTY paying for space. Rendered under "Sponsored",
 *                 and that label is the whole reason it stays its own
 *                 collection rather than becoming a third `kind` here.
 *
 * WHY ONE COLLECTION WITH A `kind` DISCRIMINATOR rather than two:
 * announcements and banners differ in presentation, not in lifecycle. Both are
 * scheduled with the same startAt/endAt window, both are ordered, both are
 * switched off the same way, and both are read by the same public endpoint. Two
 * collections would mean two copies of the scheduling logic, two list
 * endpoints, and two chances to fix a window bug in only one of them. The
 * fields that genuinely differ are documented per-field below and enforced in
 * the validator at the bottom.
 *
 * DELIBERATELY NOT BRANCH-SCOPED, exactly as SiteContent, SiteItem, SeoMeta and
 * Advertisement are not: there is one public website, not one per branch, so
 * middlewares/branchScope.js is not applied here.
 */

/** The two things this collection can be. There is no third — see above. */
export const NOTICE_KINDS = ["ANNOUNCEMENT", "BANNER"];

/**
 * The severity of an announcement, which is what drives its colour on the site.
 *
 * A CLOSED ENUM, unlike SiteItem.collectionKey which is deliberately open: the
 * frontend maps each of these to a specific colour token, so a value it has
 * never heard of renders as an unstyled box. A new tone is a frontend change
 * whether or not the server allows it, so the server may as well say no.
 *
 * These are severities, not emotions. URGENT is for "the gym is shut today",
 * not for "our biggest sale ever" — a banner is where enthusiasm goes.
 */
export const NOTICE_TONES = ["INFO", "SUCCESS", "WARNING", "URGENT"];

/**
 * The slots on the public site a BANNER may occupy.
 *
 * SAME VOCABULARY STYLE AS AD_PLACEMENTS (`<PAGE>_<POSITION>`, SCREAMING_SNAKE)
 * on purpose — an editor who has placed an advert should not have to learn a
 * second naming scheme — but a SEPARATE LIST, on purpose too. The two are not
 * the same slots: a banner is a full-width slab and an advert is a card, so
 * `SIDEBAR` and `FOOTER` are meaningless here, while `PROGRAMS_TOP` and
 * `CONTACT_TOP` have no advert equivalent. Sharing AD_PLACEMENTS would make
 * every future advert slot silently a legal banner slot and vice versa.
 *
 * ANNOUNCEMENTS DO NOT USE THIS. A closure notice is true on every page; asking
 * the owner which page it belongs on is asking a question with no answer.
 */
export const NOTICE_PLACEMENTS = [
  "HOME_TOP",
  "HOME_MID",
  "PROGRAMS_TOP",
  "CONTACT_TOP",
];

const SiteNoticeSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: NOTICE_KINDS,
    },
    /** The headline. Required for both kinds — an untitled notice is a blank. */
    title: {
      type: String,
      required: true,
      trim: true,
    },
    /**
     * The message itself.
     *
     * REQUIRED FOR AN ANNOUNCEMENT (enforced below, not here, because the rule
     * is conditional on `kind` and Mongoose's `required` cannot see a sibling
     * field cleanly): an announcement with a title and nothing else is a
     * headline with no news in it — "Ganesh Chaturthi Leave" does not tell
     * anybody which days the gym is shut.
     *
     * OPTIONAL FOR A BANNER: "20% off annual plans" on a picture, with a
     * button, is a complete banner and needs no second sentence.
     */
    body: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Drives the colour the announcement is rendered in. Stored for banners too
     * rather than being rejected, because a banner may legitimately want the
     * SUCCESS palette — it simply is not the main lever there.
     */
    tone: {
      type: String,
      enum: NOTICE_TONES,
      default: "INFO",
    },
    /**
     * BANNER ONLY, and optional even there: a text-and-button banner on a
     * colour block is a perfectly good banner, and requiring a creative would
     * make "announce the new branch by Friday" wait on a designer.
     *
     * Opaque storage reference produced by middlewares/secureUpload.js ->
     * storage/fileStore.js (relative path locally, Blob URL on serverless),
     * stored VERBATIM exactly as Advertisement.imageUrl is. Never rebuild a URL
     * from it.
     */
    imageUrl: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * The call to action. TWO FIELDS, NOT ONE, because a button needs both its
     * words and its destination, and the words are the part the owner actually
     * wants to choose ("Claim the offer" reads very differently from "Read
     * more").
     *
     * AN EMPTY ctaUrl MEANS THE NOTICE IS NOT A LINK — the same contract as
     * Advertisement.targetUrl, so the frontend's "is this clickable?" test is
     * the same question on both collections.
     */
    ctaLabel: {
      type: String,
      trim: true,
      default: "",
    },
    ctaUrl: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * BANNER ONLY. Not `required` at the schema level and not defaulted,
     * because for an ANNOUNCEMENT the correct value is genuinely absent rather
     * than "some slot we picked" — see NOTICE_PLACEMENTS. The conditional rule
     * ("a banner must have one, an announcement must not") is enforced in the
     * validator below.
     */
    placement: {
      type: String,
      enum: [...NOTICE_PLACEMENTS, null],
      default: null,
    },
    /**
     * ANNOUNCEMENT ONLY: may a member close this?
     *
     * DEFAULT TRUE, and that default is the humane one. An announcement the
     * reader cannot dismiss follows them around the site after they have read
     * it. The owner can switch it off for something that genuinely must not be
     * missed (a closure on the day), which is the rare case and should be the
     * deliberate one.
     *
     * Meaningless for a BANNER, which is part of the page rather than an
     * interruption over it.
     */
    dismissible: {
      type: Boolean,
      default: true,
    },
    /**
     * Both dates optional, both open-ended when unset — identical to
     * Advertisement, and the shared rule lives in models/liveWindow.js.
     *
     * THIS IS THE FIELD PAIR THE OWNER TRIPPED OVER: a two-minute window did
     * exactly what it said and the notice vanished. Both the admin badge and
     * the public filter read it through liveWindow.js so they cannot disagree
     * about what a given pair of dates means.
     */
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    /** Order within a kind (and, for banners, within a placement). */
    sortOrder: { type: Number, default: 0 },
    /** The manual kill switch, independent of the date window. */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/**
 * The public read is always "live notices of one kind, optionally for one
 * placement, in order". Leading with `kind` because every query has it and
 * roughly half the collection is excluded by it alone.
 */
SiteNoticeSchema.index({ kind: 1, placement: 1, isActive: 1, sortOrder: 1 });

/**
 * The conditional, kind-dependent rules — the ones a field-level `required`
 * cannot express.
 *
 * A pre-validate hook rather than controller code so that the seed script, a
 * future import job and the admin endpoints all get the same answer. The
 * controller still checks the same things to return a friendly 400; this is the
 * floor beneath it, not a duplicate of it.
 */
SiteNoticeSchema.pre("validate", function normaliseByKind(next) {
  if (this.kind === "ANNOUNCEMENT") {
    // An announcement is the message. Without a body there is no message.
    if (!this.body || !String(this.body).trim()) {
      return next(
        new Error("An ANNOUNCEMENT requires a body — the message members read"),
      );
    }
    /**
     * FORCED to null rather than rejected when supplied. A placement on an
     * announcement is not a hostile input, it is a leftover from a shared admin
     * form; silently dropping a field that has no meaning is kinder than a 400
     * the editor cannot act on. Announcements are site-wide by definition.
     */
    this.placement = null;
  }

  if (this.kind === "BANNER") {
    if (!this.placement) {
      return next(
        new Error(
          `A BANNER requires a placement — one of: ${NOTICE_PLACEMENTS.join(", ")}`,
        ),
      );
    }
    /**
     * Normalised, not rejected, for the same reason as above: `dismissible` is
     * an announcement control and a shared form will send it. A banner is part
     * of the page, so the honest stored value is false.
     */
    this.dismissible = false;
  }

  // A window that ends before it starts is never live, and would sit in the
  // list looking scheduled forever. Caught here so no code path can store one.
  if (this.startAt && this.endAt && this.endAt < this.startAt) {
    return next(new Error("endAt must not be earlier than startAt"));
  }

  return next();
});

/**
 * Re-exported so a consumer of this model never has to know the rule lives
 * elsewhere, and — more to the point — never has a reason to write their own.
 * These are the SAME function objects models/Advertisement.js exposes.
 */
export { liveWindowFilter, isCurrentlyLive, liveStatus };

export default mongoose.model("SiteNotice", SiteNoticeSchema);
