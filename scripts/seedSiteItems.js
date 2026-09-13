/**
 * Seeds the repeating marketing records that are currently HARDCODED in
 * Gym-frontend/src/lib/site.ts into SiteItem rows.
 *
 * WHY IT IS NOT OPTIONAL: without it the Website Pages screen shows a list
 * editor with nothing in it, and the only way for the owner to get their six
 * programme cards back is to retype them. Worse, the frontend cannot be
 * switched over to the API until the rows exist, so the hardcoded copy would
 * have to be deleted and re-entered by hand — the exact migration nobody does
 * carefully at 6pm.
 *
 * THE VALUES BELOW ARE COPIED VERBATIM FROM site.ts. Nothing here is invented.
 * When that file changes, change it here too (or re-run with --repair, which
 * fills in only what is still empty). The shapes are kept in their ORIGINAL
 * site.ts form — `programs`, `plans`, `schedule` and friends look exactly as
 * they do over there — and are mapped onto SiteItem by `buildRows()` at the
 * bottom, so a future diff against site.ts is a readable one.
 *
 * Run from the Gym-Server directory:  npm run seed:site-items
 *   --repair   fill fields that are still EMPTY on an existing row; never
 *              overwrites a value someone edited in the admin panel
 *
 * Idempotent: every row is looked up before it is created and an existing row
 * is LEFT ALONE. The lookup key is (collectionKey, title) for six of the seven
 * lists. `classes` is the exception and cannot use it — the timetable holds
 * five separate rows titled "Zumba", one per slot — so it is keyed on
 * (collectionKey, title, fields.day, fields.time), which is the natural key of
 * a timetable cell. See KEY_FIELDS.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import SiteItem, { validateItemFields } from "../models/SiteItem.js";

dotenv.config();

// ---------------------------------------------------------------------------
// VERBATIM FROM Gym-frontend/src/lib/site.ts
// ---------------------------------------------------------------------------

/** site.ts -> `programs` */
const programs = [
  {
    id: "strength",
    title: "Strength Training",
    description:
      "Progressive overload on premium racks, barbells and plates. Built around compound lifts with form coaching from day one.",
    image:
      "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=70",
    tags: ["Barbell", "Hypertrophy", "Powerlifting"],
  },
  {
    id: "personal",
    title: "Personal Training",
    description:
      "One-to-one programming with a dedicated coach. Your plan, your pace, with weekly check-ins on progress.",
    image:
      "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1200&q=70",
    tags: ["1-on-1", "Custom Plan", "Nutrition"],
  },
  {
    id: "cardio",
    title: "Cardio & Conditioning",
    description:
      "Treadmills, bikes and the conditioning floor — plus punching bags for rounds that actually burn.",
    image:
      "https://images.unsplash.com/photo-1591117207239-788bf8de6c3b?auto=format&fit=crop&w=1200&q=70",
    tags: ["HIIT", "Endurance", "Fat Loss"],
  },
  {
    id: "zumba",
    title: "Zumba",
    description:
      "High-energy group sessions that never feel like a workout. Come for one class, stay for the room.",
    image:
      "https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=1200&q=70",
    tags: ["Group", "Dance", "Cardio"],
  },
  {
    id: "yoga",
    title: "Yoga",
    description:
      "Mobility, breath and recovery work that keeps you training without the injuries.",
    image:
      "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=1200&q=70",
    tags: ["Mobility", "Recovery", "Breath"],
  },
  {
    id: "functional",
    title: "Functional Fitness",
    description:
      "Kettlebells, sleds and bodyweight circuits for strength that carries outside the gym.",
    image:
      "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1200&q=70",
    tags: ["Kettlebell", "Circuits", "Athletic"],
  },
];

/** site.ts -> `trainers`. Synthetic placeholder names, per that file's header. */
const trainers = [
  {
    name: "Rohit Parmar",
    role: "Head Strength Coach",
    focus: "Powerlifting · Form Correction",
    image:
      "https://images.unsplash.com/photo-1567013127542-490d757e51fc?auto=format&fit=crop&w=800&q=70",
  },
  {
    name: "Priya Shah",
    role: "Zumba & Group Fitness",
    focus: "Dance Cardio · Conditioning",
    image:
      "https://images.unsplash.com/photo-1594381898411-846e7d193883?auto=format&fit=crop&w=800&q=70",
  },
  {
    name: "Aakash Mehta",
    role: "Personal Trainer",
    focus: "Fat Loss · Transformation",
    image:
      "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=800&q=70",
  },
  {
    name: "Neha Desai",
    role: "Yoga & Mobility",
    focus: "Recovery · Flexibility",
    image:
      "https://images.unsplash.com/photo-1552196563-55cd4e45efb3?auto=format&fit=crop&w=800&q=70",
  },
];

