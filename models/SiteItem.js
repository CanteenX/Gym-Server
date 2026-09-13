import mongoose from "mongoose";

/**
 * Repeating, structured records for the public marketing site — the programme
 * cards, the class timetable, the trainer wall, the pricing table, the FAQ
 * accordion, the testimonial carousel and the transformation gallery.
 *
 * WHY A SECOND COLLECTION RATHER THAN MORE SiteContent ROWS: SiteContent is one
 * row per (pageKey, sectionKey) and that uniqueness is the whole point of it —
 * it is how the frontend addresses "home"/"hero" by name. A list of six
 * programme cards has no such name per row. Faking it with
 * `sectionKey: "program-1"`, `"program-2"` … reintroduces ordering as a string
 * sort, makes "insert a card between 2 and 3" a renumbering exercise, and gives
 * the editor no way to know that a programme card has tags while a pricing card
 * has a price. So repeating records get their own collection, keyed by the LIST
 * they belong to (`collectionKey`) and ordered inside it (`sortOrder`).
 *
 * THE SPLIT IS: SiteContent = prose blocks, one per named slot. SiteItem = rows
 * in a list. SeoMeta = what the <head> says. Nothing here duplicates those.
 *
 * DELIBERATELY NOT BRANCH-SCOPED, the same as SiteContent and SeoMeta: there is
 * one public website, not one per branch, so middlewares/branchScope.js is not
 * applied to this collection. The `branch` field below is a display TAG, not a
 * tenancy boundary — see its comment.
 */

/**
 * The twelve lists the marketing site renders today.
 *
 * NOT an enum on the schema, for the same reason SiteContent.pageKey is not
 * one: the website grows a new list far more often than the API ships, and an
 * enum would make "add a testimonials-style section" a server deploy. This
 * array is the set that has a validated field spec below; an unknown key still
 * stores and still reads back, it just gets generic validation.
 */
export const SITE_ITEM_COLLECTIONS = [
  "programs",
  "plans",
  "faqs",
  "trainers",
  "classes",
  "testimonials",
  "transformations",
  // ---- SITE CHROME, added when the owner asked for EVERY string on the site
  // to be editable. The seven above are page CONTENT; these five are the
  // furniture around it, and every one of them was still hardcoded in
  // Gym-frontend/src/lib/site.ts.
  //
  // They are SiteItem rather than SiteContent for one reason each, and it is
  // always the same reason: they are LISTS. `stats` is four numbers, `marquee`
  // is eight words, `navlinks` is three links, `branches` is two gyms,
  // `media` is two background slots. SiteContent is one row per (pageKey,
  // sectionKey) — expressing a list there means inventing
  // `sectionKey: "stat-1"`, `"stat-2"` …, which makes "insert a stat between
  // the second and the third" a renumbering exercise and makes the ordering a
  // string sort. That limitation is the recorded reason models/SiteItem.js
  // exists at all (docs/todo.md), so it is not re-litigated here.
  "stats",
  "marquee",
  "navlinks",
  "branches",
  "media",
];

/**
 * Per-collection contract for the free-form `fields` bag.
 *
 * WHY THIS EXISTS AT ALL: `fields` is Mongoose `Mixed`, and Mixed is not
 * validated, not cast and not even watched for changes. Without a spec,
 * `{ pirce: "₹1,200" }` saves cleanly, returns 200, and ships a pricing table
 * with a blank price — a bug with no error anywhere to notice it. The spec
 * turns that typo into a 400 that names the offending key.
 *
 * WHY IT IS A CLOSED LIST FOR KNOWN COLLECTIONS AND OPEN FOR UNKNOWN ONES:
 * dropping unknown keys silently would be the same failure as no validation at
 * all (the price is still blank, the editor is still told "saved"). Rejecting
 * them is the only option that tells the person making the mistake. But a
 * collectionKey with no spec — a list invented after this file shipped — is
 * left free-form, so adding a list stays a data change rather than a deploy,
 * matching how pageKey works. Add a spec here when the shape settles. Note that
 * an unspecced collection still gets the key safety checks, and every value in
 * it is stored as a trimmed STRING (there is nothing to say it should be a
 * number), which is another reason to write the spec once the list is real.
 *
 * `type` drives coercion in `validateItemFields`:
 *   string   trimmed, length-capped
 *   number   Number(), rejected when not finite — "" DROPS the key rather than
 *            becoming 0, which is the SiteItem version of the Phase 1 advert
 *            bug where a cleared date picker stored an Invalid Date
 *   boolean  accepts true/false and the "true"/"false"/"1"/"0" a form sends
 *   string[] accepts an array or a comma-separated string
 *   image    a string, same opaque storage reference rule as `imageUrl`
 *
 * `required` is enforced against the MERGED result of an update, not just a
 * create, so "edit the description of a plan" cannot leave it priceless.
 */
