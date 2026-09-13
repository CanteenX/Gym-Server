/**
 * Seeds the eight editable prose blocks the marketing pages actually read.
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
    console.log("✅ Done. Open /website-pages in the admin panel to edit these.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Site content seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSiteContent;
