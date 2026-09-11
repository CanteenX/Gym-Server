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
import { fileTypeFromFile, fileTypeFromBuffer } from "file-type";

// Lazy load sharp to handle Node version compatibility
// Sharp requires Node.js 18+ - if not available, compression is disabled
let sharp = null;
let sharpAvailable = false;

try {
  sharp = (await import("sharp")).default;
  sharpAvailable = true;
  
} catch (err) {
  console.warn(
    "[UPLOAD] Sharp not available - image compression disabled. Require Node 18+",
    err.message,
  );
  sharpAvailable = false;
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
 */
export const ALLOWED_MIMES = {
  images: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"],
  documents: ["application/pdf"],
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
  all: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".pdf"],
};

/**
 * Default file size limits (in bytes)
 */
export const FILE_SIZE_LIMITS = {
  image: 5 * 1024 * 1024, // 5 MB
  document: 10 * 1024 * 1024, // 10 MB
  default: 5 * 1024 * 1024, // 5 MB
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
  if (!sharpAvailable || !sharp) {
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
  if (!sharpAvailable || !sharp) {
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

  if (useMemory) {
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
        

        if ((compress || convertToWebP) && sharpAvailable) {
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

        // 3. Save to disk with secure filename
        await ensureUploadDir(destination);
        const secureFilename = generateSecureFilename(
          req.file.originalname,
          finalExt,
        );
        const filePath = path.join(destination, secureFilename);

        await fsPromises.writeFile(filePath, processedBuffer);

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
        // Validate magic bytes
        const validation = await validateMagicBytes(
          req.file.path,
          ALLOWED_MIMES.documents,
        );

        if (!validation.valid) {
          // Delete the uploaded file
          try {
            await fsPromises.unlink(req.file.path);
          } catch (unlinkErr) {
            console.error("Failed to delete invalid file:", unlinkErr);
          }

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
        // Validate magic bytes
        const validation = await validateMagicBytes(
          req.file.path,
          allowedMimes,
        );

        if (!validation.valid) {
          try {
            await fsPromises.unlink(req.file.path);
          } catch (unlinkErr) {
            console.error("Failed to delete invalid file:", unlinkErr);
          }

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
        await ensureUploadDir(destination);

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
              sharpAvailable &&
              allowedMimes.some((m) => m.startsWith("image/")) &&
              finalExt !== ".ico"
            ) {
              processedBuffer = await compressToWebP(file.buffer, { quality });
              finalExt = ".webp";
            }

            // Save with secure filename
            const secureFilename = generateSecureFilename(
              file.originalname,
              finalExt,
            );
            const filePath = path.join(destination, secureFilename);
            await fsPromises.writeFile(filePath, processedBuffer);

            // Update file info
            file.filename = secureFilename;
            file.path = filePath;
            file.size = processedBuffer.length;
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
  ALLOWED_MIMES,
  ALLOWED_EXTENSIONS,
  FILE_SIZE_LIMITS,
  DANGEROUS_EXTENSIONS_REGEX,
};