export const FIELD_SPECS = {
  programs: {
    /** Stable anchor id the frontend links to, e.g. "strength". */
    slug: { type: "string" },
    /** The pills under each programme card: ["Barbell", "Hypertrophy"]. */
    tags: { type: "string[]" },
  },
  plans: {
    slug: { type: "string" },
    /**
     * REQUIRED, and the reason this whole spec exists. A pricing card with no
     * price is the single most expensive thing this CMS can render.
     *
     * Kept a STRING, not a number: the real values are "₹1,200" and "₹6,500" —
     * currency symbol, grouping and all — and the site prints them verbatim.
     * Storing 1200 would move the formatting decision back into the frontend,
     * which is exactly the decision the owner is meant to be taking here.
     */
    price: { type: "string", required: true },
    /** "/ month", "/ year" — printed next to the price. */
    period: { type: "string" },
    /** The ticked list inside the card. */
    features: { type: "string[]" },
    /** Highlights one card as the recommended plan. */
    featured: { type: "boolean" },
  },
  faqs: {},
  trainers: {
    /** "Powerlifting · Form Correction" — the specialism line under the role. */
    focus: { type: "string" },
  },
  classes: {
    /**
     * BOTH REQUIRED: a timetable row that does not say when it runs is not a
     * timetable row. Free strings ("Mon", "6:00 AM") rather than a weekday enum
     * or a Date, because the site prints them as-is and the owner may well want
     * "Mon — Sat" or "Sun (women only)" in a single cell.
     */
    day: { type: "string", required: true },
    time: { type: "string", required: true },
  },
  testimonials: {
    /** Optional 1-5 star rating; the carousel renders stars only when set. */
    rating: { type: "number" },
  },
  transformations: {
    /** "6 months" — how long the change took. */
    duration: { type: "string" },
    /** "−18 kg", "+12 kg lean" — the headline result. */
    result: { type: "string" },
    /** Opaque storage references, same rule as `imageUrl`. */
    beforeImage: { type: "image" },
    afterImage: { type: "image" },
  },

  // =====================================================================
  // SITE CHROME
  //
  // A NOTE ON THE " | " SEPARATOR used by `branches.hours` and
  // `branches.openingHours` below, because it looks like a shortcut and is not.
  //
  // Those two are lists of TUPLES — ("Mon — Sat", "5:00 AM — 11:00 PM") and
  // (days, opens, closes) — and `fields` cannot hold a nested object:
  // `coerceValue` rejects one outright ("must contain strings, not objects"),
  // deliberately, because a Mixed bag of arbitrary nested objects is how a `$`
  // key or a prototype name gets in. Loosening that to store two opening-hour
  // rows would trade a real safety property for a nicer shape.
  //
  // So each tuple is ONE string with its columns separated by " | ", carried in
  // the existing `string[]` type. That keeps the admin editor's existing array
  // widget working with no client change, and it keeps every value a flat,
  // key-checked string.
  //
  // THE ONE RULE: no column may contain a comma. `coerceValue` accepts a
  // `string[]` as either a real array or a COMMA-SEPARATED string (that is how a
  // plain form posts one), so a comma inside an entry would shatter that entry
  // into pieces the first time somebody saved through a non-JSON client. This is
  // why `openingHours` joins its weekdays with spaces — "Monday Tuesday …" —
  // rather than with the commas that would read more naturally.
  // =====================================================================

  /**
   * The four animated counters in the home hero. `title` is the label
   * ("Members Training"); the number lives here.
   *
   * `count` is REQUIRED for the same reason `plans.price` is: the hero renders
   * an animated counter that ticks up to `count`, and a blank one ticks up to
   * nothing. The published page would show "Members Training" under a zero.
   *
   * `value` is the STATIC fallback string the site prints before/instead of the
   * animation ("1000+"), and `suffix` is what the counter appends once it
   * arrives ("+", "%", or nothing at all). Both are optional because a plain
   * whole number needs neither.
   */
  stats: {
    value: { type: "string" },
    count: { type: "number", required: true },
    suffix: { type: "string" },
  },

  /**
   * The scrolling ribbon on the home page. The word IS the row, so `title`
   * carries it and there is nothing else to store — the same shape as `faqs`,
   * where an empty spec means "this list takes no extra fields" and any stray
   * key is a 400 rather than a silent save.
   */
  marquee: {},

  /**
   * The navbar / footer link list. `title` is the label ("Programs").
   *
   * `href` is REQUIRED and lives here rather than in the row's top-level
   * `ctaHref`, which is where it would more naturally sit. The reason is that
   * required-ness is only enforceable inside `fields`: the schema's `ctaHref`
   * defaults to "" and nothing rejects an empty one. A nav link with no
   * destination is not a nav link — it renders an `<a href="">` that silently
   * reloads the current page — so it gets the same treatment as a pricing card
   * with no price.
   */
  navlinks: {
    href: { type: "string", required: true },
  },

  /**
   * The two gyms AS THE PUBLIC SITE DESCRIBES THEM. `title` is the full name
   * ("Mid City Gym — Vasna") and `body` is the blurb.
   *
   * NOT models/Branch.js, and the distinction matters. `Branch` is the
   * operational master: its `name` is the literal string stored on every
   * Member, Trainer, Transaction and Attendance row, which is why the
   * controller refuses to rename one. This collection is marketing copy about
   * the same two floors — the phone number printed on the footer, the opening
   * hours, the blurb — and editing it must never be able to touch a tenancy
   * key. Keeping them apart is what makes "fix a typo in the Gotri hours" a
   * safe thing for staff to do.
   *
   * `slug` is REQUIRED: it is "vasna" / "gotri", the stable id the frontend
   * keys its list on and builds anchors from, and it survives a rename of the
   * display name. `area`, `phone` and `mapQuery` are required because a branch
   * card that cannot say where it is, or be phoned, or be found on a map, is
   * not a branch card.
   *
   * `streetAddress`, `postalCode`, `geoLat` and `geoLng` are declared but
   * SEEDED EMPTY, on purpose. No postal address or map pin for either gym
   * exists anywhere in this codebase — `Branch.address` is "" for both — and an
   * invented one is worse than none, because it is wrong in a machine-readable
   * way that search engines publish and map providers pin. They are declared so
   * that the day the owner supplies them, it is typing into an existing field
   * rather than a schema change.
   */
  branches: {
    slug: { type: "string", required: true },
    area: { type: "string", required: true },
    phone: { type: "string", required: true },
    /** "tel:+919687294124" — the dialable form, stored rather than derived. */
    phoneHref: { type: "string" },
    /** What gets handed to the maps deep link, e.g. "Mid City Gym Vasna Vadodara". */
    mapQuery: { type: "string", required: true },
    /** Display rows: "Mon — Sat | 5:00 AM — 11:00 PM". See the " | " note above. */
    hours: { type: "string[]" },
    /**
     * The same information in the shape schema.org needs, as
     * "<days> | <opens> | <closes>" with 24-hour HH:MM times and weekdays
     * joined by spaces.
     *
     * Stored ALONGSIDE `hours` rather than parsed out of it: `hours` is display
     * copy an editor may reword at any time, and a regex over it would start
     * emitting wrong opening times to Google the first time somebody typed
     * "Mon-Sat" with a hyphen.
     */
    openingHours: { type: "string[]" },
    streetAddress: { type: "string" },
    postalCode: { type: "string" },
    geoLat: { type: "number" },
    geoLng: { type: "number" },
  },

  /**
   * Background media slots — the looping hero video and the interior page
   * header video.
   *
   * `slug` is REQUIRED because this is the one list whose rows are addressed BY
   * NAME: the frontend asks for the "hero" slot specifically, it does not
   * render whatever happens to be first. That is normally the argument for
   * SiteContent (see `social` in config/cmsMenus.js), and it was weighed here —
   * but a media slot needs TWO urls, a video and its poster, and SiteContent
   * has exactly one `imageUrl` with a controller whitelist that cannot be
   * widened without a server change. `fields` already holds typed extra images,
   * so this is the model that fits. A duplicate slug renders one row, not two,
   * because the frontend looks the slug up rather than mapping over the list.
   *
   * `poster` is what shows before the video buffers, when autoplay is blocked,
   * and whenever the visitor prefers reduced motion — so a slot with a poster
   * and no video degrades correctly, which is why neither is required.
   */
  media: {
    slug: { type: "string", required: true },
    video: { type: "image" },
    poster: { type: "image" },
  },
};

