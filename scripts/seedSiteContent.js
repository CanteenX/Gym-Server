/**
 * Seeds the editable prose blocks the marketing site is built from — the
 * eight the marketing PAGES read, plus the header, footer and social rows the
 * CMS navigation restructure gave a screen to.
 *
 * WHY THIS EXISTS: SiteItem shipped with 48 rows imported from the live site,
 * so the Content Lists tab opens full of the owner's real programmes and
 * prices. SiteContent shipped with none, so the Page Sections tab opened
 * EMPTY - which reads as "the CMS is broken" rather than "nothing has been
 * overridden yet", and gives the owner nothing to edit without first guessing
 * the right pageKey/sectionKey pair.
 *
 * The values below are the shipped copy the components already fall back to,
 * copied verbatim from Gym-frontend. Seeding them changes nothing visible on
 * the site - every string is what the page renders today - it just makes that
 * copy editable.
 *
 * The pairs are dictated by the frontend and must match it exactly; each page
 * documents the keys it consumes in a comment at the top of its page.tsx:
 *   home     -> hero, about, cta
 *   programs -> header, cta
 *   contact  -> header, form, cta
 *
 * THREE MORE pageKeys were added by the CMS navigation restructure, and they
 * are a different kind of thing from the three above: nothing on the frontend
 * reads them YET. They exist so that the /cms/header, /cms/footer and
 * /cms/social screens open with the real strings the site chrome renders today
 * instead of an empty form, and so the owner is not asked to invent a
 * sectionKey. Wiring the frontend to read them is a separate, frontend-side
 * change; until it lands, editing these changes nothing on the live site.
 *   header -> brand, cta            (src/components/sections/navbar.tsx)
 *   footer -> brand, explore, branches, legal
 *                                   (src/components/sections/footer.tsx)
 *   social -> instagram, facebook, youtube, whatsapp
 *                                   (src/lib/site.ts `site.instagram`)
 *
 * ONE MORE pageKey, `site`, was added when the owner asked for EVERY string on
 * the website to be editable. It holds the brand FACTS rather than any one
 * page's copy - the name, tagline, bio, city, region and country that
 * Gym-frontend/src/lib/site.ts kept hardcoded and that thirteen components
 * read. Same status as header/footer/social: nothing on the frontend reads
 * these rows yet, wiring that up is a frontend-side change.
 *   site   -> identity, location     (src/lib/site.ts `site`)
 *
 * `seo` is deliberately NOT seeded. Phase 2's SeoMeta supersedes it and wins
 * all-or-nothing, so a seeded seo row here would be dead weight that a future
 * reader would mistake for the live source of a page title.
 *
 * ------------------------------------------------------------------------
 * THIS FILE ALSO SEEDS FIVE SiteItem LISTS, AND HERE IS WHY IT IS NOT
 * scripts/seedSiteItems.js
 *
 * `stats`, `marquee`, `navlinks`, `branches` and `media` are LISTS, so they are
 * SiteItem rows - SiteContent's one-row-per-(pageKey, sectionKey) shape cannot
 * express "four counters the owner can reorder" without inventing
 * `sectionKey: "stat-1"`, and that limitation is the recorded reason
 * models/SiteItem.js exists at all (docs/todo.md).
 *
 * But they are not page CONTENT, which is what seedSiteItems.js is: that script
 * is a verbatim import of the seven marketing lists out of site.ts - the
 * programme cards, the pricing table, the timetable - and its header says so.
 * These five are site CHROME: the ribbon, the nav, the two branch cards, the
 * background videos and the hero counters. They belong with the header/footer/
 * site-identity blocks above, they change for the same reasons, and seeding
 * them together means ONE command brings a fresh database up with a complete,
 * editable site instead of two commands with a half-editable site in between.
 *
 * The values are copied verbatim from Gym-frontend/src/lib/site.ts, exactly as
 * seedSiteItems.js copies its own. Nothing here is invented - in particular no
 * postal address and no map pin for either branch, because neither exists
 * anywhere in this codebase (see models/SiteItem.js `branches`).
 * ------------------------------------------------------------------------
 *
 * Run:  npm run seed:site-content
 * Idempotent in both halves: SiteContent is keyed on (pageKey, sectionKey),
 * which is the model's unique index; the SiteItem rows are keyed on
 * (collectionKey, title), which is unique within each of these five lists
 * (unlike `classes`, where "Zumba" legitimately appears five times). Existing
 * rows are left exactly as they are - this never overwrites an edit the owner
 * has made.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import SiteContent from "../models/SiteContent.js";
import SiteItem, { validateItemFields } from "../models/SiteItem.js";

dotenv.config();

const BIO = "No Excuses. Just Results.";
const TAGLINE = "Best Gym in Vadodara";
const CITY = "Vadodara";
const NAME = "Mid City Gym";
const REGION = "Gujarat";
/** ISO 3166-1 alpha-2, which is what schema.org's addressCountry wants. */
const COUNTRY = "IN";

