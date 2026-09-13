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
 * `seo` is deliberately NOT seeded. Phase 2's SeoMeta supersedes it and wins
 * all-or-nothing, so a seeded seo row here would be dead weight that a future
 * reader would mistake for the live source of a page title.
 *
 * Run:  npm run seed:site-content
 * Idempotent: keyed on (pageKey, sectionKey), which is the model's unique
 * index. Existing rows are left exactly as they are - this never overwrites an
 * edit the owner has made.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import SiteContent from "../models/SiteContent.js";

dotenv.config();

const BIO = "No Excuses. Just Results.";
const TAGLINE = "Best Gym in Vadodara";
const CITY = "Vadodara";
const NAME = "Mid City Gym";

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
];

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
    console.log(
      "✅ Done. Open the CMS screens in the admin panel to edit these " +
        "(/cms/home, /cms/header, /cms/footer, /cms/social — or /website-pages).",
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ Site content seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSiteContent;