/** Defensive ceilings so one paste cannot put a megabyte in a Mixed bag. */
const MAX_FIELD_KEYS = 24;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 1000;
const MAX_ARRAY_ENTRIES = 30;
const MAX_ARRAY_ENTRY_LENGTH = 200;

/**
 * Keys that must never reach a Mixed field.
 *
 * `$`-prefixed and dotted keys are how a stored document turns into an update
 * operator or a path traversal the next time anything builds a `$set` out of
 * this object, and express-mongo-sanitize only cleans the REQUEST — it does not
 * stop us writing such a key ourselves. The prototype names are the usual JS
 * pollution vector once the object is spread client-side.
 *
 * @param {string} key candidate field name
 * @returns {string|null} an error message, or null when the key is safe
 */
const keyError = (key) => {
  if (!key || typeof key !== "string") return "fields keys must be strings";
  if (key.length > MAX_KEY_LENGTH) {
    return `fields key '${key.slice(0, MAX_KEY_LENGTH)}…' is too long`;
  }
  if (key.startsWith("$") || key.includes(".")) {
    return `fields key '${key}' may not start with $ or contain a dot`;
  }
  if (["__proto__", "constructor", "prototype"].includes(key)) {
    return `fields key '${key}' is reserved`;
  }
  return null;
};

