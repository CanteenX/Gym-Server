/**
 * Proves the Supabase storage wiring end to end: uploads a real PNG through
 * the same persistBuffer() seam the upload middleware uses, fetches the URL it
 * returns as an anonymous visitor would, then deletes the probe.
 *
 * Run it after pasting SUPABASE_SERVICE_ROLE_KEY into .env. A green run means
 * admin uploads will work; there is no need to drive the panel to find out.
 *
 *   node scripts/verifySupabaseStorage.js
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { persistBuffer } from "../storage/fileStore.js";

// Smallest valid PNG: the uploader verifies magic bytes, so a text file would
// be rejected before it ever reached storage and prove nothing.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const bucket = (process.env.SUPABASE_STORAGE_BUCKET || "gym-uploads").trim();

if (!url || !key) {
  console.error(
    "❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset — uploads would " +
      "still go to Vercel Blob or local disk. Nothing to verify.",
  );
  process.exit(1);
}

const name = `verify-${randomUUID()}.png`;

const stored = await persistBuffer(PNG, name, "image/png", "uploads");
console.log(`✅ uploaded -> ${stored}`);

if (!/^https:\/\/.+\.supabase\.co\/storage\//.test(stored)) {
  console.error(`❌ persistBuffer returned a non-Supabase reference: ${stored}`);
  process.exit(1);
}

// No Authorization header on purpose: this is exactly what a visitor's browser
// sends, and a public bucket is the only reason it should succeed.
const res = await fetch(stored);
const bytes = Buffer.from(await res.arrayBuffer());
if (!res.ok) {
  console.error(`❌ public read failed: HTTP ${res.status} — bucket is not public`);
  process.exit(1);
}
if (!bytes.equals(PNG)) {
  console.error(`❌ public read returned ${bytes.length} bytes, expected ${PNG.length}`);
  process.exit(1);
}
console.log(`✅ public read returned ${bytes.length} identical bytes, no auth header`);

const del = await fetch(`${url}/storage/v1/object/${bucket}/uploads/${name}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${key}` },
});
console.log(
  del.ok
    ? "✅ probe deleted"
    : `⚠️  probe left behind (HTTP ${del.status}) — delete uploads/${name} by hand`,
);
console.log("\nSupabase storage is live. Admin uploads now land in the bucket.");