/**
 * `subtitle` carries the accent word each heading is split on - the frontend
 * renders title and accent in different colours, so they are two fields rather
 * than one string with markup in it.
 */
const SECTIONS = [
  {
    pageKey: "home",
    sectionKey: "hero",
    title: "Train Harder. Transform",
    subtitle: "Faster.",
    body: `${BIO} Premium equipment, certified trainers and a floor that stays busy from 5 AM. Two locations across ${CITY}.`,
    ctaLabel: "Start Training",
    ctaHref: "#pricing",
    sortOrder: 10,
  },
  {
    pageKey: "home",
    sectionKey: "about",
    title: "Turn your workout into a",
    subtitle: "lifestyle",
    body:
      "We believe fitness is more than physical. It's confidence, discipline and a room that expects you to show up — built for every body in Vadodara.",
    sortOrder: 20,
  },
  {
    pageKey: "home",
    sectionKey: "cta",
    title: "Stop planning.",
    subtitle: "Start lifting.",
    body: `${BIO} Your first session at ${NAME} is free — walk into Vasna or Gotri and we'll take it from there.`,
    ctaLabel: "Book Free Trial",
    sortOrder: 30,
  },
  {
    pageKey: "programs",
    sectionKey: "header",
    title: "Programs, coaches and",
    subtitle: "plans",
    body:
      "Six ways to train on one membership. Pick a program, find your slot, meet the coach who'll run it.",
    imageUrl:
      "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=2000&q=75",
    sortOrder: 10,
  },
  {
    pageKey: "programs",
    sectionKey: "cta",
    title: "Stop planning.",
    subtitle: "Start lifting.",
    body: `${BIO} Your first session at ${NAME} is free — walk into Vasna or Gotri and we'll take it from there.`,
    ctaLabel: "Book Free Trial",
    sortOrder: 20,
  },
  {
    pageKey: "contact",
    sectionKey: "header",
    title: "Come see the",
    subtitle: "floor",
    body:
      "Two branches across Vadodara, both on one membership. Call ahead or just walk in for a free trial.",
    imageUrl:
      "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=2000&q=75",
    sortOrder: 10,
  },
  {
    pageKey: "contact",
    sectionKey: "form",
    title: "Ask us",
    subtitle: "anything",
    body:
      "Leave your number and the front desk will call you back the same day — about plans, timings, or booking a free trial.",
    sortOrder: 20,
  },
  {
    pageKey: "contact",
    sectionKey: "cta",
    title: "Stop planning.",
    subtitle: "Start lifting.",
    body: `${BIO} Your first session at ${NAME} is free — walk into Vasna or Gotri and we'll take it from there.`,
    ctaLabel: "Book Free Trial",
    sortOrder: 30,
  },

  // ============ HEADER (/cms/header) ============
  //
  // Only the two things in the navbar that are editorial. The nav LINKS
  // (Home / Programs / Contact) are deliberately NOT here: they are a repeating
  // list, not a prose block, so faking them as header/link-1, header/link-2 …
  // would reintroduce exactly the ordering and renumbering problem that
  // models/SiteItem.js was created to avoid. They stay in the frontend's
  // `navLinks` until somebody wants them editable, at which point they want a
  // SiteItem collection, not more rows here.
  {
    pageKey: "header",
    sectionKey: "brand",
    // The wordmark is rendered as MID + CITY with the second half in the accent
    // colour, so it is two fields rather than one string carrying markup —
    // the same title/subtitle split the home hero uses.
    title: "MID",
    subtitle: "CITY",
    body: "",
    sortOrder: 10,
  },
  {
    pageKey: "header",
    sectionKey: "cta",
    // Two labels for one button: the desktop bar prints "Login", the mobile
    // sheet has room for "Member Login". Both are in the shipped markup today.
    ctaLabel: "Login",
    ctaHref: "/login",
    subtitle: "Member Login",
    sortOrder: 20,
  },

  // ============ FOOTER (/cms/footer) ============
  {
    pageKey: "footer",
    sectionKey: "brand",
    title: "MID",
    subtitle: "CITY",
    body: `${BIO} ${TAGLINE} — premium equipment and certified trainers across two floors in ${CITY}.`,
    sortOrder: 10,
  },
  {
    pageKey: "footer",
    // The heading over the nav column. The links under it are `navLinks`, for
    // the same reason as the header — see the comment there.
    sectionKey: "explore",
    title: "Explore",
    sortOrder: 20,
  },
  {
    pageKey: "footer",
    // The heading over the branch column. The branches themselves come from
    // models/Branch.js and the frontend's `branches` table; the phone numbers
    // are NOT copied here, because two places to change a phone number is one
    // place too many.
    sectionKey: "branches",
    title: "Our Branches",
    sortOrder: 30,
  },
  {
    pageKey: "footer",
    sectionKey: "legal",
    // The © symbol and the year are composed by the frontend (`new Date()`), so
    // only the editable remainder is stored. Seeding "© 2026 …" would freeze
    // the year into the database on 1 January.
    title: `${NAME}. All rights reserved.`,
    subtitle: `${CITY}, Gujarat · India`,
    sortOrder: 40,
  },

  // ============ SOCIAL & MEDIA (/cms/social) ============
  //
  // ONE ROW PER NETWORK, and the (pageKey, sectionKey) uniqueness is the reason
  // this is SiteContent rather than a SiteItem list — see the decision recorded
  // in config/cmsMenus.js. The frontend renders a known icon for a known
  // network, so it must address "the Instagram link" BY NAME; SiteItem has no
  // unique index (repetition is its whole point) and would happily hold two
  // Instagram rows that render the icon twice.
  //
  // Field convention: title = the network, ctaLabel = the handle as printed,
  // ctaHref = the profile URL, isActive = whether the icon shows at all.
  {
    pageKey: "social",
    sectionKey: "instagram",
    title: "Instagram",
    ctaLabel: "@midcity.gym",
    ctaHref: "https://www.instagram.com/midcity.gym/",
    sortOrder: 10,
  },
  /**
   * THE REST ARE EMPTY AND INACTIVE ON PURPOSE.
   *
   * Instagram is the only social account that exists anywhere in this codebase.
   * There is no Facebook page, no YouTube channel and no WhatsApp number on
   * record, so none is invented here — a guessed profile URL is a live link to
   * somebody else's account printed on the gym's own footer.
   *
   * They are seeded as blank, switched-off slots rather than omitted so the
   * owner can fill one in without first having to guess the right sectionKey,
   * and so the Social & Media screen shows what it supports. `isActive: false`
   * means the public read (GET /site/content?pageKey=social, active rows only)
   * never returns them, so an unfilled slot cannot render an empty link.
   */
  {
    pageKey: "social",
    sectionKey: "facebook",
    title: "Facebook",
    ctaLabel: "",
    ctaHref: "",
    isActive: false,
    sortOrder: 20,
  },
  {
    pageKey: "social",
    sectionKey: "youtube",
    title: "YouTube",
    ctaLabel: "",
    ctaHref: "",
    isActive: false,
    sortOrder: 30,
  },
  {
    pageKey: "social",
    sectionKey: "whatsapp",
    title: "WhatsApp",
    ctaLabel: "",
    ctaHref: "",
    isActive: false,
    sortOrder: 40,
  },

  // ============ SITE IDENTITY (/cms/site) ============
  //
  // The brand facts, split into two rows rather than crammed into one, because
  // SiteContent gives a row exactly three text slots (title/subtitle/body) and
  // there are six facts. The split is by what they answer: WHO the gym is, and
  // WHERE it is.
  //
  // These are NOT a second copy of the header wordmark or the footer copyright
  // line. Those are rendered STRINGS and are already editable on their own
  // screens; these are the facts underneath them, and they are also what
  // Gym-frontend/src/lib/seo.ts publishes as Organization / PostalAddress
  // structured data. Two of the six (name, city) therefore appear in a
  // human-composed form elsewhere, which is a copy the frontend makes, not a
  // second place to edit the fact.
  //
  // NO CONTACT EMAIL AND NO GENERAL PHONE NUMBER IS SEEDED HERE, deliberately.
  // Neither exists anywhere in Gym-frontend: `site` carries no email at all,
  // and the only phone numbers on the site are the two BRANCH numbers, which
  // live on the branch cards (SiteItem `branches` below) where they are already
  // editable. Inventing a general "info@" address would put a dead mailbox on
  // every page of the site.
  {
    pageKey: "site",
    sectionKey: "identity",
    // title = brand name, subtitle = tagline, body = the bio line.
    title: NAME,
    subtitle: TAGLINE,
    body: BIO,
    sortOrder: 10,
  },
  {
    pageKey: "site",
    sectionKey: "location",
    // title = city, subtitle = state/region, body = ISO 3166-1 country code.
    // The country is a CODE rather than "India" because that is the form
    // schema.org wants and the only form anything reads it in; printing it
    // would be the frontend's job, and it prints "India" from the footer's
    // own legal line instead.
    title: CITY,
    subtitle: REGION,
    body: COUNTRY,
    sortOrder: 20,
  },
];

