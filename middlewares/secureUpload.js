/**
 * Secure File Upload Middleware
 * OWASP-compliant file upload security including:
 * - Magic byte validation (file-type library)
 * - Double extension attack prevention
 * - MIME type validation
 * - File size limits
 * - Secure random filename generation (UUID)
 * - Image compression and WebP conversion (requires Node 18+)
 *
 * OWASP File Upload Cheat Sheet:
 * https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
 */

import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "node:path";
import fs, { promises as fsPromises } from "node:fs";
import { IS_SERVERLESS } from "../config/runtime.js";
import { persistBuffer } from "../storage/fileStore.js";
import { fileTypeFromFile, fileTypeFromBuffer } from "file-type";

// sharp is a ~1.1 second native import. Loading it at module scope put that on
// the critical path of every serverless cold start, including the large
// majority of requests that never touch an upload. It is loaded on first actual
// use instead, and the result cached for the life of the container.
//
// Sharp requires Node.js 18+; if unavailable, compression is disabled rather
// than failing the upload.
let sharp = null;
let sharpAvailable = false;
let sharpLoad = null;

async function ensureSharp() {
  sharpLoad ??= (async () => {
    try {
      sharp = (await import("sharp")).default;
      sharpAvailable = true;
    } catch (err) {
      console.warn(
        "[UPLOAD] Sharp not available - image compression disabled. Requires Node 18+",
        err.message,
      );
      sharpAvailable = false;
    }
    return sharpAvailable;
  })();
  return sharpLoad;
}

// ============ SECURITY CONFIGURATION ============

/**
 * Dangerous extensions regex - blocks script/executable extensions
 * Prevents double-extension attacks (e.g., image.jpg.php)
 */
export const DANGEROUS_EXTENSIONS_REGEX =
  /\.(php|phtml|exe|sh|bash|pl|py|js|jsp|asp|aspx|bat|cmd|vbs|wsf|cgi|com|dll|msi|scr)(\.|$)/i;

/**
 * Allowed MIME types for different file categories
 *
 * `video` is intentionally its OWN category, not folded into `all`: `all` is
 * the generic upload allowlist used by guide.routes.js and the generic
 * createSecureUpload() factory, and neither of those should silently start
 * accepting video just because the bucket does. Only
 * createSecureImageOrVideoUpload() — wired to exactly one route, the media
 * collection's `video` slot — reads ALLOWED_MIMES.video at all (docs/todo.md
 * item 2: "media collection ONLY").
 */
export const ALLOWED_MIMES = {
  images: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"],
  documents: ["application/pdf"],
  // Matches the Supabase bucket's existing MIME allowlist (docs/todo.md,
  // "Supabase storage for uploads") — the bucket already accepts these three,
  // the server just never let anything reach it.
  video: ["video/mp4", "video/webm", "video/quicktime"],
  all: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "application/pdf",
  ],
};

/**
 * Allowed file extensions (must match MIME types)
 */
export const ALLOWED_EXTENSIONS = {
  images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico"],
  documents: [".pdf"],
  // .mov, not .qt — the brand file-type reports for a QuickTime container is
  // `video/quicktime`, and every real-world export from a phone or editor
  // uses .mov, so that is the extension staff will actually type at.
  video: [".mp4", ".webm", ".mov"],
  all: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".pdf"],
};

/**
 * Default file size limits (in bytes)
 */
export const FILE_SIZE_LIMITS = {
  image: 5 * 1024 * 1024, // 5 MB
  document: 10 * 1024 * 1024, // 10 MB
  default: 5 * 1024 * 1024, // 5 MB
  // Matches the Supabase bucket's own 50 MB cap. Deliberately NOT the image
  // cap raised for everyone — see checkMediaSizeCap(), which applies this only
  // to a buffer whose DETECTED type is video; an image uploaded through the
  // same route still has to fit in FILE_SIZE_LIMITS.image.
  video: 50 * 1024 * 1024,
};

// ============ HELPER FUNCTIONS ============

/**
 * Ensure upload directory exists with proper permissions
 * @param {string} directory - Directory path
 */