/** site.ts -> `plans` */
const plans = [
  {
    id: "monthly",
    name: "Monthly",
    price: "₹1,200",
    period: "/ month",
    description: "No lock-in. Full floor access, any branch.",
    features: [
      "Full gym floor access",
      "Locker & changing room",
      "Both Vasna and Gotri branches",
      "Cancel anytime",
    ],
    featured: false,
    cta: "Start Monthly",
  },
  {
    id: "annual",
    name: "12 + 2 Months",
    price: "₹6,500",
    period: "/ year",
    description: "Our most-taken plan — two months free on top of twelve.",
    features: [
      "Everything in Monthly",
      "2 bonus months free",
      "All group classes included",
      "Free body composition check-ins",
      "Priority class booking",
    ],
    featured: true,
    cta: "Claim 12+2 Offer",
  },
  {
    id: "personal",
    name: "Personal Training",
    price: "₹5,000",
    period: "/ month",
    description: "Dedicated coach, custom programming and nutrition.",
    features: [
      "Everything in Monthly",
      "12 one-to-one sessions",
      "Custom training plan",
      "Nutrition guidance",
    ],
    featured: false,
    cta: "Book a Coach",
  },
];

/**
 * site.ts -> `schedule`. A GRID, not a list: `days` are the columns and each
 * `classes` entry is a row whose `slots` line up with `days` positionally.
 * `buildRows()` flattens it into one SiteItem per cell.
 */
const schedule = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  classes: [
    {
      time: "6:00 AM",
      slots: ["Strength", "Yoga", "Strength", "Yoga", "Strength", "Functional"],
    },
    {
      time: "8:00 AM",
      slots: ["Zumba", "Cardio", "Zumba", "Cardio", "Zumba", "Open Floor"],
    },
    {
      time: "5:00 PM",
      slots: [
        "Functional",
        "Strength",
        "Functional",
        "Strength",
        "HIIT",
        "Open Floor",
      ],
    },
    {
      time: "7:00 PM",
      slots: ["Zumba", "Yoga", "Zumba", "Yoga", "Zumba", "Open Floor"],
    },
  ],
};

/** site.ts -> `transformations`. Synthetic placeholder members. */
const transformations = [
  {
    name: "Karan M.",
    duration: "6 months",
    result: "−18 kg",
    quote:
      "I had tried three gyms before. The difference here was someone actually watching my form.",
    before:
      "https://images.unsplash.com/photo-1530021232320-687d8e3dba54?auto=format&fit=crop&w=800&q=70",
    after:
      "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=800&q=70",
  },
  {
    name: "Anjali P.",
    duration: "8 months",
    result: "+12 kg lean",
    quote:
      "Started with Zumba, ended up deadlifting twice my bodyweight. Still surprises me.",
    before:
      "https://images.unsplash.com/photo-1518310383802-640c2de311b2?auto=format&fit=crop&w=800&q=70",
    after:
      "https://images.unsplash.com/photo-1594381898411-846e7d193883?auto=format&fit=crop&w=800&q=70",
  },
  {
    name: "Devang S.",
    duration: "12 months",
    result: "−24 kg",
    quote:
      "The 12+2 plan meant I couldn't make excuses. Two free months is two months of no backing out.",
    before:
      "https://images.unsplash.com/photo-1541534741688-6078c6bfb5c5?auto=format&fit=crop&w=800&q=70",
    after:
      "https://images.unsplash.com/photo-1567013127542-490d757e51fc?auto=format&fit=crop&w=800&q=70",
  },
];

/** site.ts -> `testimonials`. Synthetic placeholder members. */
const testimonials = [
  {
    quote:
      "Premium equipment and trainers who actually correct you. Best gym in Vadodara, and I've tried most of them.",
    name: "Hardik J.",
    meta: "Member · Vasna",
  },
  {
    quote:
      "The Zumba batch is the reason I stopped skipping workouts. It genuinely doesn't feel like exercise.",
    name: "Sneha R.",
    meta: "Member · Gotri",
  },
  {
    quote:
      "Clean floor, working machines, no waiting for racks even at peak hours. That's all I wanted.",
    name: "Mitesh P.",
    meta: "Member · Vasna",
  },
];