/** Accepts real booleans and the "true"/"1" strings a form sends. */
const toBoolean = (value) =>
  value === true || value === "true" || value === "1" || value === 1;

/**
 * Normalises one declared value. Returning `undefined` means "drop this key" —
 * that is how an emptied input unsets a field instead of storing "" or 0.
 *
 * @param {string} key field name, for the error message
 * @param {string} type spec type
 * @param {unknown} value raw value
 * @returns {{ value?: unknown, error?: string }}
 */
const coerceValue = (key, type, value) => {
  if (value === null || value === undefined) return {};

  if (type === "number") {
    // "" is a cleared input, NOT zero. Number("") === 0 is precisely how a
    // blank rating field would ship as a 0-star review.
    if (value === "") return {};
    const num = Number(value);
    if (!Number.isFinite(num)) return { error: `fields.${key} must be a number` };
    return { value: num };
  }

  if (type === "boolean") {
    if (value === "") return {};
    return { value: toBoolean(value) };
  }

  if (type === "string[]") {
    const raw = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : null;
    if (raw === null) {
      return { error: `fields.${key} must be an array of strings` };
    }
    const out = [];
    for (const entry of raw) {
      if (entry === null || entry === undefined) continue;
      if (typeof entry === "object") {
        return { error: `fields.${key} must contain strings, not objects` };
      }
      const text = String(entry).trim().slice(0, MAX_ARRAY_ENTRY_LENGTH);
      if (!text) continue;
      out.push(text);
      if (out.length >= MAX_ARRAY_ENTRIES) break;
    }
    return out.length ? { value: out } : {};
  }

  // string | text | image
  if (typeof value === "object") {
    return { error: `fields.${key} must be a string` };
  }
  const text = String(value).trim().slice(0, MAX_VALUE_LENGTH);
  return text ? { value: text } : {};
};

/**
 * Validates and normalises a `fields` bag for a collection.
 *
 * IMMUTABLE: it never touches `incoming` or `existing`, it builds and returns a
 * new object — which is also what makes it safe to hand straight to a Mongoose
 * Mixed path, since assigning a fresh object is what marks that path dirty.
 *
 * @param {string} collectionKey which list the row belongs to
 * @param {unknown} incoming the client's `fields` object
 * @param {object} [existing] the row's current fields, for an update — incoming
 *   keys are MERGED over these so a partial edit cannot wipe a price, and an
 *   explicit `null` removes a key
 * @returns {{ fields: object }|{ error: string }}
 */
export const validateItemFields = (collectionKey, incoming, existing = {}) => {
  const base = existing && typeof existing === "object" ? existing : {};
  if (incoming === undefined || incoming === null) return { fields: { ...base } };
  if (typeof incoming !== "object" || Array.isArray(incoming)) {
    return { error: "fields must be an object" };
  }

  const spec = FIELD_SPECS[collectionKey];
  const merged = { ...base };

  for (const [key, raw] of Object.entries(incoming)) {
    const badKey = keyError(key);
    if (badKey) return { error: badKey };

    // An explicit null is the only way to REMOVE a key. "" merely leaves the
    // value unset, which for a key that is already absent is the same thing.
    if (raw === null) {
      delete merged[key];
      continue;
    }

    // Known collection: the key list is closed. An unrecognised key is far more
    // likely a typo than an intention, and a typo that saves silently is the
    // bug this whole spec exists to prevent.
    if (spec && !spec[key]) {
      const known = Object.keys(spec);
      return {
        error: known.length
          ? `fields.${key} is not a known field for '${collectionKey}' (expected: ${known.join(", ")})`
          : `'${collectionKey}' takes no extra fields`,
      };
    }

    const type = spec ? spec[key].type : "string";
    const { value, error } = coerceValue(key, type, raw);
    if (error) return { error };
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }

  if (Object.keys(merged).length > MAX_FIELD_KEYS) {
    return { error: `fields may hold at most ${MAX_FIELD_KEYS} keys` };
  }

  // Required keys are checked against the MERGED result, so an update that only
  // touches `featured` still fails if the row has somehow lost its price.
  if (spec) {
    for (const [key, rule] of Object.entries(spec)) {
      if (rule.required && merged[key] === undefined) {
        return { error: `fields.${key} is required for '${collectionKey}'` };
      }
    }
  }

  return { fields: merged };
};

