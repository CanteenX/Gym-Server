/**
 * Moves the site's imagery off third-party hotlinks and into our own bucket.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Every image on the live site is
 * currently fetched from images.unsplash.com and the two background videos from
 * videos.pexels.com. That is a hotlink to somebody else's server on every page
 * view: if they rate-limit us, re-encode, move or delete the asset, the gym's
 * home page loses its hero and nobody here changed anything. It also means the
 * site cannot be shown without internet access to a third party, and the CDN
 * that serves it is not one we can point at a domain or purge.
 *
 * Once an asset is in the bucket it is ours: served from the same CDN as member
 * photos, editable from the CMS, and unaffected by anyone else's decisions.
 *
 * WHAT IT TOUCHES
 *   SiteContent.imageUrl        page section imagery
 *   SiteItem.imageUrl           trainers, transformations, testimonials, ...
 *   SiteItem.fields.*           any http(s) value, which is how media.video
 *                               and media.poster are stored
 *
 * An asset already on Supabase is skipped, so this is safe to re-run and safe
 * to run again after new content is added.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It does not re-encode. The bytes that arrive are the bytes stored; the
 *     uploader's WebP conversion belongs to the admin upload path, and quietly
 *     transcoding somebody's chosen asset here would be a surprise.
 *   - It does not delete anything. The original URL is recorded on the row as
 *     `migratedFrom`, so a bad migration is one update away from being undone.
 *
 *   node scripts/migrateMediaToSupabase.js            # dry run, lists every asset
 *   node scripts/migrateMediaToSupabase.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import crypto from "node:crypto";

const APPLY = process.argv.includes("--apply");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET = (process.env.SUPABASE_STORAGE_BUCKET || "gym-uploads").trim();

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset — nothing to migrate into.");
  process.exit(1);
}

/** The bucket's own ceiling. Refuse before the upload rather than after. */
const MAX_BYTES = 50 * 1024 * 1024;

const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const isOurs = (url) => typeof url === "string" && url.startsWith(`${SUPABASE_URL}/storage/`);
const isRemote = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

/**
 * Fetches one asset and puts it in the bucket under a content-addressed name.
 *
 * The key is a hash of the SOURCE URL, not a random id, so re-running finds the
 * same object instead of filling the bucket with duplicates of the same photo,
 * and two rows pointing at the same stock image share one stored file.
 */
const migrateAsset = async (sourceUrl) => {
  const res = await fetch(sourceUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`source answered ${res.status}`);

  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`unsupported content-type "${type || "none"}"`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${(bytes.length / 1048576).toFixed(1)} MB exceeds the bucket's 50 MB limit`);
  }

  const key = `site/${crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32)}.${ext}`;
  const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": type,
      "x-upsert": "true",
      "cache-control": "public, max-age=31536000, immutable",
    },
    body: bytes,
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    throw new Error(`upload failed ${put.status}: ${detail.slice(0, 160)}`);
  }
  return {
    url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`,
    bytes: bytes.length,
    type,
  };
};

await mongoose.connect(process.env.DATABASE);
const db = mongoose.connection.db;

/** Every place an asset URL can live, flattened into one list of jobs. */
const jobs = [];
for (const r of await db.collection("sitecontents").find({}).toArray()) {
  if (isRemote(r.imageUrl) && !isOurs(r.imageUrl)) {
    jobs.push({ coll: "sitecontents", _id: r._id, path: "imageUrl", url: r.imageUrl, label: `${r.pageKey}/${r.sectionKey}` });
  }
}
for (const r of await db.collection("siteitems").find({}).toArray()) {
  if (isRemote(r.imageUrl) && !isOurs(r.imageUrl)) {
    jobs.push({ coll: "siteitems", _id: r._id, path: "imageUrl", url: r.imageUrl, label: `${r.collectionKey}/${r.title || r._id}` });
  }
  for (const [k, v] of Object.entries(r.fields || {})) {
    if (isRemote(v) && !isOurs(v)) {
      jobs.push({ coll: "siteitems", _id: r._id, path: `fields.${k}`, url: v, label: `${r.collectionKey}/${r.title || r._id} (${k})` });
    }
  }
}

console.log(`${APPLY ? "MIGRATING" : "DRY RUN"} — ${jobs.length} asset(s) not yet in the bucket\n`);

let ok = 0;
const failures = [];
const cache = new Map(); // same source URL twice -> one fetch, one upload

for (const job of jobs) {
  const from = new URL(job.url).host;
  if (!APPLY) {
    console.log(`  would move  ${job.label}  [${job.path}]  from ${from}`);
    continue;
  }
  try {
    if (!cache.has(job.url)) cache.set(job.url, await migrateAsset(job.url));
    const moved = cache.get(job.url);
    await db.collection(job.coll).updateOne(
      { _id: job._id },
      {
        $set: {
          [job.path]: moved.url,
          // Recorded, not discarded: an undo needs to know where it came from.
          [`migratedFrom.${job.path.replace(/\./g, "_")}`]: job.url,
          updatedAt: new Date(),
        },
      },
    );
    ok += 1;
    console.log(`  ✅ ${job.label}  [${job.path}]  ${(moved.bytes / 1024).toFixed(0)} KB  ${moved.type}`);
  } catch (err) {
    failures.push(`${job.label} [${job.path}]: ${err.message}`);
    console.log(`  ❌ ${job.label}  [${job.path}]  ${err.message}`);
  }
}

if (APPLY) {
  console.log(`\nmoved ${ok}/${jobs.length}`);
  if (failures.length) {
    console.log(`\n${failures.length} left on their original host (the row is unchanged and the site still works):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
} else {
  console.log("\nRe-run with --apply to move them.");
}

await mongoose.disconnect();