/** site.ts -> `faqs` */
const faqs = [
  {
    q: "Can I try before joining?",
    a: "Yes. Walk into either branch for a free trial session — bring shoes and a water bottle, we'll handle the rest.",
  },
  {
    q: "Does my membership work at both branches?",
    a: "It does. Every plan includes full access to both the Vasna and Gotri floors at no extra cost.",
  },
  {
    q: "Are group classes included?",
    a: "Zumba, Yoga and conditioning classes are included on the 12+2 annual plan. On monthly, they're available as add-ons.",
  },
  {
    q: "Do you offer personal training?",
    a: "Yes — one-to-one coaching with custom programming and nutrition guidance. Ask at the front desk to be matched with a coach.",
  },
  {
    q: "What are the timings?",
    a: "Vasna opens at 5:00 AM and Gotri at 5:30 AM, both running until late evening. Sundays are morning-only at both branches.",
  },
];

// ---------------------------------------------------------------------------
// MAPPING
// ---------------------------------------------------------------------------

/**
 * Gaps of 10 rather than 1, 2, 3.
 *
 * The whole reason these rows exist is that the owner can reorder them, and
 * "put a new card between the second and the third" with consecutive integers
 * means renumbering everything below it. With gaps it is one number in one
 * input.
 */
const step = (index) => (index + 1) * 10;

/**
 * Extra keys that make a row unique WITHIN its collection, beyond the title.
 *
 * Only `classes` needs them, and it needs them badly: "Zumba" appears five
 * times in the timetable and "Open Floor" three, so a (collectionKey, title)
 * lookup would match the first one every time and the seed would insert one
 * row instead of twenty-four on the first run — then claim everything already
 * existed on the second.
 */
const KEY_FIELDS = {
  classes: ["day", "time"],
};

/**
 * Builds every SiteItem row from the site.ts shapes above.
 *
 * Exported so the mapping can be checked — row counts, shapes, `fields`
 * validation — WITHOUT a database connection. This seed points at production
 * Mongo, so "run it and look" is not an available way to test it.
 *
 * @returns {object[]} rows shaped for the SiteItem schema
 */
export const buildRows = () => {
  const rows = [];

  // programs: the card IS a title + description + photo, so it maps 1:1.
  programs.forEach((p, i) => {
    rows.push({
      collectionKey: "programs",
      title: p.title,
      body: p.description,
      imageUrl: p.image,
      sortOrder: step(i),
      // `slug` carries the original `id` across: it is what an anchor link or a
      // "learn more" href is built from, and losing it would silently change
      // every deep link into /programs.
      fields: { slug: p.id, tags: [...p.tags] },
    });
  });

  // plans: `cta` becomes the row's CTA label, which is what that column is for.
  // No ctaHref in site.ts — the buttons scroll to the contact form rather than
  // navigate, so the field is left empty rather than given an invented URL.
  plans.forEach((p, i) => {
    rows.push({
      collectionKey: "plans",
      title: p.name,
      subtitle: p.description,
      ctaLabel: p.cta,
      sortOrder: step(i),
      fields: {
        slug: p.id,
        price: p.price,
        period: p.period,
        features: [...p.features],
        featured: p.featured,
      },
    });
  });

  // faqs: question -> title, answer -> body. Nothing else to carry.
  faqs.forEach((f, i) => {
    rows.push({
      collectionKey: "faqs",
      title: f.q,
      body: f.a,
      sortOrder: step(i),
      fields: {},
    });
  });

  // trainers: no branch is recorded in site.ts, so `branch` is deliberately
  // left empty (= shows everywhere) rather than guessed. The owner can tag
  // them per floor in the admin panel.
  trainers.forEach((t, i) => {
    rows.push({
      collectionKey: "trainers",
      title: t.name,
      subtitle: t.role,
      imageUrl: t.image,
      sortOrder: step(i),
      fields: { focus: t.focus },
    });
  });

  /**
   * classes: the grid is flattened to ONE ROW PER CELL — 4 times × 6 days = 24.
   *
   * The alternative, one row per time with the six slots in an array, keeps the
   * row count down but makes "move Friday's 5pm HIIT to Thursday" an array-index
   * edit in a JSON textarea, and it cannot express a class that runs at only one
   * branch. One row per cell is what makes the timetable editable at all; the
   * frontend re-assembles the grid by grouping on fields.time and fields.day.
   *
   * "Open Floor" cells are seeded too. They are not a class, but they ARE what
   * that cell of the published timetable says, and dropping them would leave
   * holes the frontend would have to invent a filler for.
   *
   * sortOrder runs across the whole timetable in reading order, so the default
   * admin sort matches the published grid.
   */
  let classIndex = 0;
  schedule.classes.forEach((slot) => {
    slot.slots.forEach((name, dayIndex) => {
      rows.push({
        collectionKey: "classes",
        title: name,
        sortOrder: step(classIndex),
        fields: { day: schedule.days[dayIndex], time: slot.time },
      });
      classIndex += 1;
    });
  });

  // testimonials: quote -> body, because the quote is the content and the name
  // is the label on it. No rating exists in site.ts, so none is invented.
  testimonials.forEach((t, i) => {
    rows.push({
      collectionKey: "testimonials",
      title: t.name,
      subtitle: t.meta,
      body: t.quote,
      sortOrder: step(i),
      fields: {},
    });
  });

  // transformations: two photos and neither is "the" image, so both live in
  // `fields` and `imageUrl` stays empty — see the model's image slot comment.
  // `subtitle` is left empty rather than mirroring `duration` into it: two
  // copies of one value is two places to edit and one of them always goes
  // stale. The card reads duration and result out of `fields`.
  transformations.forEach((t, i) => {
    rows.push({
      collectionKey: "transformations",
      title: t.name,
      body: t.quote,
      sortOrder: step(i),
      fields: {
        duration: t.duration,
        result: t.result,
        beforeImage: t.before,
        afterImage: t.after,
      },
    });
  });

  return rows;
};