// ===========================================================================
// SITE CHROME LISTS (SiteItem)
//
// Verbatim from Gym-frontend/src/lib/site.ts. See the file header for why they
// are seeded here rather than in scripts/seedSiteItems.js.
// ===========================================================================

/**
 * Gaps of 10 rather than 1, 2, 3 — the same convention scripts/seedSiteItems.js
 * uses, and for the same reason: the whole point of these rows is that the
 * owner can reorder them, and "put a new word between the second and the third"
 * with consecutive integers means renumbering everything below it.
 */
const step = (index) => (index + 1) * 10;

/** site.ts -> `stats`. `title` is the label; the number lives in `fields`. */
const stats = [
  { value: "2", count: 2, suffix: "", label: "Locations in Vadodara" },
  { value: "1000+", count: 1000, suffix: "+", label: "Members Training" },
  { value: "15+", count: 15, suffix: "+", label: "Weekly Classes" },
  { value: "100%", count: 100, suffix: "%", label: "Certified Trainers" },
];

/** site.ts -> `marqueeItems`. The word IS the row. */
const marqueeItems = [
  "Strength",
  "Zumba",
  "Personal Training",
  "Yoga",
  "Cardio",
  "Functional Fitness",
  "No Excuses",
  "Just Results",
];

/** site.ts -> `navLinks`. Order here drives the navbar and the footer nav. */
const navLinks = [
  { href: "/", label: "Home" },
  { href: "/programs", label: "Programs" },
  { href: "/contact", label: "Contact" },
];

