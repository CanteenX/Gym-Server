import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { IS_SERVERLESS } from "../config/runtime.js";

const LOCAL_DIR = "uploads";

/**
 * Single place that turns a finished multer upload into a stored, servable
 * reference. Two very different backends sit behind one return value:
 *
 *   local  -> "uploads/<uuid>.webp"        (relative path, served by express.static)
 *   Vercel -> "https://<id>.public.blob…"  (absolute URL, served by Blob's CDN)
 *
 * Callers must treat the return value as opaque. `fileUrl()` on both clients
 * already passes absolute URLs through untouched, so the same DB rows keep
 * working across the two backends and no migration is required for existing
 * relative paths.
 */

/** Reads the bytes regardless of whether multer used memory or disk storage. */
async function toBuffer(file) {
  if (file?.buffer) return file.buffer;
  if (file?.path) return fs.promises.readFile(file.path);
  return null;
}

/**
 * PDFs must never be re-encoded: the shared uploader would turn a member's ID
 * proof into a WebP and corrupt it. `.webp` is already in the target format.
 */
function shouldCompress(ext) {
  return ext !== ".pdf" && ext !== ".webp";
}

async function putBlob(buffer, key, contentType) {
  // Imported lazily so local development and the FTP/PM2 deploy never need the
  // package or a BLOB_READ_WRITE_TOKEN just to boot.
  const { put } = await import("@vercel/blob");
  const { url } = await put(key, buffer, {
    access: "public",
    contentType,
    // multer already generated a UUID name; a second random suffix would make
    // the stored URL impossible to predict from the DB row.
    addRandomSuffix: false,
  });
  return url;
}

async function putLocal(buffer, key) {
  await fs.promises.mkdir(LOCAL_DIR, { recursive: true });
  const dest = path.join(LOCAL_DIR, path.basename(key));
  await fs.promises.writeFile(dest, buffer);
  // Keep POSIX separators: these strings end up in URLs, and path.join emits
  // backslashes on Windows.
  return dest.split(path.sep).join("/");
}

/**
 * Stores an already-validated, already-processed buffer and returns its stored
 * reference. This is the single seam the upload middleware writes through, so
 * switching backends never requires touching a route or controller.
 *
 * @param {Buffer} buffer
 * @param {string} filename - secure filename multer/secureUpload generated
 * @param {string} contentType
 * @param {string} folder
 * @returns {Promise<string>} stored reference (relative path or absolute URL)
 */
export async function persistBuffer(buffer, filename, contentType, folder = LOCAL_DIR) {
  const key = `${folder}/${path.basename(filename)}`;
  return IS_SERVERLESS
    ? putBlob(buffer, key, contentType)
    : putLocal(buffer, key);
}

/**
 * @param {Express.Multer.File} file
 * @param {{ compress?: boolean, folder?: string }} options
 * @returns {Promise<string|null>} stored reference, or null when there is no file
 */
export async function saveUpload(file, options = {}) {
  const { compress = true, folder = LOCAL_DIR } = options;
  if (!file) return null;

  const original = file.originalname || file.path || "";
  let ext = path.extname(original).toLowerCase();
  let buffer = await toBuffer(file);
  if (!buffer) return null;

  let contentType = file.mimetype || "application/octet-stream";

  if (compress && shouldCompress(ext)) {
    try {
      const webp = await sharp(buffer).webp({ quality: 82 }).toBuffer();
      // Only take the conversion when it actually saved bytes, matching the
      // previous controller behaviour.
      if (webp.length < buffer.length) {
        buffer = webp;
        ext = ".webp";
        contentType = "image/webp";
      }
    } catch {
      // Not a raster image (or sharp is unavailable) - store the original bytes
      // rather than failing the whole request.
    }
  }

  const key = `${folder}/${randomUUID()}${ext}`;

  const stored = IS_SERVERLESS
    ? await putBlob(buffer, key, contentType)
    : await putLocal(buffer, key);

  // Clean up the temp file multer wrote, now that the bytes are stored.
  if (file.path && file.buffer == null && file.path !== stored) {
    await fs.promises.unlink(file.path).catch(() => {});
  }

  return stored;
}

/** Best-effort delete. Missing objects are not an error. */
export async function removeUpload(stored) {
  if (!stored) return;
  try {
    if (/^https?:\/\//i.test(stored)) {
      const { del } = await import("@vercel/blob");
      await del(stored);
    } else {
      await fs.promises.unlink(stored);
    }
  } catch {
    // Already gone, or the backend that wrote it is no longer configured.
  }
}

export default { saveUpload, removeUpload };