async function ensureUploadDir(directory) {
  try {
    await fsPromises.mkdir(directory, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

/**
 * Generate secure random filename with UUID
 * @param {string} originalName - Original filename
 * @param {string} [forceExt] - Force specific extension
 * @returns {string} Secure filename
 */
function generateSecureFilename(originalName, forceExt = null) {
  const uuid = uuidv4();
  const ext = forceExt || path.extname(originalName).toLowerCase();
  return `${uuid}${ext}`;
}

/**
 * Validate file using magic bytes (file signature)
 * @param {string} filePath - Path to the file
 * @param {string[]} allowedMimes - Array of allowed MIME types
 * @returns {Promise<{valid: boolean, detected: string|null}>}
 */
async function validateMagicBytes(filePath, allowedMimes) {
  try {
    const typeInfo = await fileTypeFromFile(filePath);

    if (!typeInfo) {
      return {
        valid: false,
        detected: null,
        error: "Could not determine file signature",
      };
    }

    if (!allowedMimes.includes(typeInfo.mime)) {
      return {
        valid: false,
        detected: typeInfo.mime,
        error: `File type mismatch. Detected: ${typeInfo.mime}`,
      };
    }

    return { valid: true, detected: typeInfo.mime };
  } catch (error) {
    return { valid: false, detected: null, error: error.message };
  }
}

/**
 * Validate buffer using magic bytes
 * @param {Buffer} buffer - File buffer
 * @param {string[]} allowedMimes - Array of allowed MIME types
 * @returns {Promise<{valid: boolean, detected: string|null}>}
 */
async function validateBufferMagicBytes(buffer, allowedMimes) {
  try {
    const typeInfo = await fileTypeFromBuffer(buffer);

    if (!typeInfo) {
      return {
        valid: false,
        detected: null,
        error: "Could not determine file signature",
      };
    }

    if (!allowedMimes.includes(typeInfo.mime)) {
      return {
        valid: false,
        detected: typeInfo.mime,
        error: `File type mismatch. Detected: ${typeInfo.mime}`,
      };
    }

    return { valid: true, detected: typeInfo.mime };
  } catch (error) {
    return { valid: false, detected: null, error: error.message };
  }
}

// ============ MEDIA (IMAGE + VIDEO) — media collection ONLY ============
//
// docs/todo.md item 2. Everything below is used by exactly ONE route —
// the SiteItem image upload, and only when ?slot=video (site.routes.js) —
// so widening ALLOWED_EXTENSIONS.images/all itself, which every OTHER
// uploader in this file reads, would have been the wrong lever.

/** "video" | "image" | null, from an extension the client's filename claims. */
const familyOfExt = (ext) => {
  if (ALLOWED_EXTENSIONS.video.includes(ext)) return "video";
  if (ALLOWED_EXTENSIONS.images.includes(ext)) return "image";
  return null;
};

/** "video" | "image" | null, from a magic-byte-DETECTED mime type. */
const familyOfMime = (mime) => {
  if (!mime) return null;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return null;
};

/**
 * Validates an uploaded (image OR video) buffer against BOTH its claimed
 * extension and its actual magic bytes, and — the check a plain "is the
 * detected type somewhere in the allowlist" test would miss — that the two
 * AGREE ON FAMILY.
 *
 * WHY THE FAMILY CHECK, SPECIFICALLY: once video and image mimes are both
 * accepted on one route, a JPEG renamed "clip.mp4" is not rejected by "is
 * image/jpeg an allowed mime" — it is, images are still allowed here. It has
 * to be rejected because the field claiming to be a VIDEO turned out to hold
 * an image, which `validateBufferMagicBytes` alone cannot express. This is
 * the direct answer to docs/todo.md's "a file claiming to be .mp4 whose magic
 * bytes say otherwise must still be rejected".
 *
 * @param {Buffer} buffer
 * @param {string} originalname - the client's filename, for its extension
 * @returns {Promise<{valid:boolean, category?:'image'|'video', mime?:string, ext?:string, error?:string}>}
 */
export async function classifyMediaBuffer(buffer, originalname) {
  const ext = path.extname(String(originalname || "").toLowerCase());
  const claimedFamily = familyOfExt(ext);

  if (!claimedFamily) {
    return {
      valid: false,
      error: `Unsupported extension "${ext}". Allowed: ${[
        ...ALLOWED_EXTENSIONS.images,
        ...ALLOWED_EXTENSIONS.video,
      ].join(", ")}`,
    };
  }

  const validation = await validateBufferMagicBytes(buffer, [
    ...ALLOWED_MIMES.images,
    ...ALLOWED_MIMES.video,
  ]);
  if (!validation.valid) {
    return { valid: false, error: validation.error || "Invalid file type" };
  }

  const detectedFamily = familyOfMime(validation.detected);
  if (detectedFamily !== claimedFamily) {
    return {
      valid: false,
      error: `File extension "${ext}" does not match its actual content (detected: ${validation.detected || "unknown"}).`,
    };
  }

  return { valid: true, category: detectedFamily, mime: validation.detected, ext };
}

/**
 * Per-category size cap. THE POINT OF THIS BEING SEPARATE FROM MULTER'S OWN
 * `limits.fileSize`: multer's ceiling is a single number, checked before the
 * real type is known, so it is set to the LARGER of the two caps (video) so a
 * legitimate video is never truncated mid-stream. This function then applies
 * the SMALLER cap retroactively to anything that turns out to be an image —
 * which is what keeps the 5 MB image limit real instead of quietly becoming
 * 50 MB for everyone the day video was enabled.
 *
 * @param {number} byteLength
 * @param {'image'|'video'} category
 * @param {{imageMaxSize:number, videoMaxSize:number}} caps
 * @returns {{ok:boolean, cap:number}}
 */
export function checkMediaSizeCap(byteLength, category, caps) {
  const cap = category === "video" ? caps.videoMaxSize : caps.imageMaxSize;
  return { ok: byteLength <= cap, cap };
}

/**
 * Produces the bytes actually handed to persistBuffer() for one validated
 * file.
 *
 * ============================================================================
 * VIDEO IS NEVER HANDED TO SHARP. NOT "SHARP WITH COMPRESSION OFF" — SKIPPED.
 * ============================================================================
 * Sharp decodes image containers; a video container is not one, and CLAUDE.md
 * already records this exact failure mode for PDFs run through the shared
 * WebP compressor — it does not politely no-op, it corrupts the file. The
 * `compress` option below therefore has NO EFFECT on a video buffer: it is
 * read only when category is "image".
 *
 * @param {Buffer} buffer - already validated by classifyMediaBuffer
 * @param {'image'|'video'} category
 * @param {string} mime - the detected mime from classifyMediaBuffer
 * @param {string} ext - the detected extension from classifyMediaBuffer
 * @param {{compress?:boolean, quality?:number}} [options]
 * @returns {Promise<{buffer:Buffer, mime:string, ext:string}>}
 */
export async function prepareValidatedMedia(buffer, category, mime, ext, options = {}) {
  if (category === "video") {
    return { buffer, mime, ext };
  }

  const { compress = true, quality = 85 } = options;
  if (compress && (await ensureSharp())) {
    const webp = await compressToWebP(buffer, { quality });
    return { buffer: webp, mime: "image/webp", ext: ".webp" };
  }
  return { buffer, mime, ext };
}

/**
 * True only when the request is asking for the ONE slot video is enabled on.
 * Deliberately reads req.query, not req.body: multer has not parsed the
 * multipart body yet at the point site.routes.js needs this answer (it picks
 * which multer instance to run), and the admin's upload call already sends
 * `slot` on the query string for exactly this reason (see
 * uploadSiteItemImage's own comment on where `slot` may come from).
 *
 * @param {{query?: Record<string, unknown>}} req
 * @returns {boolean}
 */
export const isVideoSlotRequest = (req) => req?.query?.slot === "video";

/**
 * Create secure upload middleware for a route that accepts EITHER an image OR
 * a video — used for exactly one route, the media collection's `video` slot
 * (site.routes.js), never mounted anywhere generic.
 *
 * Mirrors createSecureImageUpload's shape (same error codes, same
 * req.file.path/size/mimetype contract) so the controller downstream
 * (uploadSiteItemImage) needed no change at all.
 *
 * @param {object} options
 * @returns {Function} Express middleware
 */
export function createSecureImageOrVideoUpload(options = {}) {
  const {
    destination = "uploads",
    fieldName = "file",
    imageMaxSize = FILE_SIZE_LIMITS.image,
    videoMaxSize = FILE_SIZE_LIMITS.video,
    compress = true,
    quality = 85,
  } = options;

  const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: createFileFilter(
      [...ALLOWED_MIMES.images, ...ALLOWED_MIMES.video],
      [...ALLOWED_EXTENSIONS.images, ...ALLOWED_EXTENSIONS.video],
    ),
    // The larger of the two caps — see checkMediaSizeCap() for why the
    // smaller (image) cap is enforced AFTER classification instead.
    limits: { fileSize: videoMaxSize },
  });

  return (req, res, next) => {
    const uploader = upload.single(fieldName);

    uploader(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${videoMaxSize / (1024 * 1024)}MB limit`,
          });
        }
        return res.status(400).json({
          isOk: false,
          status: 400,
          error: "Upload Error",
          message: err.message,
        });
      }

      if (!req.file) {
        return next();
      }

      try {
        const classified = await classifyMediaBuffer(
          req.file.buffer,
          req.file.originalname,
        );
        if (!classified.valid) {
          console.warn(
            `[SECURITY] Media validation failed for upload: ${classified.error}`,
          );
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "Security Validation Failed",
            message: classified.error || "Invalid file type",
          });
        }

        const sizeCheck = checkMediaSizeCap(
          req.file.buffer.length,
          classified.category,
          { imageMaxSize, videoMaxSize },
        );
        if (!sizeCheck.ok) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${(sizeCheck.cap / (1024 * 1024)).toFixed(0)}MB limit for ${classified.category}`,
          });
        }

        const prepared = await prepareValidatedMedia(
          req.file.buffer,
          classified.category,
          classified.mime,
          classified.ext,
          { compress, quality },
        );

        if (!IS_SERVERLESS) await ensureUploadDir(destination);
        const secureFilename = generateSecureFilename(
          req.file.originalname,
          prepared.ext,
        );
        const filePath = await persistBuffer(
          prepared.buffer,
          secureFilename,
          prepared.mime,
          destination,
        );

        req.file.filename = secureFilename;
        req.file.path = filePath;
        req.file.size = prepared.buffer.length;
        req.file.mimetype = prepared.mime;
        req.file.isVideo = classified.category === "video";
        req.file.originalSize = req.file.buffer.length;

        delete req.file.buffer;
        next();
      } catch (error) {
        console.error("[UPLOAD] Media processing error:", error.message);
        return res.status(500).json({
          isOk: false,
          status: 500,
          error: "Processing Error",
          message: "Failed to process uploaded file",
        });
      }
    });
  };
}