/**
 * site.ts -> `branches`, kept in its ORIGINAL site.ts shape so a future diff
 * against that file is a readable one. `buildChromeRows()` below flattens
 * `hours` and `openingHours` onto the " | " convention that models/SiteItem.js
 * documents.
 *
 * `streetAddress`, `postalCode` and `geo` are absent from site.ts and stay
 * absent here. The owner's recorded decision (docs/todo.md) is that no street
 * address or map pin is invented for either gym; the fields exist on the model
 * so they can be typed in the day the real ones arrive.
 */
const MON_TO_SAT = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const branches = [
  {
    id: "vasna",
    name: "Mid City Gym — Vasna",
    area: "Vasna",
    phone: "+91 96872 94124",
    phoneHref: "tel:+919687294124",
    hours: [
      { days: "Mon — Sat", time: "5:00 AM — 11:00 PM" },
      { days: "Sunday", time: "6:00 AM — 2:00 PM" },
    ],
    openingHours: [
      { days: MON_TO_SAT, opens: "05:00", closes: "23:00" },
      { days: ["Sunday"], opens: "06:00", closes: "14:00" },
    ],
    blurb:
      "Our flagship floor. Full free-weight section, dedicated cardio deck and the widest class timetable.",
    mapQuery: "Mid City Gym Vasna Vadodara",
  },
  {
    id: "gotri",
    name: "Mid City Gym — Gotri",
    area: "Gotri",
    phone: "+91 74878 24202",
    phoneHref: "tel:+917487824202",
    hours: [
      { days: "Mon — Sat", time: "5:30 AM — 10:30 PM" },
      { days: "Sunday", time: "6:00 AM — 2:00 PM" },
    ],
    openingHours: [
      { days: MON_TO_SAT, opens: "05:30", closes: "22:30" },
      { days: ["Sunday"], opens: "06:00", closes: "14:00" },
    ],
    blurb:
      "Newer floor with premium imported machines, a functional training zone and a women-only hour.",
    mapQuery: "Mid City Gym Gotri Vadodara",
  },
];