const SiteItemSchema = new mongoose.Schema(
  {
    /**
     * Which list this row belongs to: "programs", "plans", "faqs", "trainers",
     * "classes", "testimonials", "transformations", plus the site chrome lists
     * "stats", "marquee", "navlinks", "branches", "media". Lowercased on write so
     * "Programs" and "programs" cannot become two lists that each render half
     * the cards.
     */
    collectionKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    /**
     * The row's headline, and the closest thing it has to a name: the programme
     * name, the plan name, the question, the trainer, the class, the member
     * being quoted. Required because a row with no title is unidentifiable in
     * the admin list, and it is the key the seed script matches on.
     */
    title: { type: String, required: true, trim: true },
    /** Second line — a plan's one-line pitch, a trainer's role, "Member · Vasna". */
    subtitle: { type: String, trim: true, default: "" },
    /** The long text: an answer, a quote, a programme description. */
    body: { type: String, default: "" },
    /**
     * Opaque storage reference from storage/fileStore.js: a relative
     * "uploads/..." path on the PM2 deployment, an absolute Vercel Blob URL on
     * serverless, or an external CDN URL typed in by hand. Callers must not
     * parse it (see fileStore.js).
     */
    imageUrl: { type: String, trim: true, default: "" },
    ctaLabel: { type: String, trim: true, default: "" },
    ctaHref: { type: String, trim: true, default: "" },
    /**
     * Per-collection extras, validated by `validateItemFields` above against
     * FIELD_SPECS — price, period, features, day, time, rating, beforeImage…
     *
     * WHY Mixed AND NOT Map: a Mongoose Map read through `.lean()` comes back
     * as a real JS `Map`, and `JSON.stringify(new Map([["price", "₹1,200"]]))`
     * is `{}`. The public read is `.lean()` for speed, so a Map would serialise
     * every row's extras to an empty object — the pricing table would render
     * blank in production and fine in any test that skipped `.lean()`. Mixed
     * round-trips as a plain object everywhere. Its cost is that it is
     * unvalidated, which is exactly what FIELD_SPECS buys back.
     *
     * The default is a FUNCTION: a bare `{}` default is one object shared by
     * every document Mongoose instantiates.
     */
    fields: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    /** Render order within a collection. Ties fall back to creation order. */
    sortOrder: { type: Number, default: 0 },
    /** Hides a row from the public site without deleting it. */
    isActive: { type: Boolean, default: true },
    /**
     * OPTIONAL DISPLAY TAG, NOT A TENANCY BOUNDARY — read this before writing
     * any query against it.
     *
     * Some rows genuinely belong to one floor: a class that only runs at Gotri,
     * a trainer who only coaches at Vasna. That is what this records, and the
     * public read uses it to narrow a timetable. It is NOT branch scoping:
     * middlewares/branchScope.js is not applied to this collection, a Vasna
     * admin edits the one public website like everyone else, and an empty value
     * means "shows everywhere" rather than "unassigned". A free string, not an
     * enum, because models/Branch.js made branches data rather than an enum.
     */
    branch: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/**
 * The public read is always "active rows of one collection, in order", and the
 * admin list is the same query without the isActive clause. One compound index
 * serves both because `collectionKey` is the prefix.
 *
 * NO UNIQUE INDEX, unlike SiteContent and SeoMeta: repetition is the point
 * here. The timetable legitimately holds five rows titled "Zumba", one per slot
 * it runs in, and a uniqueness constraint would reject four of them.
 */
SiteItemSchema.index({ collectionKey: 1, isActive: 1, sortOrder: 1 });

export default mongoose.model("SiteItem", SiteItemSchema);