/**
 * Compress image to WebP format
 * @param {Buffer|string} input - Image buffer or file path
 * @param {object} options - Compression options
 * @returns {Promise<Buffer>} Compressed WebP buffer
 */
async function compressToWebP(input, options = {}) {
  if (!Buffer.isBuffer(input)) {
    throw new TypeError("Input to compressToWebP must be a Buffer");
  }

  // If sharp is not available, return the original buffer
  if (!(await ensureSharp()) || !sharp) {
    console.warn("[UPLOAD] Compression skipped - sharp not available");
    return input;
  }

  const { quality = 85, maxWidth = 1920, maxHeight = 1080 } = options;

  try {
    let sharpInstance = sharp(input);

    // Get metadata for smart resizing
    const metadata = await sharpInstance.metadata();

    // Resize if larger than max dimensions (preserve aspect ratio)
    if (metadata.width > maxWidth || metadata.height > maxHeight) {
      sharpInstance = sharpInstance.resize(maxWidth, maxHeight, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    // Convert to WebP with quality setting
    const webpBuffer = await sharpInstance
      .webp({ quality: Math.max(10, Math.min(100, quality)) })
      .toBuffer();

    return webpBuffer;
  } catch (error) {
    console.error("Image compression failed:", error.message);
    throw new Error(`Image compression failed: ${error.message}`);
  }
}

/**
 * Compress image to target size (iterative quality reduction)
 * @param {Buffer} buffer - Image buffer
 * @param {number} targetSize - Target size in bytes
 * @param {number} minQuality - Minimum quality to use
 * @returns {Promise<Buffer>} Compressed buffer
 */
async function compressToTargetSize(buffer, targetSize, minQuality = 20) {
  // If sharp is not available, return the original buffer
  if (!(await ensureSharp()) || !sharp) {
    console.warn("[UPLOAD] Compression skipped - sharp not available");
    return buffer;
  }

  let quality = 85;
  let compressed = buffer;

  while (compressed.length > targetSize && quality > minQuality) {
    compressed = await sharp(buffer).webp({ quality }).toBuffer();
    quality -= 10;
  }

  return compressed;
}

// ============ MULTER STORAGE CONFIGURATION ============

/**
 * Create secure multer storage configuration
 * @param {object} options - Storage options
 * @returns {multer.StorageEngine} Multer storage engine
 */
function createSecureStorage(options = {}) {
  const { destination = "uploads", useMemory = false } = options;

  // Vercel has no writable disk, so diskStorage would throw EROFS mid-stream.
  // Buffer instead and let persistBuffer() push the bytes to Blob storage.
  if (useMemory || IS_SERVERLESS) {
    return multer.memoryStorage();
  }

  // Ensure upload directory exists
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, destination);
    },
    filename: (req, file, cb) => {
      // Generate secure random filename
      const secureFilename = generateSecureFilename(file.originalname);
      cb(null, secureFilename);
    },
  });
}

