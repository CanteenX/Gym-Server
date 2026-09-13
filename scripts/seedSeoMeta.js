/**
 * Seeds one SeoMeta row per real route in Gym-frontend.
 *
 * WHY THIS IS NOT OPTIONAL, AND WHY THE PORTAL ROUTES ARE IN IT:
 *
 *  - The marketing rows give the SEO Manager something to edit on day one. The
 *    frontend falls back to its layout defaults when a row is missing, so a
 *    missing row is not a broken page — but it is an uneditable one, and the
 *    screen looks empty and broken to whoever opens it.
 *  - The six portal rows exist for one reason: `noIndex: true`. /dashboard,
 *    /attendance and friends sit behind member auth; an indexed member portal
 *    is useless to a searcher and advertises the shape of the private app.
 *    They are seeded, not left to chance, because the safe value is the one
 *    nobody has to remember to set.
 *
 * Run from the Gym-Server directory:  npm run seed:seo
 *
 * Idempotent: every row is looked up by slug before it is created, and an
 * existing row is LEFT ALONE — re-running this must never overwrite copy that
 * someone edited in the admin panel. Pass --repair to fill in only the fields
 * that are still empty on an existing row (it never replaces a non-empty one),
 * which is the safe way to pick up a field added in a later phase.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import SeoMeta, { normalizeSlug } from "../models/SeoMeta.js";

dotenv.config();

/**
 * The slugs here must match the route paths in Gym-frontend/src/app exactly —
 * `(marketing)` and `(portal)` are route GROUPS and contribute nothing to the
 * URL, so the row for `(portal)/login/page.tsx` is "/login", not "/portal/login".
 * Every slug is still put through normalizeSlug below rather than trusted.
 */
const SEO_ROWS = [
  // ---------- Marketing: public, indexable ----------
  {
    slug: "/",
    pageTitle: "Home",
    category: "Marketing",
    icon: "ri-home-5-line",
    metaTitle: "Mid City Gym — Best Gym in Vadodara",
    metaDescription:
      "No Excuses. Just Results. Premium equipment, certified trainers and 15+ weekly classes across our Vasna and Gotri branches in Vadodara.",
    keywords: [
      "gym in Vadodara",
      "Mid City Gym",
      "Vasna gym",
      "Gotri gym",
      "personal trainer Vadodara",
    ],
    ogTitle: "Mid City Gym — Best Gym in Vadodara",
    ogDescription:
      "No Excuses. Just Results. Train at Vadodara's premium floor — Vasna & Gotri.",
  },
  {
    slug: "/programs",
    pageTitle: "Programs",
    category: "Marketing",
    icon: "ri-run-line",
    metaTitle: "Gym Programs & Group Classes in Vadodara",
    metaDescription:
      "Strength training, cardio, CrossFit-style conditioning, Zumba and personal training at Mid City Gym, Vasna and Gotri, Vadodara.",
    keywords: [
      "gym programs Vadodara",
      "group classes Vadodara",
      "Zumba Vadodara",
      "personal training Vadodara",
    ],
  },
  {
    slug: "/contact",
    pageTitle: "Contact",
    category: "Marketing",
    icon: "ri-phone-line",
    metaTitle: "Contact Mid City Gym — Vasna & Gotri, Vadodara",
    metaDescription:
      "Visit or call Mid City Gym in Vadodara. Book a free trial at our Vasna or Gotri branch and speak to a certified trainer.",
    keywords: ["Mid City Gym contact", "gym near me Vadodara", "gym free trial Vadodara"],
  },

  // ---------- Portal: behind member auth, never indexable ----------
  //
  // Deliberately carry no metaDescription, keywords or OG values. They are not
  // shareable pages; giving them social cards would only invite them to be
  // shared. `noIndex` is the field that matters and it is set on all six.
  {
    slug: "/login",
    pageTitle: "Member Login",
    category: "Portal",
    icon: "ri-login-box-line",
    metaTitle: "Member Login",
    noIndex: true,
  },
  {
    slug: "/dashboard",
    pageTitle: "Member Dashboard",
    category: "Portal",
    icon: "ri-dashboard-line",
    metaTitle: "Dashboard",
    noIndex: true,
  },
  {
    slug: "/attendance",
    pageTitle: "Attendance",
    category: "Portal",
    icon: "ri-calendar-check-line",
    metaTitle: "Attendance",
    noIndex: true,
  },
  {
    slug: "/weight",
    pageTitle: "Weight Tracker",
    category: "Portal",
    icon: "ri-scales-3-line",
    metaTitle: "Weight Tracker",
    noIndex: true,
  },
  {
    slug: "/workout",
    pageTitle: "Workout Plan",
    category: "Portal",
    icon: "ri-heart-pulse-line",
    metaTitle: "Workout Plan",
    noIndex: true,
  },
  {
    slug: "/change-password",
    pageTitle: "Change Password",
    category: "Portal",
    icon: "ri-lock-password-line",
    metaTitle: "Change Password",
    noIndex: true,
  },
];

/** Fields --repair may fill in when they are still empty on an existing row. */
const REPAIRABLE_FIELDS = [
  "icon",
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
];

export const seedSeoMeta = async ({ repair = false } = {}) => {
  let created = 0;
  let repaired = 0;

  for (const row of SEO_ROWS) {
    const slug = normalizeSlug(row.slug);
    if (!slug) {
      // Unreachable with the table above, but a typo in a later edit must fail
      // loudly rather than write a row the frontend can never find.
      throw new Error(`Seed row has an unusable slug: ${JSON.stringify(row.slug)}`);
    }

    const existing = await SeoMeta.findOne({ slug });
    if (existing) {
      if (!repair) {
        console.log(`• SEO row '${slug}' already exists`);
        continue;
      }

      let changed = false;
      for (const field of REPAIRABLE_FIELDS) {
        if (row[field] && !existing[field]) {
          existing[field] = row[field];
          changed = true;
        }
      }
      if (!existing.keywords?.length && row.keywords?.length) {
        existing.keywords = row.keywords;
        changed = true;
      }
      // noIndex is the one value --repair will assert even when it is already
      // set to something: a portal page that is indexable is a live mistake,
      // not a preference.
      if (row.noIndex && existing.noIndex !== true) {
        existing.noIndex = true;
        changed = true;
      }

      if (changed) {
        await existing.save();
        repaired += 1;
        console.log(`✅ Repaired empty fields on '${slug}'`);
      } else {
        console.log(`• SEO row '${slug}' already complete`);
      }
      continue;
    }

    await new SeoMeta({
      ...row,
      slug,
      keywords: row.keywords || [],
      noIndex: row.noIndex === true,
      isActive: true,
    }).save();
    console.log(
      `✅ Created SEO row: ${slug} — ${row.pageTitle}${row.noIndex ? " (noIndex)" : ""}`,
    );
    created += 1;
  }

  console.log(
    `✅ ${created} row(s) inserted, ${repaired} repaired, ${SEO_ROWS.length} total defined`,
  );
};

// Direct execution (npm run seed:seo) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedSeoMeta.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedSeoMeta({ repair: process.argv.includes("--repair") });
    console.log("✅ Done. Open /seo-manager in the admin panel to edit these.");
    process.exit(0);
  } catch (err) {
    console.error("❌ SEO metadata seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSeoMeta;
