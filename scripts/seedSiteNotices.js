/**
 * Seeds the SiteNotice collection — and seeds it EMPTY, on purpose.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO: invent gym announcements. Every
 * other seed in this directory backfills content that already existed somewhere
 * (scripts/seedSiteItems.js copies the hardcoded rows out of
 * Gym-frontend/src/lib/site.ts verbatim, and says so at the top). There is no
 * such prior art here. An announcement is the gym telling its members something
 * TRUE — "we are shut on Thursday", "the 7am class has moved to 7.30" — and a
 * seed script cannot know any of those. A plausible-looking invented notice is
 * worse than an empty screen: it goes live on the public website, members read
 * it, and somebody turns up to a gym that is open, or misses one that is shut.
 *
 * SO WHAT IS IT FOR, then. Two things:
 *
 *   1. `--example` writes ONE row, INACTIVE, so the owner opening
 *      /cms/announcements for the first time sees the shape of the thing rather
 *      than an empty table with no hint of what goes in it. isActive is false,
 *      so it is invisible on the public site no matter what its dates say
 *      (liveWindowFilter requires isActive before it looks at anything else).
 *      It is explicitly labelled as an example in its own body.
 *   2. Run with no flag it REPORTS: how many notices exist, of which kind, and
 *      how many are live right now — using the SAME isCurrentlyLive() the
 *      public endpoint filters on, so "the seed says 2 live" and "the site
 *      shows 2" cannot disagree. That is the check worth having after a deploy.
 *
 * Run from the Gym-Server directory:  node scripts/seedSiteNotices.js
 *   --example   create the one inactive example announcement, if absent
 *   --remove-example   delete it again once the owner has real notices
 *
 * Idempotent: the example is looked up by (kind, title) before it is created,
 * and an existing row is LEFT EXACTLY AS IT IS — this never rewrites a title, a
 * body or a schedule somebody has edited in the panel.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import SiteNotice, {
  NOTICE_KINDS,
  isCurrentlyLive,
  liveStatus,
} from "../models/SiteNotice.js";

dotenv.config();

/**
 * The single example row.
 *
 * INACTIVE AND UNDATED. Undated rather than given a window because a seeded
 * start date is a date somebody has to notice and change; `isActive: false` is
 * the one switch that is unambiguous in the admin list ("INACTIVE", not
 * "SCHEDULED — starts in 3 days"), and it is also the switch the owner will
 * flip when they write their first real notice.
 *
 * The title is the lookup key, so it must not read like a real announcement —
 * "Example" is in it precisely so nobody mistakes it for one, and so a real
 * notice can never collide with it.
 */
const EXAMPLE_ANNOUNCEMENT = {
  kind: "ANNOUNCEMENT",
  title: "Example — delete me",
  body:
    "This is an example announcement so you can see how one looks. Edit it, " +
    "or delete it and write your own. It is switched OFF, so members cannot " +
    "see it until you switch it on.",
  tone: "INFO",
  dismissible: true,
  startAt: null,
  endAt: null,
  sortOrder: 0,
  isActive: false,
};

/** Natural key for the example row. A real notice will never match it. */
const exampleQuery = {
  kind: EXAMPLE_ANNOUNCEMENT.kind,
  title: EXAMPLE_ANNOUNCEMENT.title,
};

/**
 * Counts what is there and what is live, using the model's own rule.
 *
 * @returns {Promise<void>}
 */
const report = async () => {
  const total = await SiteNotice.countDocuments({});
  console.log(`• ${total} notice row(s) in total`);

  const now = new Date();
  for (const kind of NOTICE_KINDS) {
    const rows = await SiteNotice.find({ kind })
      .select("title isActive startAt endAt")
      .lean();
    const live = rows.filter((row) => isCurrentlyLive(row, now));
    console.log(`• ${kind}: ${rows.length} row(s), ${live.length} live now`);
    for (const row of rows) {
      console.log(`    - [${liveStatus(row, now)}] ${row.title}`);
    }
  }
};

export const seedSiteNotices = async () => {
  if (process.argv.includes("--remove-example")) {
    const removed = await SiteNotice.deleteOne(exampleQuery);
    console.log(
      removed.deletedCount
        ? "✅ Example announcement removed"
        : "• No example announcement to remove",
    );
    await report();
    return;
  }

  if (!process.argv.includes("--example")) {
    console.log(
      "• Nothing seeded (default). This collection is intentionally empty — " +
        "announcements are things only the gym knows, so nothing here invents " +
        "them. Pass --example for one INACTIVE sample row.",
    );
    await report();
    return;
  }

  const existing = await SiteNotice.findOne(exampleQuery);
  if (existing) {
    console.log("• Example announcement already exists — left untouched");
  } else {
    await new SiteNotice(EXAMPLE_ANNOUNCEMENT).save();
    console.log(
      "✅ Created the example announcement (INACTIVE — invisible to members " +
        "until switched on)",
    );
  }

  await report();
};

// Direct execution owns its own connection lifecycle, as every other seed here
// does.
if (process.argv[1] && process.argv[1].endsWith("seedSiteNotices.js")) {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB");
    await seedSiteNotices();
    console.log("✅ Done.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Site notice seed failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

export default seedSiteNotices;