/**
 * Create file filter for multer
 * @param {string[]} allowedMimes - Allowed MIME types
 * @param {string[]} allowedExts - Allowed file extensions
 * @returns {Function} Multer file filter
 */
function createFileFilter(allowedMimes, allowedExts) {
  return (req, file, cb) => {
    const originalName = file.originalname.toLowerCase();
    const ext = path.extname(originalName);

    // Check for dangerous extensions (double extension attack)
    if (DANGEROUS_EXTENSIONS_REGEX.test(originalName)) {
      console.warn(`[SECURITY] Blocked dangerous extension: ${originalName}`);
      return cb(new Error("Potentially dangerous file type detected."));
    }

    // Validate file extension
    if (!allowedExts.includes(ext)) {
      return cb(
        new Error(`Invalid file extension. Allowed: ${allowedExts.join(", ")}`),
      );
    }

    // Validate MIME type (client-reported)
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(
        new Error(`Invalid file type. Allowed: ${allowedMimes.join(", ")}`),
      );
    }

    cb(null, true);
  };
}

// ============ MIDDLEWARE FACTORIES ============

/**
 * Create secure upload middleware for images
 * Includes: validation, compression, WebP conversion
 * @param {object} options - Middleware options
 * @returns {Function} Express middleware
 */
export function createSecureImageUpload(options = {}) {
  const {
    destination = "uploads",
    fieldName = "file",
    maxSize = FILE_SIZE_LIMITS.image,
    compress = true,
    convertToWebP = true,
    targetSize = null, // Target file size in bytes
    quality = 85,
  } = options;

  const upload = multer({
    storage: multer.memoryStorage(), // Use memory for processing
    fileFilter: createFileFilter(
      ALLOWED_MIMES.images,
      ALLOWED_EXTENSIONS.images,
    ),
    limits: { fileSize: maxSize },
  });

  return (req, res, next) => {
    const uploader = upload.single(fieldName);

    uploader(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${maxSize / (1024 * 1024)}MB limit`,
          });
        }
        return res.status(400).json({
          isOk: false,
          status: 400,
          error: "Upload Error",
          message: err.message,
        });
      }

      if (!req.file) {
        return next(); // No file uploaded, continue (might be optional)
      }

      try {
        // 1. Validate magic bytes
        const validation = await validateBufferMagicBytes(
          req.file.buffer,
          ALLOWED_MIMES.images,
        );

        if (!validation.valid) {
          console.warn(`[SECURITY] Magic byte validation failed for upload`);
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "Security Validation Failed",
            message: validation.error || "Invalid file type",
          });
        }

        // 2. Process image (compress and/or convert)
        let processedBuffer = req.file.buffer;
        let finalExt = path.extname(req.file.originalname).toLowerCase();
        

        if ((compress || convertToWebP) && (await ensureSharp())) {
          if (targetSize) {
            // Compress to target size
            processedBuffer = await compressToTargetSize(
              req.file.buffer,
              targetSize,
            );
            finalExt = ".webp";
            
          } else {
            // Standard compression
            processedBuffer = await compressToWebP(req.file.buffer, {
              quality,
            });
            finalExt = ".webp";
        
          }
        }

        // 3. Hand the processed bytes to the storage backend (disk locally,
        //    Vercel Blob on serverless). filePath is a relative path or an
        //    absolute URL depending on backend - callers treat it as opaque.
        if (!IS_SERVERLESS) await ensureUploadDir(destination);
        const secureFilename = generateSecureFilename(
          req.file.originalname,
          finalExt,
        );
        const filePath = await persistBuffer(
          processedBuffer,
          secureFilename,
          "image/webp",
          destination,
        );

        // 4. Update req.file with processed file info
        req.file.filename = secureFilename;
        req.file.path = filePath;
        req.file.size = processedBuffer.length;
        req.file.mimetype = "image/webp";
        req.file.originalSize = req.file.buffer.length;
        req.file.compressionRatio = (
          ((req.file.buffer.length - processedBuffer.length) /
            req.file.buffer.length) *
          100
        ).toFixed(2);

        // Remove buffer from memory
        delete req.file.buffer;
        next();
      } catch (error) {
        console.error("[UPLOAD] Processing error:", error.message);
        return res.status(500).json({
          isOk: false,
          status: 500,
          error: "Processing Error",
          message: "Failed to process uploaded file",
        });
      }
    });
  };
}

/**
 * Create secure upload middleware for documents (PDF)
 * Includes: validation, magic byte check
 * @param {object} options - Middleware options
 * @returns {Function} Express middleware
 */
/**
 * Verifies magic bytes and commits the upload to the storage backend.
 *
 * The two single-file factories below accept whatever storage createSecureStorage
 * picked: a disk path locally, an in-memory buffer on Vercel. Both shapes are
 * validated the same way and both end up with `req.file.path` pointing at the
 * stored reference, so controllers never learn which backend ran.
 *
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function finalizeSingleUpload(req, allowedMimes, destination) {
  const file = req.file;

  if (file.buffer) {
    const validation = await validateBufferMagicBytes(file.buffer, allowedMimes);
    if (!validation.valid) return validation;

    // Never re-encode here: this path carries PDFs (member ID proofs), and the
    // shared compressor would silently turn them into corrupt WebP.
    const secureFilename = generateSecureFilename(file.originalname);
    file.path = await persistBuffer(
      file.buffer,
      secureFilename,
      file.mimetype || "application/octet-stream",
      destination,
    );
    file.filename = secureFilename;
    delete file.buffer;
    return { valid: true };
  }

  const validation = await validateMagicBytes(file.path, allowedMimes);
  if (!validation.valid) {
    try {
      await fsPromises.unlink(file.path);
    } catch (unlinkErr) {
      console.error("Failed to delete invalid file:", unlinkErr);
    }
  }
  return validation;
}

export function createSecureDocumentUpload(options = {}) {
  const {
    destination = "uploads",
    fieldName = "file",
    maxSize = FILE_SIZE_LIMITS.document,
  } = options;

  const upload = multer({
    storage: createSecureStorage({ destination }),
    fileFilter: createFileFilter(
      ALLOWED_MIMES.documents,
      ALLOWED_EXTENSIONS.documents,
    ),
    limits: { fileSize: maxSize },
  });

  return (req, res, next) => {
    const uploader = upload.single(fieldName);

    uploader(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${maxSize / (1024 * 1024)}MB limit`,
          });
        }
        return res.status(400).json({
          isOk: false,
          status: 400,
          error: "Upload Error",
          message: err.message,
        });
      }

      if (!req.file) {
        return next();
      }

      try {
        const validation = await finalizeSingleUpload(
          req,
          ALLOWED_MIMES.documents,
          destination,
        );

        if (!validation.valid) {
          console.warn(
            `[SECURITY] Magic byte validation failed for document upload`,
          );
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "Security Validation Failed",
            message: validation.error || "Invalid file type",
          });
        }

        next();
      } catch (error) {
        console.error("[UPLOAD] Validation error:", error.message);
        return res.status(500).json({
          isOk: false,
          status: 500,
          error: "Validation Error",
          message: "Failed to validate uploaded file",
        });
      }
    });
  };
}