/**
 * site.ts -> `heroMedia` and `pageHeaderVideo`, as two named slots.
 *
 * `slug` is the name the frontend looks the slot up by. The page-header slot
 * has no poster: site.ts gives `pageHeaderVideo` a URL and nothing else,
 * because the /programs and /contact headers already carry their own still
 * image on the SiteContent `header` rows above. None is invented for it.
 */
const media = [
  {
    slug: "hero",
    title: "Home Hero",
    video:
      "https://videos.pexels.com/video-files/5319760/5319760-uhd_2560_1440_25fps.mp4",
    poster:
      "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=2000&q=75",
  },
  {
    slug: "page-header",
    title: "Page Header",
    video:
      "https://videos.pexels.com/video-files/5319759/5319759-uhd_2560_1440_25fps.mp4",
    poster: "",
  },
];

/**
 * Joins one tuple onto the " | " convention models/SiteItem.js documents.
 *
 * A column containing a comma would be shattered the first time a non-JSON
 * client posted the array as a comma-separated string, so this refuses to build
 * one rather than letting a comma reach the database and break silently much
 * later. It is the seed's own tripwire: none of the values below has a comma
 * today, and if somebody pastes one in, the seed says so.
 *
 * @param {string[]} columns the tuple, in order
 * @returns {string} "a | b | c"
 */
const joinTuple = (columns) => {
  for (const column of columns) {
    if (String(column).includes(",")) {
      throw new Error(
        `Site chrome tuple column '${column}' contains a comma; ` +
          "see the separator note in models/SiteItem.js",
      );
    }
  }
  return columns.join(" | ");
};

/**
 * Builds every SiteItem chrome row from the site.ts shapes above.
 *
 * Exported so the mapping can be checked — row counts, `fields` validation —
 * WITHOUT a database connection, the same way scripts/seedSiteItems.js exports
 * `buildRows`. This seed points at production Mongo, so "run it and look" is
 * not an available way to test it.
 *
 * @returns {object[]} rows shaped for the SiteItem schema
 */
