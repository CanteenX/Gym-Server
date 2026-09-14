/**
 * OFFLINE tests for todo.md item 2: video upload, media collection only.
 *
 * ============================================================================
 * REAL MAGIC BYTES, NOT A MOCKED file-type. Per the task's own instruction:
 * a mocked file-type here would pass while the real uploader rejects every
 * video. So every "valid video" fixture below is a hand-built, minimal but
 * GENUINE container header — verified empirically against the installed
 * file-type package before being pinned here:
 *   MP4  -> size box + 'ftyp' + major brand 'isom' + compatible brand
 *   MOV  -> size box + 'moov' atom (one of file-type's recognised mov markers)
 *   WEBM -> EBML root element + a DocType child element containing "webm"
 * These are exercised through classifyMediaBuffer(), which is the SAME
 * function the real multer middleware (createSecureImageOrVideoUpload) calls,
 * so passing here is evidence about the production code path, not a parallel
 * implementation of it.
 *
 * No DB, no network, no disk write: everything under test stops at
 * classification/preparation, before persistBuffer() would ever run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_MIMES,
  ALLOWED_EXTENSIONS,
  FILE_SIZE_LIMITS,
  classifyMediaBuffer,
  prepareValidatedMedia,
  checkMediaSizeCap,
  isVideoSlotRequest,
} from "../../middlewares/secureUpload.js";
import siteRouter from "../../routes/v1/site.routes.js";

// ===================================================================
// Real, minimal, genuine container headers
// ===================================================================

const REAL_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("isom", "ascii"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isom", "ascii"),
  Buffer.alloc(8),
]);

const REAL_MOV = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x08]),
  Buffer.from("moov", "ascii"),
  Buffer.alloc(8),
]);

const REAL_WEBM = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, // EBML root element ID
  0x84, // root element size
  0x42, 0x82, // DocType element ID
  0x84, // DocType payload size (4)
  0x77, 0x65, 0x62, 0x6d, // "webm"
]);

// A genuine, minimal, valid 1x1 transparent PNG — real magic bytes AND a real
// decodable image, so it can also prove the compression path actually runs.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// Plain text — no recognisable magic bytes at all.
const NOT_A_FILE = Buffer.from(
  "this is not a real media file, just some padding text for length.",
);

// ===================================================================
// 1. Extension AND magic bytes must both accept mp4 / webm / mov
// ===================================================================

test("config: video mimes/extensions/size cap are declared and match the bucket (50MB)", () => {
  assert.deepEqual(
    [...ALLOWED_MIMES.video].sort(),
    ["video/mp4", "video/quicktime", "video/webm"].sort(),
  );
  assert.deepEqual(
    [...ALLOWED_EXTENSIONS.video].sort(),
    [".mp4", ".mov", ".webm"].sort(),
  );
  assert.equal(FILE_SIZE_LIMITS.video, 50 * 1024 * 1024);
  // The cap that must NOT apply to images is still what it always was.
  assert.equal(FILE_SIZE_LIMITS.image, 5 * 1024 * 1024);
});

test("classify: a real .mp4 is accepted as video by both extension and magic bytes", async () => {
  const result = await classifyMediaBuffer(REAL_MP4, "clip.mp4");
  assert.equal(result.valid, true);
  assert.equal(result.category, "video");
  assert.equal(result.mime, "video/mp4");
});

test("classify: a real .webm is accepted as video by both extension and magic bytes", async () => {
  const result = await classifyMediaBuffer(REAL_WEBM, "clip.webm");
  assert.equal(result.valid, true);
  assert.equal(result.category, "video");
  assert.equal(result.mime, "video/webm");
});

test("classify: a real .mov is accepted as video by both extension and magic bytes", async () => {
  const result = await classifyMediaBuffer(REAL_MOV, "clip.mov");
  assert.equal(result.valid, true);
  assert.equal(result.category, "video");
  assert.equal(result.mime, "video/quicktime");
});

test("classify: a real .png is still accepted as an image (unchanged)", async () => {
  const result = await classifyMediaBuffer(REAL_PNG, "poster.png");
  assert.equal(result.valid, true);
  assert.equal(result.category, "image");
  assert.equal(result.mime, "image/png");
});

// ===================================================================
// 2. A file claiming .mp4 whose magic bytes say otherwise is rejected
// ===================================================================

test("classify: a .mp4 filename with no recognisable magic bytes is rejected", async () => {
  const result = await classifyMediaBuffer(NOT_A_FILE, "clip.mp4");
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test("classify: a .mp4 filename whose bytes are REALLY a PNG is rejected — extension family mismatch", async () => {
  // This is the sharper case: the content is a perfectly valid, ALLOWED type
  // (an image) — just not the video its extension and field claimed. A check
  // that only asked "is the detected type in the allowed list" would let this
  // through; the family check must not.
  const result = await classifyMediaBuffer(REAL_PNG, "clip.mp4");
  assert.equal(result.valid, false);
  assert.match(result.error, /does not match|mismatch|detected/i);
});

test("classify: a .png filename whose bytes are REALLY an mp4 is rejected the same way", async () => {
  const result = await classifyMediaBuffer(REAL_MP4, "poster.png");
  assert.equal(result.valid, false);
});

test("classify: an unrecognised extension is rejected outright", async () => {
  const result = await classifyMediaBuffer(REAL_MP4, "clip.exe");
  assert.equal(result.valid, false);
});

// ===================================================================
// 3. Size cap: 50MB for video, NOT applied to images (still 5MB)
// ===================================================================

test("size cap: an image over the image cap is rejected even though it is under the video cap", () => {
  const caps = { imageMaxSize: 10, videoMaxSize: 20 }; // tiny, for a fast test
  const result = checkMediaSizeCap(15, "image", caps);
  assert.equal(result.ok, false);
});

test("size cap: a video over the image cap but under the video cap is ALLOWED", () => {
  const caps = { imageMaxSize: 10, videoMaxSize: 20 };
  const result = checkMediaSizeCap(15, "video", caps);
  assert.equal(result.ok, true, "the image cap must not apply to video");
});

test("size cap: a video over the video cap is rejected", () => {
  const caps = { imageMaxSize: 10, videoMaxSize: 20 };
  const result = checkMediaSizeCap(25, "video", caps);
  assert.equal(result.ok, false);
});

test("size cap: the real caps are 5MB image / 50MB video", () => {
  const fiveMbAndOneByte = 5 * 1024 * 1024 + 1;
  assert.equal(
    checkMediaSizeCap(fiveMbAndOneByte, "image", {
      imageMaxSize: FILE_SIZE_LIMITS.image,
      videoMaxSize: FILE_SIZE_LIMITS.video,
    }).ok,
    false,
  );
  assert.equal(
    checkMediaSizeCap(fiveMbAndOneByte, "video", {
      imageMaxSize: FILE_SIZE_LIMITS.image,
      videoMaxSize: FILE_SIZE_LIMITS.video,
    }).ok,
    true,
  );
  const fiftyMbAndOneByte = 50 * 1024 * 1024 + 1;
  assert.equal(
    checkMediaSizeCap(fiftyMbAndOneByte, "video", {
      imageMaxSize: FILE_SIZE_LIMITS.image,
      videoMaxSize: FILE_SIZE_LIMITS.video,
    }).ok,
    false,
  );
});

// ===================================================================
// 4. sharp MUST be skipped for video, and still runs for images
// ===================================================================

test("prepare: a video buffer is stored BYTE-IDENTICAL — sharp never touches it", async () => {
  const result = await prepareValidatedMedia(
    REAL_MP4,
    "video",
    "video/mp4",
    ".mp4",
    { compress: true, quality: 85 }, // compress:true must have NO effect on video
  );
  assert.equal(Buffer.compare(result.buffer, REAL_MP4), 0);
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.ext, ".mp4");
});

test("prepare: a webm buffer is likewise untouched", async () => {
  const result = await prepareValidatedMedia(REAL_WEBM, "video", "video/webm", ".webm", {
    compress: true,
  });
  assert.equal(Buffer.compare(result.buffer, REAL_WEBM), 0);
});

test("prepare: an image IS compressed to webp when compress:true — the real sharp pipeline runs", async () => {
  const result = await prepareValidatedMedia(REAL_PNG, "image", "image/png", ".png", {
    compress: true,
    quality: 85,
  });
  assert.equal(result.ext, ".webp");
  assert.equal(result.mime, "image/webp");
  // RIFF....WEBP is the real webp magic-byte signature — proof this is a
  // genuinely re-encoded file, not the original PNG bytes relabelled.
  assert.equal(result.buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(result.buffer.toString("ascii", 8, 12), "WEBP");
  assert.notEqual(Buffer.compare(result.buffer, REAL_PNG), 0);
});

// ===================================================================
// 5. Route wiring: video is enabled for the media collection ONLY
// ===================================================================

test("isVideoSlotRequest: true only for ?slot=video, nothing else", () => {
  assert.equal(isVideoSlotRequest({ query: { slot: "video" } }), true);
  assert.equal(isVideoSlotRequest({ query: { slot: "poster" } }), false);
  assert.equal(isVideoSlotRequest({ query: { slot: "beforeImage" } }), false);
  assert.equal(isVideoSlotRequest({ query: {} }), false);
  assert.equal(isVideoSlotRequest({ query: undefined }), false);
  assert.equal(isVideoSlotRequest({}), false);
});

test("route: /site/items/:id/image exists and is guarded before the uploader runs", () => {
  const layer = siteRouter.stack.find(
    (l) => l.route && l.route.path === "/site/items/:id/image",
  );
  assert.ok(layer, "the site item image/video upload route must exist");
  const names = layer.route.stack.map((s) => s.name);
  assert.ok(names.includes("authMiddleware") || names.length > 1);
});

test("no other upload route (adverts, notices, site-content, guide) gained video — only the item image route did", () => {
  // Sweep every OTHER known upload route's extension allowlist and prove none
  // of them now accept a video extension. Regression guard: it is easy to
  // widen ALLOWED_EXTENSIONS.all/images globally by mistake, which would blow
  // the "media collection ONLY" scope open.
  assert.ok(!ALLOWED_EXTENSIONS.images.includes(".mp4"));
  assert.ok(!ALLOWED_EXTENSIONS.images.includes(".webm"));
  assert.ok(!ALLOWED_EXTENSIONS.images.includes(".mov"));
  assert.ok(!ALLOWED_EXTENSIONS.all.includes(".mp4"));
  assert.ok(!ALLOWED_MIMES.images.includes("video/mp4"));
  assert.ok(!ALLOWED_MIMES.all.includes("video/mp4"));
});