/**
 * Create generic secure upload middleware
 * @param {object} options - Middleware options
 * @returns {Function} Express middleware
 */
export function createSecureUpload(options = {}) {
  const {
    destination = "uploads",
    fieldName = "file",
    maxSize = FILE_SIZE_LIMITS.default,
    allowedMimes = ALLOWED_MIMES.all,
    allowedExts = ALLOWED_EXTENSIONS.all,
  } = options;

  const upload = multer({
    storage: createSecureStorage({ destination }),
    fileFilter: createFileFilter(allowedMimes, allowedExts),
    limits: { fileSize: maxSize },
  });

  return (req, res, next) => {
    const uploader = upload.single(fieldName);

    uploader(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${maxSize / (1024 * 1024)}MB limit`,
          });
        }
        return res.status(400).json({
          isOk: false,
          status: 400,
          error: "Upload Error",
          message: err.message,
        });
      }

      if (!req.file) {
        return next();
      }

      try {
        const validation = await finalizeSingleUpload(
          req,
          allowedMimes,
          destination,
        );

        if (!validation.valid) {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "Security Validation Failed",
            message: validation.error || "Invalid file type",
          });
        }

        
        next();
      } catch (error) {
        console.error("[UPLOAD] Validation error:", error.message);
        return res.status(500).json({
          isOk: false,
          status: 500,
          error: "Validation Error",
          message: "Failed to validate uploaded file",
        });
      }
    });
  };
}

/**
 * Create secure upload middleware for multiple files
 * @param {object} options - Middleware options
 * @returns {Function} Express middleware
 */
export function createSecureMultiUpload(options = {}) {
  const {
    destination = "uploads",
    fields = [{ name: "files", maxCount: 5 }],
    maxSize = FILE_SIZE_LIMITS.default,
    allowedMimes = ALLOWED_MIMES.images,
    allowedExts = ALLOWED_EXTENSIONS.images,
    compress = true,
    quality = 85,
  } = options;

  const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: createFileFilter(allowedMimes, allowedExts),
    limits: { fileSize: maxSize },
  });

  return (req, res, next) => {
    const uploader = upload.fields(fields);

    uploader(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            isOk: false,
            status: 400,
            error: "File Too Large",
            message: `File size exceeds ${maxSize / (1024 * 1024)}MB limit`,
          });
        }
        return res.status(400).json({
          isOk: false,
          status: 400,
          error: "Upload Error",
          message: err.message,
        });
      }

      try {
        if (!IS_SERVERLESS) await ensureUploadDir(destination);

        // Process each field's files
        for (const field of fields) {
          const files = req.files?.[field.name] || [];

          for (const file of files) {
            // Validate magic bytes
            const validation = await validateBufferMagicBytes(
              file.buffer,
              allowedMimes,
            );
            if (!validation.valid) {
              return res.status(400).json({
                isOk: false,
                status: 400,
                error: "Security Validation Failed",
                message: `File validation failed: ${validation.error}`,
              });
            }

            // Process image if compression is enabled and sharp is available
            let processedBuffer = file.buffer;
            let finalExt = path.extname(file.originalname).toLowerCase();

            if (
              compress &&
              (await ensureSharp()) &&
              allowedMimes.some((m) => m.startsWith("image/")) &&
              finalExt !== ".ico"
            ) {
              processedBuffer = await compressToWebP(file.buffer, { quality });
              finalExt = ".webp";
            }

            const secureFilename = generateSecureFilename(
              file.originalname,
              finalExt,
            );
            file.filename = secureFilename;
            file.size = processedBuffer.length;
            file.destination = destination;

            if (!compress) {
              // The caller has opted out of conversion because it needs to make
              // a per-file decision its own way (members keep PDFs byte-exact
              // but still want photos as WebP). Storing here would write the
              // unconverted original as a public object that the caller then
              // has to delete - two writes plus a delete per upload, and a
              // silently orphaned full-resolution copy whenever the delete
              // fails. Hand over the validated bytes and let it store once.
              file.buffer = processedBuffer;
              file.storagePending = true;
              continue;
            }

            file.path = await persistBuffer(
              processedBuffer,
              secureFilename,
              file.mimetype || "application/octet-stream",
              destination,
            );
            delete file.buffer;
          }
        }

        next();
      } catch (error) {
        console.error("[UPLOAD] Multi-upload error:", error.message);
        return res.status(500).json({
          isOk: false,
          status: 500,
          error: "Processing Error",
          message: "Failed to process uploaded files",
        });
      }
    });
  };
}

// ============ UTILITY EXPORTS ============

export {
  compressToWebP,
  compressToTargetSize,
  validateMagicBytes,
  validateBufferMagicBytes,
  generateSecureFilename,
  ensureUploadDir,
};

export default {
  createSecureImageUpload,
  createSecureDocumentUpload,
  createSecureUpload,
  createSecureMultiUpload,
  createSecureImageOrVideoUpload,
  ALLOWED_MIMES,
  ALLOWED_EXTENSIONS,
  FILE_SIZE_LIMITS,
  DANGEROUS_EXTENSIONS_REGEX,
  classifyMediaBuffer,
  prepareValidatedMedia,
  checkMediaSizeCap,
  isVideoSlotRequest,
};