/** Top-level fields --repair may fill in when they are still empty on a row. */
const REPAIRABLE_FIELDS = ["subtitle", "body", "imageUrl", "ctaLabel"];

/**
 * The query that decides "does this row already exist?".
 *
 * @param {object} row a built row
 * @returns {object} a Mongo filter
 */
const lookupFilter = (row) => {
  const filter = { collectionKey: row.collectionKey, title: row.title };
  for (const key of KEY_FIELDS[row.collectionKey] || []) {
    filter[`fields.${key}`] = row.fields[key];
  }
  return filter;
};

export const seedSiteItems = async ({ repair = false } = {}) => {
  const rows = buildRows();
  let created = 0;
  let repaired = 0;

  for (const row of rows) {
    /**
     * Validated through the SAME function the API uses rather than written
     * straight in. A seed that can insert a shape the controller would reject
     * is a seed that produces rows the admin panel cannot save back — the row
     * opens, the user changes one word, and the save 400s on a field they never
     * touched.
     */
    const validated = validateItemFields(row.collectionKey, row.fields, {});
    if (validated.error) {
      throw new Error(
        `Seed row '${row.collectionKey}/${row.title}' is invalid: ${validated.error}`,
      );
    }

    const existing = await SiteItem.findOne(lookupFilter(row));
    if (existing) {
      if (!repair) {
        console.log(`• ${row.collectionKey}/${row.title} already exists`);
        continue;
      }

      let changed = false;
      for (const field of REPAIRABLE_FIELDS) {
        if (row[field] && !existing[field]) {
          existing[field] = row[field];
          changed = true;
        }
      }
      // Only keys that are MISSING are added; an edited price is never
      // overwritten. A new object, because Mongoose cannot see an in-place
      // change to a Mixed path.
      const merged = { ...(existing.fields || {}) };
      let fieldsChanged = false;
      for (const [key, value] of Object.entries(validated.fields)) {
        if (merged[key] === undefined) {
          merged[key] = value;
          fieldsChanged = true;
        }
      }
      if (fieldsChanged) {
        existing.fields = merged;
        existing.markModified("fields");
        changed = true;
      }

      if (changed) {
        await existing.save();
        repaired += 1;
        console.log(`✅ Repaired ${row.collectionKey}/${row.title}`);
      } else {
        console.log(`• ${row.collectionKey}/${row.title} already complete`);
      }
      continue;
    }

    await new SiteItem({ ...row, fields: validated.fields, isActive: true }).save();
    console.log(`✅ Created ${row.collectionKey}: ${row.title}`);
    created += 1;
  }

  const counts = rows.reduce((acc, r) => {
    acc[r.collectionKey] = (acc[r.collectionKey] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `✅ ${created} row(s) inserted, ${repaired} repaired, ${rows.length} total defined ` +
      `(${Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")})`,
  );
};

// Direct execution (npm run seed:site-items) owns its own connection lifecycle.
if (process.argv[1] && process.argv[1].endsWith("seedSiteItems.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedSiteItems({ repair: process.argv.includes("--repair") });
    console.log("✅ Done. Open /website-pages in the admin panel to edit these.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Site item seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSiteItems;