export const buildChromeRows = () => {
  const rows = [];

  stats.forEach((s, i) => {
    rows.push({
      collectionKey: "stats",
      title: s.label,
      sortOrder: step(i),
      fields: { value: s.value, count: s.count, suffix: s.suffix },
    });
  });

  marqueeItems.forEach((word, i) => {
    rows.push({
      collectionKey: "marquee",
      title: word,
      sortOrder: step(i),
      fields: {},
    });
  });

  navLinks.forEach((link, i) => {
    rows.push({
      collectionKey: "navlinks",
      title: link.label,
      // The destination is written to BOTH slots on purpose. `fields.href` is
      // the one that counts — it is the only one the model can make required —
      // and `ctaHref` is filled too so the row reads correctly in the generic
      // admin list, which prints the top-level CTA columns for every row.
      ctaHref: link.href,
      sortOrder: step(i),
      fields: { href: link.href },
    });
  });

  branches.forEach((b, i) => {
    rows.push({
      collectionKey: "branches",
      title: b.name,
      body: b.blurb,
      sortOrder: step(i),
      // The display TAG, not a tenancy boundary (see models/SiteItem.js). It is
      // set because this row genuinely IS that floor, which is what lets a
      // branch-filtered read narrow to one card. It matches models/Branch.js
      // `name` exactly, because that spelling is the one every other collection
      // stores.
      branch: b.area,
      fields: {
        slug: b.id,
        area: b.area,
        phone: b.phone,
        phoneHref: b.phoneHref,
        mapQuery: b.mapQuery,
        hours: b.hours.map((h) => joinTuple([h.days, h.time])),
        openingHours: b.openingHours.map((h) =>
          joinTuple([h.days.join(" "), h.opens, h.closes]),
        ),
      },
    });
  });

  media.forEach((m, i) => {
    rows.push({
      collectionKey: "media",
      title: m.title,
      sortOrder: step(i),
      fields: { slug: m.slug, video: m.video, poster: m.poster },
    });
  });

  return rows;
};

/**
 * Seeds the five chrome lists.
 *
 * Rows are validated through the SAME function the API uses rather than written
 * straight in. A seed that can insert a shape the controller would reject is a
 * seed that produces rows the admin panel cannot save back — the row opens, the
 * user changes one word, and the save 400s on a field they never touched.
 */
export const seedSiteChromeItems = async () => {
  const rows = buildChromeRows();
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const validated = validateItemFields(row.collectionKey, row.fields, {});
    if (validated.error) {
      throw new Error(
        `Seed row '${row.collectionKey}/${row.title}' is invalid: ${validated.error}`,
      );
    }

    const existing = await SiteItem.findOne({
      collectionKey: row.collectionKey,
      title: row.title,
    });
    if (existing) {
      skipped += 1;
      console.log(`• ${row.collectionKey}/${row.title} already exists`);
      continue;
    }

    await new SiteItem({ ...row, fields: validated.fields, isActive: true }).save();
    inserted += 1;
    console.log(`✅ Created ${row.collectionKey}: ${row.title}`);
  }

  const counts = rows.reduce((acc, r) => {
    acc[r.collectionKey] = (acc[r.collectionKey] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `✅ ${inserted} chrome row(s) inserted, ${skipped} left untouched, ` +
      `${rows.length} defined (${Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")})`,
  );
};

export const seedSiteContent = async () => {
  let inserted = 0;
  let skipped = 0;

  for (const section of SECTIONS) {
    const existing = await SiteContent.findOne({
      pageKey: section.pageKey,
      sectionKey: section.sectionKey,
    });

    if (existing) {
      skipped += 1;
      console.log(`• ${section.pageKey}/${section.sectionKey} already exists`);
      continue;
    }

    await new SiteContent({ isActive: true, ...section }).save();
    inserted += 1;
    console.log(`✅ Created ${section.pageKey}/${section.sectionKey}`);
  }

  console.log(
    `✅ ${inserted} section(s) inserted, ${skipped} left untouched, ${SECTIONS.length} defined`,
  );
};

if (process.argv[1] && process.argv[1].endsWith("seedSiteContent.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedSiteContent();
    // Second, and in the same run: the prose blocks and the chrome lists are
    // one feature ("the site chrome is editable"), and a database with only
    // half of them seeded is the half-editable state this file exists to avoid.
    await seedSiteChromeItems();
    console.log(
      "✅ Done. Open the CMS screens in the admin panel to edit these " +
        "(/cms/home, /cms/header, /cms/footer, /cms/social, /cms/site, " +
        "/cms/stats, /cms/marquee, /cms/navlinks, /cms/branches, /cms/media " +
        "— or /website-pages).",
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ Site content seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSiteContent;
